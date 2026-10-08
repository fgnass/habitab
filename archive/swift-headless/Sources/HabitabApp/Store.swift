import AppKit
import Combine
import Foundation
import HabitabCore

struct ActivityEntry: Identifiable, Hashable {
    let id = UUID()
    var tool: String
    var summary: String?
    var start: Date
    var durationMs: Int?
    var isError = false
    var detail: String?
}

enum SessionPhase: Equatable {
    case connected      // launcher running, no tool active, recent activity
    case toolRunning
    case idle           // launcher running, no MCP activity for a while
    case disconnected   // launcher alive, socket lost (reconnects)
    case ended          // launcher gone
}

@MainActor
final class SessionModel: ObservableObject, Identifiable {
    let id: String
    @Published var meta: SessionMeta
    @Published var launcherIdentity: String?
    @Published var connected = false
    @Published var ended = false
    @Published var endedAt: Date?
    @Published var endReason: String?
    @Published var browserState = "notStarted"
    @Published var browserDetail: String?
    @Published var port: Int?
    @Published var chromePid: Int32?
    @Published var chromeIdentity: String?
    @Published var currentTool: ActivityEntry?
    @Published var lastActivity: Date?
    @Published var activity: [ActivityEntry] = []
    @Published var held = false
    @Published var adopted = false
    @Published var protectedReason: String?
    var lastInteraction: Date?
    weak var connection: LauncherConnection?
    let browser = BrowserController()

    init(id: String, meta: SessionMeta) {
        self.id = id
        self.meta = meta
    }

    var phase: SessionPhase {
        if ended { return .ended }
        if !connected { return .disconnected }
        if currentTool != nil { return .toolRunning }
        let last = lastActivity ?? meta.startedAt ?? .distantPast
        return Date().timeIntervalSince(last) > 120 ? .idle : .connected
    }

    var projectName: String { meta.projectName ?? "No project" }
    var projectPath: String { meta.projectRoot ?? meta.cwd ?? "" }

    var clientLabel: String {
        switch meta.client {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        default: return meta.clientName ?? "Unknown client"
        }
    }

    func send(_ m: IPCMessage) { connection?.send(m) }
}

/// Holds all sessions and applies lifecycle rules.
@MainActor
final class Store: ObservableObject {
    @Published var sessions: [String: SessionModel] = [:]
    @Published var selection: String?
    @Published var search = ""
    @Published var hideBlankTabs = true
    @Published var showEnded = true
    @Published var serverError: String?
    private(set) var alreadyRunning = false
    @Published private(set) var state = ManagerState.load()
    @Published var tick = Date()

    private let server = ManagerServer()
    private var timers: [Timer] = []

