import Darwin
import Foundation
import HabitabCore

/// `habitab mcp -- <original command...>`
///
/// Runs the unchanged chrome-devtools-mcp server as a child process and
/// copies MCP messages between client and server. The server receives
/// `--browserUrl` of a local port owned by this launcher; Chrome starts on
/// first use. Commands that Habitab must not manage are executed unchanged.
final class Launcher: @unchecked Sendable {
    let original: [String]
    let command: ServerCommand
    let session = SessionID.make()
    let owner = Proc.selfIdentity()
    var meta: SessionMeta
    let browser: BrowserOwner
    var forwarder: Forwarder!
    var manager: ManagerLink!

    private var childPid: pid_t = 0
    private var childIn: Int32 = -1
    private var childOut: Int32 = -1
    private let stateLock = NSLock()
    private let childInLock = NSLock()

    // MCP activity state
    private var inflight: [String: (tool: String, start: Date, args: [String: Any])] = [:]
    private var serverRootsRequests: Set<String> = []
    private var lastActivity = Date()
    private var tracing = false
    private var screencasting = false
    private var protectedUntil = Date.distantPast
    private var held = false
    private var heldSince = Date.distantPast
    private var heldLines: [Data] = []
    private var shuttingDown = false
    private let idleSeconds: TimeInterval

    init(original: [String], command: ServerCommand) {
        self.original = original
        self.command = command
        self.meta = SessionInfo.collect()
        meta.originalCommand = original
        meta.serverName = ProcessInfo.processInfo.environment["HABITAB_SERVER_NAME"]
        let minutes = Double(ProcessInfo.processInfo.environment["HABITAB_IDLE_MINUTES"] ?? "") ?? 20
        idleSeconds = minutes * 60
        browser = BrowserOwner(session: session, owner: owner, options: command.launch)
    }

    // MARK: Entry

    static func run(_ argv: [String]) -> Never {
        Log.open("launcher")
        guard let first = argv.first else {
            FileHandle.standardError.write("habitab mcp: missing command after --\n".data(using: .utf8)!)
            exit(64)
        }
        let env = ProcessInfo.processInfo.environment
        guard env["HABITAB_DISABLE"] != "1",
              let cmd = ServerCommandParser.parse(command: first, args: Array(argv.dropFirst())) else {
            Log.write("pass-through (disabled or not chrome-devtools-mcp): \(argv.joined(separator: " "))")
            execOriginal(argv)
        }
        guard cmd.mode == .managed else {
            Log.write("pass-through (\(cmd.mode.rawValue): \(cmd.reasons.joined(separator: ", ")))")
            execOriginal(argv)
        }
        Paths.ensureHome()
        let launcher = Launcher(original: argv, command: cmd)
        launcher.start()
    }

    static func execOriginal(_ argv: [String]) -> Never {
        let cargs = argv.map { strdup($0) } + [nil]
        execvp(argv[0], cargs)
        FileHandle.standardError.write("habitab: cannot execute \(argv[0]): \(String(cString: strerror(errno)))\n".data(using: .utf8)!)
        exit(127)
    }

    func start() -> Never {
        signal(SIGPIPE, SIG_IGN)
        let clientVars = ProcessInfo.processInfo.environment.keys.filter { $0.hasPrefix("CLAUDE") || $0.hasPrefix("CODEX") }.sorted()
        Log.write("session \(session) client env vars: \(clientVars) agentSession=\(meta.agentSessionId ?? "-") via \(meta.agentSessionSource ?? "-")")
        Log.write("session \(session) start cwd=\(meta.cwd ?? "?") client=\(meta.client ?? "?") cmd=\(original.joined(separator: " "))")

        // Clean up browsers of earlier crashed launchers in the background.
        Thread.detachNewThread { Reaper.run() }

        browser.onState = { [weak self] state, inst, detail in self?.browserChanged(state, inst, detail) }
        browser.onFirstLaunch = { [weak self] in self?.manager.wakeApp() }
        guard let fwd = Forwarder(target: { [weak self] in
            guard let self else { return nil }
            self.touch()
            return self.browser.ensure()?.port
        }) else {
            Log.write("cannot bind forward port; pass-through")
            Launcher.execOriginal(original)
        }
        forwarder = fwd
        fwd.start()

        manager = ManagerLink(launcher: self)
        manager.start()

        spawnChild()
        installSignals()
        Thread.detachNewThread { [self] in pumpClientToServer() }
        Thread.detachNewThread { [self] in pumpServerToClient() }
        Thread.detachNewThread { [self] in idleLoop() }
        Thread.detachNewThread { [self] in waitChild() }
        dispatchMain()
    }

