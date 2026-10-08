import Darwin
import Foundation

/// Starts and identifies Habitab-owned Chrome instances.
///
/// Ownership markers are command line flags that Chrome ignores:
/// `--habitab-session=<id>` and `--habitab-owner=<pid>:<startMicros>`.
/// Cleanup code only touches browser processes that carry them and whose
/// `--user-data-dir` lies inside `Paths.profiles`.
public enum Chrome {
    public static let sessionFlag = "--habitab-session="
    public static let ownerFlag = "--habitab-owner="

    public struct Instance: Sendable {
        public var pid: Int32
        public var port: Int
        public var browserPath: String
        public var identity: String
        public var profile: URL
        public var webSocketURL: String { "ws://127.0.0.1:\(port)\(browserPath)" }
        public var httpURL: String { "http://127.0.0.1:\(port)" }
    }

    public enum LaunchError: Error, CustomStringConvertible {
        case executableNotFound(String)
        case spawnFailed(Int32)
        case exited(Int32)
        case timeout

        public var description: String {
            switch self {
            case .executableNotFound(let s): return "Chrome not found: \(s)"
            case .spawnFailed(let e): return "Chrome launch failed (errno \(e))"
            case .exited(let pid): return "Chrome (pid \(pid)) exited right after launch"
            case .timeout: return "Chrome did not report a DevTools port"
            }
        }
    }

    static let channelApps: [String: String] = [
        "stable": "Google Chrome", "beta": "Google Chrome Beta",
        "dev": "Google Chrome Dev", "canary": "Google Chrome Canary",
    ]

