import Foundation

/// Collects session metadata from sources that the clients actually provide.
/// Each value records its source; nothing is guessed.
public enum SessionInfo {
    public static func collect(launcherPid: Int32 = getpid()) -> SessionMeta {
        var meta = SessionMeta()
        meta.startedAt = Date()
        let cwd = FileManager.default.currentDirectoryPath
        meta.cwd = cwd
        let env = ProcessInfo.processInfo.environment
        // Claude Code sets CLAUDE_PROJECT_DIR for MCP servers (measured with 2.1.292).
        let root = env["CLAUDE_PROJECT_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? projectRoot(for: cwd)
        meta.projectRoot = root
        meta.projectName = (root ?? cwd).split(separator: "/").last.map(String.init) ?? cwd

        let chain = Proc.ancestry(of: launcherPid)
        meta.ancestry = chain.map { "\($0.pid) \($0.command)" }
        for p in chain {
            let name = p.command.lowercased()
            let args = Proc.arguments(p.pid) ?? []
            if p.matches("claude") || args.contains(where: { $0.contains("@anthropic-ai/claude-code") }) {
                meta.client = "claude"; meta.clientPid = p.pid; meta.clientSource = "process"
                break
            }
            if name == "codex" || name.hasPrefix("codex-") {
                meta.client = "codex"; meta.clientPid = p.pid; meta.clientSource = "process"
                break
            }
        }

        if let id = env["CLAUDE_SESSION_ID"] ?? env["CLAUDE_CODE_SESSION_ID"], !id.isEmpty {
            meta.agentSessionId = id
            meta.agentSessionSource = "env"
            if meta.client == nil { meta.client = "claude"; meta.clientSource = "env" }
        }
        if meta.client == "claude", let pid = meta.clientPid {
            applyClaudeSessionFile(pid: pid, to: &meta)
        }
        return meta
    }

    /// Nearest parent directory with a `.git` entry.
    public static func projectRoot(for path: String) -> String? {
        var url = URL(fileURLWithPath: path).standardizedFileURL
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        while url.path != "/" && url.path != home {
            if FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path) { return url.path }
            url.deleteLastPathComponent()
        }
        return nil
    }

    static var claudeConfigDir: URL {
        if let dir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }

    static var codexHome: URL {
        if let dir = ProcessInfo.processInfo.environment["CODEX_HOME"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
    }

    /// Claude Code writes `~/.claude/sessions/<pid>.json` for each running
    /// process. The format is internal, so this source is best effort and
    /// labeled as such.
    public static func applyClaudeSessionFile(pid: Int32, to meta: inout SessionMeta, allowOverride: Bool = false) {
        let url = claudeConfigDir.appendingPathComponent("sessions/\(pid).json")
        guard let data = FileManager.default.contents(atPath: url.path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let id = json["sessionId"] as? String, id != meta.agentSessionId,
           meta.agentSessionId == nil || meta.agentSessionSource != "env" || allowOverride {
            meta.agentSessionId = id
            meta.agentSessionSource = "claude-sessions-file"
        }
        if let name = json["name"] as? String, !name.isEmpty { meta.agentSessionName = name }
    }

    /// Codex sends `_meta.threadId` with every tools/call. The thread title
    /// comes from Codex's session index if it has one.
    public static func codexThreadName(_ threadId: String) -> String? {
        let url = codexHome.appendingPathComponent("session_index.jsonl")
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        // The newest entries are at the end; read at most the last 512 KB.
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 512_000 ? size - 512_000 : 0)
        guard let data = try? handle.readToEnd(), let text = String(data: data, encoding: .utf8) else { return nil }
        var name: String?
        for line in text.split(separator: "\n") where line.contains(threadId) {
            if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
               obj["id"] as? String == threadId, let n = obj["thread_name"] as? String {
                name = n
            }
        }
        return name
    }
}