    func start() {
        server.onConnect = { [weak self] conn in self?.accept(conn) }
        do { try server.start() } catch {
            if (error as NSError).code == 1 { alreadyRunning = true; return }
            serverError = error.localizedDescription
        }
        restoreAdopted()
        timers.append(Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick = Date(); self?.sendProtection() }
        })
        timers.append(Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reap(); self?.closeStaleAdopted() }
        })
        reap()
    }

    func stop() { server.stop() }

    // MARK: Launcher connections

    private func accept(_ conn: LauncherConnection) {
        var session: SessionModel?
        conn.onMessage = { [weak self] msg in
            guard let self else { return }
            if msg.type == IPCType.hello {
                session = self.hello(msg, conn)
            } else if let s = session {
                self.handle(msg, s, conn)
            }
        }
        conn.onClose = { [weak self] in
            guard let self, let s = session, s.connection === conn else { return }
            self.connectionLost(s)
        }
        conn.start()
    }

    private func hello(_ msg: IPCMessage, _ conn: LauncherConnection) -> SessionModel? {
        guard let id = msg.sessionId, SessionID.isValid(id) else { conn.close(); return nil }
        let s = sessions[id] ?? SessionModel(id: id, meta: msg.meta ?? SessionMeta())
        if let meta = msg.meta { s.meta = meta }
        s.launcherIdentity = msg.launcherIdentity
        s.connection = conn
        s.connected = true
        s.ended = false
        sessions[id] = s
        if selection == nil { selection = id }
        return s
    }

    private func handle(_ msg: IPCMessage, _ s: SessionModel, _ conn: LauncherConnection) {
        switch msg.type {
        case IPCType.meta:
            if let meta = msg.meta { s.meta = meta }
        case IPCType.browser:
            applyBrowser(msg, s)
        case IPCType.toolStart:
            let entry = ActivityEntry(tool: msg.tool ?? "?", summary: msg.summary, start: Date())
            s.currentTool = entry
            s.lastActivity = Date()
        case IPCType.toolEnd:
            var entry = s.currentTool ?? ActivityEntry(tool: msg.tool ?? "?", start: Date())
            entry.durationMs = msg.durationMs
            entry.isError = msg.isError ?? false
            entry.detail = msg.detail
            s.activity.insert(entry, at: 0)
            if s.activity.count > 100 { s.activity.removeLast(s.activity.count - 100) }
            s.currentTool = nil
            s.lastActivity = Date()
            s.protectedReason = msg.protectedReason
            s.browser.agentActivity()
        case IPCType.ending:
            applyBrowser(msg, s)
            let keep = shouldKeep(s) && s.chromePid != nil
            if keep { adopt(s) }
            var reply = IPCMessage(type: IPCType.handoff)
            reply.keep = keep
            conn.send(reply)
        case IPCType.bye:
            s.endReason = msg.reason
            markEnded(s)
        default:
            break
        }
    }

    private func applyBrowser(_ msg: IPCMessage, _ s: SessionModel) {
        s.browserState = msg.browserState ?? s.browserState
        s.browserDetail = msg.detail
        s.chromePid = msg.chromePid
        s.chromeIdentity = msg.chromeIdentity
        s.port = msg.debugPort
        if let port = msg.debugPort, msg.browserState == "running" {
            s.browser.connect(port: port)
        } else {
            s.browser.disconnect()
        }
    }

    private func connectionLost(_ s: SessionModel) {
        s.connected = false
        s.connection = nil
        s.currentTool = nil
        if s.ended { return }
        if let identity = s.launcherIdentity, Proc.isAlive(identity: identity) {
            // Launcher still runs; it reconnects by itself.
            return
        }
        // Launcher crashed (for example SIGKILL): its browser is orphaned now.
        s.endReason = "Launcher exited without signing off"
        if shouldKeep(s), s.chromePid != nil, let id = s.chromeIdentity, Proc.isAlive(identity: id) {
            adopt(s)
        }
        markEnded(s)
        reap()
    }

    private func markEnded(_ s: SessionModel) {
        s.ended = true
        s.endedAt = Date()
        s.connected = false
        s.currentTool = nil
        s.held = false
        if !s.adopted {
            s.browserState = "stopped"
            s.browser.disconnect()
        }
    }

    // MARK: Lifecycle rules

    /// A browser outlives its session only when the user pinned the session
    /// or worked in it during the last five minutes.
    func shouldKeep(_ s: SessionModel) -> Bool {
        if state.pinned.contains(s.id) { return true }
        if let t = s.lastInteraction, Date().timeIntervalSince(t) < 300 { return true }
        return false
    }

    private func adopt(_ s: SessionModel) {
        guard let pid = s.chromePid, let identity = s.chromeIdentity, let port = s.port else { return }
        state.adopted[s.id] = AdoptedBrowser(chromePid: pid, chromeIdentity: identity, port: port, meta: s.meta, since: Date())
        state.save()
        s.adopted = true
    }

    private func restoreAdopted() {
        for (id, b) in state.adopted {
            guard Proc.isAlive(identity: b.chromeIdentity) else {
                state.adopted.removeValue(forKey: id)
                continue
            }
            let s = SessionModel(id: id, meta: b.meta ?? SessionMeta())
            s.ended = true
            s.endedAt = b.since
            s.endReason = "Connection ended; browser kept open"
            s.adopted = true
            s.chromePid = b.chromePid
            s.chromeIdentity = b.chromeIdentity
            s.port = b.port
            s.browserState = "running"
            s.browser.connect(port: b.port)
            sessions[id] = s
        }
        state.save()
    }

    /// A browser kept for manual work closes after 30 minutes without use;
    /// pinned sessions keep theirs until the user closes it.
    private func closeStaleAdopted() {
        for s in sessions.values where s.adopted && !isPinned(s) {
            let since = max(s.lastInteraction ?? .distantPast, state.adopted[s.id]?.since ?? .distantPast)
            if Date().timeIntervalSince(since) > 1800 { stopBrowser(s) }
        }
    }

    private func reap() {
        Task.detached { Reaper.run() }
    }

    /// Tells launchers that a person looks at or works in their browser, so
    /// idle cleanup leaves it alone.
    private func sendProtection() {
        for s in sessions.values where s.connected {
            let viewing = s.id == selection && NSApp.isActive
            let recent = s.lastInteraction.map { Date().timeIntervalSince($0) < 300 } ?? false
            guard viewing || recent else { continue }
            var m = IPCMessage(type: IPCType.protect)
            m.durationMs = 300_000
            m.reason = recent ? "manual" : "viewing"
            s.send(m)
        }
    }

    func noteInteraction(_ s: SessionModel) {
        let first = s.lastInteraction.map { Date().timeIntervalSince($0) > 30 } ?? true
        s.lastInteraction = Date()
        if first {
            var m = IPCMessage(type: IPCType.protect)
            m.durationMs = 300_000
            m.reason = "manual"
            s.send(m)
        }
    }

    // MARK: User actions

    func displayName(_ s: SessionModel) -> String {
        if let n = state.names[s.id], !n.isEmpty { return n }
        if let n = s.meta.agentSessionName, !n.isEmpty { return n }
        if let a = s.meta.agentSessionId { return String(a.prefix(8)) }
        return s.id
    }

    func rename(_ s: SessionModel, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { state.names.removeValue(forKey: s.id) } else { state.names[s.id] = trimmed }
        state.save()
    }

    func isPinned(_ s: SessionModel) -> Bool { state.pinned.contains(s.id) }

    func togglePin(_ s: SessionModel) {
        if state.pinned.contains(s.id) { state.pinned.remove(s.id) } else { state.pinned.insert(s.id) }
        state.save()
        objectWillChange.send()
    }

    func setHold(_ s: SessionModel, _ on: Bool) {
        var m = IPCMessage(type: IPCType.hold)
        m.hold = on
        s.send(m)
        s.held = on
    }

    /// Closes the browser. A live session keeps its profile and starts the
    /// browser again on the next tool call; an ended session is removed.
    func stopBrowser(_ s: SessionModel) {
        if s.connected {
            var m = IPCMessage(type: IPCType.stopBrowser)
            m.reason = "quit in Habitab"
            s.send(m)
            return
        }
        s.browser.disconnect()
        if let identity = s.chromeIdentity, let pid = s.chromePid, Proc.isAlive(identity: identity) {
            Task.detached { Proc.terminate(pid) }
        }
        state.adopted.removeValue(forKey: s.id)
        state.save()
        s.adopted = false
        s.browserState = "stopped"
        reap()
    }

    func remove(_ s: SessionModel) {
        guard !s.connected else { return }
        if s.adopted { stopBrowser(s) }
        sessions.removeValue(forKey: s.id)
        state.names.removeValue(forKey: s.id)
        state.pinned.remove(s.id)
        state.save()
        if selection == s.id { selection = nil }
    }

    func removeAllEnded() {
        for s in sessions.values where s.ended && !s.adopted && !isPinned(s) { remove(s) }
    }

    // MARK: Listing

    struct Group: Identifiable {
        var id: String { name + path }
        var name: String
        var path: String
        var sessions: [SessionModel]
    }

    var groups: [Group] {
        let q = search.lowercased().trimmingCharacters(in: .whitespaces)
        let visible = sessions.values.filter { s in
            if !showEnded && s.ended && !s.adopted && !isPinned(s) { return false }
            guard !q.isEmpty else { return true }
            let hay = [displayName(s), s.id, s.projectName, s.projectPath, s.clientLabel, s.meta.agentSessionId ?? "",
                       s.meta.cwd ?? ""] + s.browser.tabs.flatMap { [$0.title, $0.url] }
            return hay.contains { $0.lowercased().contains(q) }
        }
        let grouped = Dictionary(grouping: visible) { $0.projectPath }
        return grouped.map { path, list in
            Group(name: list.first?.projectName ?? path, path: path, sessions: list.sorted { a, b in
                let pa = isPinned(a), pb = isPinned(b)
                if pa != pb { return pa }
                if a.ended != b.ended { return !a.ended }
                return (a.meta.startedAt ?? .distantPast) > (b.meta.startedAt ?? .distantPast)
            })
        }.sorted { a, b in
            let pa = a.sessions.contains(where: isPinned), pb = b.sessions.contains(where: isPinned)
            if pa != pb { return pa }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    var selected: SessionModel? { selection.flatMap { sessions[$0] } }
}