    // MARK: Child process

    private func spawnChild() {
        let serverArgs = ServerCommandParser.rewrittenServerArgs(
            command.serverArgs, browserURL: "http://127.0.0.1:\(forwarder.port)",
            sanitizedConfig: ServerCommandParser.sanitizedConfig(from: command.serverArgs, into: Paths.tmp))
        let argv = command.runner + serverArgs
        Log.write("child: \(argv.joined(separator: " "))")

        var inPipe: [Int32] = [0, 0]
        var outPipe: [Int32] = [0, 0]
        pipe(&inPipe)
        pipe(&outPipe)
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0)
        posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
        posix_spawn_file_actions_addinherit_np(&actions, 2)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        // Own process group: on shutdown the whole tree (npx -> node) gets the signal.
        posix_spawnattr_setpgroup(&attr, 0)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        let cargs = argv.map { strdup($0) } + [nil]
        var pid: pid_t = 0
        let rc = posix_spawnp(&pid, argv[0], &actions, &attr, cargs, environ)
        cargs.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions)
        posix_spawnattr_destroy(&attr)
        close(inPipe[0])
        close(outPipe[1])
        guard rc == 0 else {
            FileHandle.standardError.write("habitab: cannot start \(argv[0]): \(String(cString: strerror(rc)))\n".data(using: .utf8)!)
            exit(127)
        }
        childPid = pid
        childIn = inPipe[1]
        childOut = outPipe[0]
        _ = fcntl(childIn, F_SETFD, FD_CLOEXEC)
        _ = fcntl(childOut, F_SETFD, FD_CLOEXEC)
    }

    private func waitChild() {
        var status: Int32 = 0
        while waitpid(childPid, &status, 0) < 0 && errno == EINTR {}
        let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        Log.write("child exited code=\(code)")
        // Give the stdout pump a moment to forward the last messages.
        usleep(200_000)
        shutdown(reason: "server exited", exitCode: code)
    }

    private func installSignals() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { [weak self] in self?.shutdown(reason: "signal \(sig)", exitCode: 128 + sig) }
            source.resume()
            signalSources.append(source)
        }
    }
    private var signalSources: [DispatchSourceSignal] = []

    // MARK: Message pumps

    private func pumpClientToServer() {
        readLines(fd: 0) { [self] line in
            if !inspectClientMessage(line) { writeToChild(line) }
        }
        Log.write("stdin EOF")
        childInLock.lock()
        close(childIn)
        childIn = -1
        childInLock.unlock()
        // chrome-devtools-mcp exits on stdin EOF; signal it if it does not.
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [self] in
            shutdown(reason: "client closed stdin", exitCode: 0)
        }
    }

    private func pumpServerToClient() {
        readLines(fd: childOut) { line in
            self.inspectServerMessage(line)
            writeAll(1, line)
        }
    }

    private func writeToChild(_ line: Data) {
        childInLock.lock(); defer { childInLock.unlock() }
        if childIn >= 0 { writeAll(childIn, line) }
    }

    /// Calls `handler` with each newline-terminated chunk (newline included).
    private func readLines(fd: Int32, handler: (Data) -> Void) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 262_144)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex...nl]
                handler(Data(line))
                buffer.removeSubrange(buffer.startIndex...nl)
            }
        }
        if !buffer.isEmpty { handler(buffer) }
    }

    static func idKey(_ value: Any?) -> String? {
        if let n = value as? NSNumber { return "n:\(n)" }
        if let s = value as? String { return "s:\(s)" }
        return nil
    }

    private func messages(_ line: Data) -> [[String: Any]] {
        guard let obj = try? JSONSerialization.jsonObject(with: line) else { return [] }
        if let dict = obj as? [String: Any] { return [dict] }
        return (obj as? [[String: Any]]) ?? []
    }

    /// Returns true if the line was held back (human has control).
    private func inspectClientMessage(_ line: Data) -> Bool {
        var holdThis = false
        for msg in messages(line) {
            if let method = msg["method"] as? String {
                let params = msg["params"] as? [String: Any] ?? [:]
                switch method {
                case "initialize":
                    let info = params["clientInfo"] as? [String: Any]
                    stateLock.lock()
                    meta.clientName = info?["name"] as? String
                    meta.clientVersion = info?["version"] as? String
                    if let name = meta.clientName?.lowercased() {
                        if name.contains("claude") { meta.client = "claude"; meta.clientSource = "clientInfo" }
                        else if name.contains("codex") { meta.client = "codex"; meta.clientSource = "clientInfo" }
                    }
                    stateLock.unlock()
                    Log.write("initialize clientInfo=\(info ?? [:]) capabilities=\(params["capabilities"] ?? [:])")
                    manager.sendMeta()
                case "tools/call":
                    let tool = params["name"] as? String ?? "?"
                    let args = params["arguments"] as? [String: Any] ?? [:]
                    if let m = params["_meta"] as? [String: Any] { applyCallMeta(m) }
                    refreshClaudeSession()
                    if let key = Launcher.idKey(msg["id"]) {
                        stateLock.lock()
                        inflight[key] = (tool, Date(), args)
                        lastActivity = Date()
                        if held && !holdThis { heldLines.append(line); holdThis = true }
                        stateLock.unlock()
                        var m = IPCMessage(type: IPCType.toolStart)
                        m.tool = tool
                        m.callId = key
                        m.summary = Launcher.summarize(tool: tool, args: args)
                        manager.send(m)
                    }
                default: break
                }
            } else if let key = Launcher.idKey(msg["id"]) {
                // Response from the client to a server request (roots/list).
                stateLock.lock()
                let isRoots = serverRootsRequests.remove(key) != nil
                stateLock.unlock()
                if isRoots, let result = msg["result"] as? [String: Any], let roots = result["roots"] as? [[String: Any]] {
                    let uris = roots.compactMap { $0["uri"] as? String }
                    stateLock.lock(); meta.roots = uris; stateLock.unlock()
                    Log.write("roots: \(uris)")
                    manager.sendMeta()
                }
            }
        }
        return holdThis
    }

    /// Codex sends `_meta.threadId` (and `sessionId`) with each tool call.
    private func applyCallMeta(_ m: [String: Any]) {
        guard let thread = (m["threadId"] as? String) ?? (m["sessionId"] as? String) else { return }
        stateLock.lock()
        let changed = meta.agentSessionId != thread
        if changed {
            meta.agentSessionId = thread
            meta.agentSessionName = nil
            meta.agentSessionSource = m["threadId"] != nil ? "mcp-meta-threadId" : "mcp-meta-sessionId"
        }
        stateLock.unlock()
        if changed {
            if let name = SessionInfo.codexThreadName(thread) {
                stateLock.lock(); meta.agentSessionName = name; stateLock.unlock()
            }
            manager.sendMeta()
        }
    }

    private var lastClaudeCheck = Date()

    /// After /clear Claude Code continues with a new session id while the
    /// MCP server keeps running. Its process file shows the current id.
    private func refreshClaudeSession() {
        stateLock.lock()
        guard meta.client == "claude", let pid = meta.clientPid, Date().timeIntervalSince(lastClaudeCheck) > 30 else {
            stateLock.unlock(); return
        }
        lastClaudeCheck = Date()
        var updated = meta
        stateLock.unlock()
        let before = updated.agentSessionId
        SessionInfo.applyClaudeSessionFile(pid: pid, to: &updated, allowOverride: true)
        guard updated.agentSessionId != before else { return }
        stateLock.lock(); meta.agentSessionId = updated.agentSessionId; meta.agentSessionSource = updated.agentSessionSource
        meta.agentSessionName = updated.agentSessionName; stateLock.unlock()
        manager.sendMeta()
    }

    private func inspectServerMessage(_ line: Data) {
        for msg in messages(line) {
            if let method = msg["method"] as? String {
                if method == "roots/list", let key = Launcher.idKey(msg["id"]) {
                    stateLock.lock(); serverRootsRequests.insert(key); stateLock.unlock()
                }
                continue
            }
            guard let key = Launcher.idKey(msg["id"]) else { continue }
            stateLock.lock()
            let call = inflight.removeValue(forKey: key)
            stateLock.unlock()
            guard let call else { continue }
            let result = msg["result"] as? [String: Any]
            let failed = msg["error"] != nil || (result?["isError"] as? Bool ?? false)
            stateLock.lock()
            lastActivity = Date()
            if !failed {
                switch call.tool {
                case "performance_start_trace": tracing = !(call.args["autoStop"] as? Bool ?? false)
                case "performance_stop_trace": tracing = false
                case "screencast_start": screencasting = true
                case "screencast_stop": screencasting = false
                default: break
                }
            }
            stateLock.unlock()
            var m = IPCMessage(type: IPCType.toolEnd)
            m.tool = call.tool
            m.callId = key
            m.isError = failed
            m.durationMs = Int(Date().timeIntervalSince(call.start) * 1000)
            if failed, let content = result?["content"] as? [[String: Any]], let text = content.first?["text"] as? String {
                m.detail = String(text.prefix(300))
            } else if let error = msg["error"] as? [String: Any] {
                m.detail = error["message"] as? String
            }
            m.protectedReason = protectionReason()
            manager.send(m)
        }
    }

    static func summarize(tool: String, args: [String: Any]) -> String? {
        for key in ["url", "uid", "key", "text", "function", "filePath"] {
            if let v = args[key] as? String { return String(v.prefix(120)) }
        }
        if let v = args["pageId"] { return "page \(v)" }
        return nil
    }

    // MARK: State shared with the manager

    func snapshotMeta() -> SessionMeta {
        stateLock.lock(); defer { stateLock.unlock() }
        return meta
    }

    func touch() {
        stateLock.lock(); lastActivity = Date(); stateLock.unlock()
    }

    func protect(for seconds: TimeInterval) {
        stateLock.lock(); protectedUntil = Date().addingTimeInterval(seconds); stateLock.unlock()
    }

    func setHold(_ on: Bool) {
        stateLock.lock()
        held = on
        if on { heldSince = Date() }
        let release = on ? [] : heldLines
        if !on { heldLines = [] }
        stateLock.unlock()
        Log.write("hold=\(on) released=\(release.count)")
        release.forEach(writeToChild)
    }

    func protectionReason() -> String? {
        stateLock.lock(); defer { stateLock.unlock() }
        if tracing { return "Performance trace running" }
        if screencasting { return "Screencast running" }
        if Date() < protectedUntil { return "Manual use" }
        if !inflight.isEmpty { return "Tool running" }
        return nil
    }

    private func browserChanged(_ state: String, _ inst: Chrome.Instance?, _ detail: String?) {
        var m = IPCMessage(type: IPCType.browser)
        m.browserState = state
        m.chromePid = inst?.pid
        m.chromeIdentity = inst?.identity
        m.debugPort = inst?.port
        m.detail = detail
        manager?.send(m)
    }

    func currentBrowserMessage() -> IPCMessage {
        var m = IPCMessage(type: IPCType.browser)
        if let inst = browser.current {
            m.browserState = "running"
            m.chromePid = inst.pid
            m.chromeIdentity = inst.identity
            m.debugPort = inst.port
        } else {
            m.browserState = FileManager.default.fileExists(atPath: Paths.profileDir(session: session).path) ? "resting" : "notStarted"
        }
        return m
    }

    /// Lets an idle browser rest: Chrome closes, the profile stays, and the
    /// next tool call starts it again with the same cookies and storage.
    private func idleLoop() {
        guard idleSeconds > 0 else { return }
        while true {
            sleep(30)
            stateLock.lock()
            let idleFor = Date().timeIntervalSince(lastActivity)
            if held && Date().timeIntervalSince(heldSince) > 600 {
                stateLock.unlock()
                setHold(false)
                continue
            }
            stateLock.unlock()
            guard browser.current != nil, idleFor > idleSeconds, protectionReason() == nil else { continue }
            browser.stop(removeProfile: false, reason: "idle for \(Int(idleFor / 60)) min")
        }
    }

    // MARK: Shutdown

    func shutdown(reason: String, exitCode: Int32) {
        stateLock.lock()
        if shuttingDown { stateLock.unlock(); return }
        shuttingDown = true
        stateLock.unlock()
        Log.write("shutdown: \(reason)")

        if Proc.isAlive(pid: childPid) {
            kill(-childPid, SIGTERM)
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline && kill(-childPid, 0) == 0 { usleep(50_000) }
            if kill(-childPid, 0) == 0 { kill(-childPid, SIGKILL) }
        }

        // Ask the manager whether it keeps the browser (pinned or in use).
        let keep = browser.current != nil && manager.askKeep(timeout: 1.5)
        if keep {
            Log.write("browser handed over to manager")
        } else {
            browser.stop(removeProfile: true, reason: reason)
        }
        var bye = IPCMessage(type: IPCType.bye)
        bye.reason = reason
        bye.keep = keep
        manager.send(bye)
        manager.close()
        exit(exitCode)
    }
}