    public static func executable(for options: LaunchOptions) throws -> String {
        if let path = options.executablePath, !path.isEmpty {
            let expanded = (path as NSString).expandingTildeInPath
            guard FileManager.default.isExecutableFile(atPath: expanded) else { throw LaunchError.executableNotFound(expanded) }
            return expanded
        }
        let channel = options.channel ?? "stable"
        let app = channelApps[channel] ?? "Google Chrome"
        let candidates = ["/Applications", NSHomeDirectory() + "/Applications"].map {
            "\($0)/\(app).app/Contents/MacOS/\(app)"
        }
        guard let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw LaunchError.executableNotFound(candidates[0])
        }
        return found
    }

    /// Default arguments. They follow Puppeteer's defaults so that pages behave
    /// as before; scrollbars stay visible because a person looks at the page.
    static func defaultArgs() -> [String] {
        [
            "--allow-pre-commit-input",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-breakpad",
            "--disable-client-side-phishing-detection",
            "--disable-component-extensions-with-background-pages",
            "--disable-crash-reporter",
            "--disable-default-apps",
            "--disable-dev-shm-usage",
            "--disable-hang-monitor",
            "--disable-infobars",
            "--disable-ipc-flooding-protection",
            "--disable-popup-blocking",
            "--disable-prompt-on-repost",
            "--disable-renderer-backgrounding",
            "--disable-search-engine-choice-screen",
            "--disable-sync",
            "--enable-automation",
            "--export-tagged-pdf",
            "--force-color-profile=srgb",
            "--generate-pdf-document-outline",
            "--metrics-recording-only",
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic",
            "--use-mock-keychain",
            "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,WebUIOmniboxPopup,WebUIOmniboxAimPopup,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
            "--enable-features=PdfOopif",
            "--disable-extensions",
            "--hide-crash-restore-bubble",
            "--headless=new",
            "--mute-audio",
            "--screen-info={3840x2160}",
        ]
    }

    public static func arguments(session: String, profile: URL, options: LaunchOptions, owner: String) -> [String] {
        let ignored = Set(options.ignoreDefaultChromeArgs)
        var args = defaultArgs().filter { arg in
            !ignored.contains(arg) && !ignored.contains(String(arg.split(separator: "=").first ?? ""))
        }
        args += [
            "--user-data-dir=\(profile.path)",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--window-size=\(windowSize(options.viewport))",
        ]
        if let proxy = options.proxyServer, !proxy.isEmpty { args.append("--proxy-server=\(proxy)") }
        if options.acceptInsecureCerts { args.append("--ignore-certificate-errors") }
        args += options.chromeArgs
        args += [sessionFlag + session, ownerFlag + owner, "about:blank"]
        return args
    }

    /// Headless Chrome reserves 87 px of the window height for its virtual
    /// browser UI (measured with Chrome 154), so the window is made taller to
    /// reach the requested content size.
    static func windowSize(_ viewport: String?) -> String {
        let parts = (viewport ?? "1280x800").lowercased().split(separator: "x").compactMap { Int($0) }
        guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { return "1280,800" }
        return "\(parts[0]),\(parts[1] + (viewport == nil ? 0 : 87))"
    }

    /// Starts Chrome in its own session (setsid). It does not get the
    /// launcher's stdio and survives launcher crashes; the reaper cleans it up.
    public static func launch(session: String, options: LaunchOptions, owner: String) throws -> Instance {
        let exe = try executable(for: options)
        let profile = Paths.profileDir(session: session)
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let portFile = profile.appendingPathComponent("DevToolsActivePort")
        try? FileManager.default.removeItem(at: portFile)
        let args = arguments(session: session, profile: profile, options: options, owner: owner)
        let logURL = Paths.logs.appendingPathComponent("chrome-\(session).log")

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, logURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        defer {
            posix_spawnattr_destroy(&attr)
            posix_spawn_file_actions_destroy(&actions)
        }
        let argv = ([exe] + args).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        // Chrome must not inherit variables that point it at another profile or display.
        var env = ProcessInfo.processInfo.environment
        for key in env.keys where key.hasPrefix("CHROME_") || key.hasPrefix("GOOGLE_") { env.removeValue(forKey: key) }
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { envp.forEach { free($0) } }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, &actions, &attr, argv, envp)
        guard rc == 0 else { throw LaunchError.spawnFailed(rc) }
        Log.write("chrome started pid=\(pid) session=\(session)")

        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let (port, path) = readPortFile(portFile) {
                let identity = Proc.info(pid)?.identity ?? "\(pid):0"
                return Instance(pid: pid, port: port, browserPath: path, identity: identity, profile: profile)
            }
            var status: Int32 = 0
            if waitpid(pid, &status, WNOHANG) == pid { throw LaunchError.exited(pid) }
            usleep(50_000)
        }
        Proc.terminate(pid)
        throw LaunchError.timeout
    }

    public static func readPortFile(_ url: URL) -> (Int, String)? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        guard lines.count >= 2, let port = Int(lines[0]), port > 0, port < 65536 else { return nil }
        return (port, lines[1])
    }

    /// A running Habitab-owned browser process found by scanning the process list.
    public struct Found: Sendable, Hashable {
        public var pid: Int32
        public var session: String
        public var owner: String
        public var profile: String?
        public var startMicros: UInt64
    }

    /// All main browser processes that carry Habitab markers. Helper processes
    /// (`--type=...`) are skipped; they exit with their browser.
    public static func findOwned() -> [Found] {
        var found: [Found] = []
        for pid in Proc.allPIDs() {
            guard let info = Proc.info(pid) else { continue }
            guard let args = Proc.arguments(pid), args.contains(where: { $0.hasPrefix(sessionFlag) }) else { continue }
            if args.contains(where: { $0.hasPrefix("--type=") }) { continue }
            let session = args.first { $0.hasPrefix(sessionFlag) }.map { String($0.dropFirst(sessionFlag.count)) } ?? ""
            let owner = args.first { $0.hasPrefix(ownerFlag) }.map { String($0.dropFirst(ownerFlag.count)) } ?? ""
            let profile = args.first { $0.hasPrefix("--user-data-dir=") }.map { String($0.dropFirst("--user-data-dir=".count)) }
            found.append(Found(pid: pid, session: session, owner: owner, profile: profile, startMicros: info.startMicros))
        }
        return found
    }
}
