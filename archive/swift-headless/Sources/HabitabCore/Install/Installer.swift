import Darwin
import Foundation

/// Entry point for setup and removal. Used by the CLI and the app.
public enum Installer {
    public static func scan() -> [Finding] {
        ClaudeAdapter.scan() + CodexAdapter.scan()
    }

    /// Copies the launcher binary to a stable location. Client configurations
    /// point there, so moving or deleting the app does not break agents: the
    /// launcher runs the original command when the app is missing.
    @discardableResult
    public static func installLauncher(from source: String) throws -> String {
        Paths.ensureHome()
        let dest = Paths.launcher
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path),
           fm.contentsEqual(atPath: dest.path, andPath: source) { return dest.path }
        let tmp = Paths.bin.appendingPathComponent(".habitab.new")
        try? fm.removeItem(at: tmp)
        try fm.copyItem(atPath: source, toPath: tmp.path)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tmp.path)
        // rename() is atomic; running launchers keep their old inode.
        guard rename(tmp.path, dest.path) == 0 else { throw InstallError.message("Could not install the launcher") }
        return dest.path
    }

    static func backup(_ file: String, into dir: URL) -> String? {
        guard FileManager.default.fileExists(atPath: file) else { return nil }
        let name = file.replacingOccurrences(of: "/", with: "_")
        let dest = dir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: dest.path) { return dest.path }
        do {
            try FileManager.default.copyItem(atPath: file, toPath: dest.path)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dest.path)
            return dest.path
        } catch { return nil }
    }

    static func newBackupDir() -> URL {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let dir = Paths.backups.appendingPathComponent(stamp, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir
    }

    /// Applies the given findings. Each file is backed up once before its
    /// first change. Results are per finding; one failure does not stop others.
    public static func apply(_ findings: [Finding]) -> [ChangeResult] {
        Paths.ensureHome()
        var manifest = Manifest.load()
        let dir = newBackupDir()
        var results: [ChangeResult] = []
        for f in findings where f.isActionable {
            let backupFile = f.client == .claude ? ClaudeAdapter.configFile.path : f.file
            let backup = backup(backupFile, into: dir)
            do {
                var entry: ManifestEntry
                switch f.client {
                case .claude: entry = try ClaudeAdapter.apply(f, backup: backup)
                case .codex: entry = try CodexAdapter.apply(f, backup: backup)
                }
                if f.shadow {
                    // The override lives in local scope of ~/.claude.json.
                    entry.findingId = Classifier.id(.claude, "local", ClaudeAdapter.configFile.path, f.project, f.name)
                }
                manifest.entries.append(entry)
                manifest.save()
                let how = f.shadow ? "Local override created; .mcp.json stays unchanged." : "Migrated."
                results.append(ChangeResult(finding: f, ok: true, message: how))
                Log.write("install: applied \(f.id)")
            } catch {
                results.append(ChangeResult(finding: f, ok: false, message: "\(error)"))
                Log.write("install: failed \(f.id): \(error)")
            }
        }
        if (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.isEmpty ?? true {
            try? FileManager.default.removeItem(at: dir)
        }
        return results
    }

    /// Removes Habitab from every configuration where it is found. Entries
    /// that the user changed afterwards are unwrapped, not overwritten with
    /// an old backup.
    public static func uninstall(_ only: [Finding]? = nil) -> [ChangeResult] {
        let manifest = Manifest.load()
        let wrapped = (only ?? scan()).filter { ($0.status == .migrated || $0.status == .updatePath) && $0.scope != "plugin" && $0.scope != "managed" }
        var results: [ChangeResult] = []
        let dir = newBackupDir()
        for f in wrapped {
            let backupFile = f.client == .claude ? ClaudeAdapter.configFile.path : f.file
            _ = backup(backupFile, into: dir)
            do {
                let message: String
                switch f.client {
                case .claude: message = try ClaudeAdapter.restore(f, manifest: manifest.latest(for: f.id))
                case .codex: message = try CodexAdapter.restore(f, manifest: manifest.latest(for: f.id))
                }
                results.append(ChangeResult(finding: f, ok: true, message: message))
                Log.write("uninstall: \(f.id): \(message)")
            } catch {
                results.append(ChangeResult(finding: f, ok: false, message: "\(error)"))
            }
        }
        if (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.isEmpty ?? true {
            try? FileManager.default.removeItem(at: dir)
        }
        return results
    }

    // MARK: Running processes

    public struct LegacyServer: Sendable, Hashable {
        public var pid: Int32
        public var client: String
        public var clientPid: Int32?
        public var cwd: String?
    }

    /// chrome-devtools-mcp servers that run without Habitab although they
    /// could be managed. Their sessions use the old configuration until the
    /// client restarts the server.
    public static func legacyServers() -> [LegacyServer] {
        var result: [LegacyServer] = []
        for pid in Proc.allPIDs() {
            guard let tokens = serverTokens(pid), let idx = tokens.firstIndex(where: ServerCommandParser.isServerToken) else { continue }
            let parsed = ServerCommandParser.analyze(argv: tokens, serverIndex: idx)
            guard parsed.mode == .managed else { continue }
            let chain = Proc.ancestry(of: pid)
            if chain.contains(where: { $0.matches("habitab") }) { continue }
            // Report the topmost process of an npx/npm/node chain only.
            if let parent = chain.first, serverTokens(parent.pid)?.contains(where: ServerCommandParser.isServerToken) == true { continue }
            let client = chain.first { $0.matches("claude", "codex") || $0.command.hasPrefix("codex") }
            result.append(LegacyServer(pid: pid, client: client?.command ?? "unknown", clientPid: client?.pid, cwd: Proc.cwd(pid)))
        }
        return result
    }

    /// argv of a process. npm rewrites its title into argv[0] as one string
    /// ("npm exec chrome-devtools-mcp@latest --isolated"); split it again.
    static func serverTokens(_ pid: Int32) -> [String]? {
        guard let args = Proc.arguments(pid), !args.isEmpty else { return nil }
        if args[0].contains(" ") {
            return args.joined(separator: " ").split(whereSeparator: \.isWhitespace).map(String.init)
        }
        return args
    }

    public struct LegacyBrowser: Sendable, Hashable, Identifiable {
        public var id: Int32 { pid }
        public var pid: Int32
        public var startMicros: UInt64
        public var profile: String
        public var orphaned: Bool
    }

    /// Chrome instances that chrome-devtools-mcp started itself
    /// (Puppeteer temp profile or chrome-devtools-mcp cache profile).
    /// Habitab never ends them on its own; the user can do it after review.
    public static func legacyBrowsers() -> [LegacyBrowser] {
        var result: [LegacyBrowser] = []
        for pid in Proc.allPIDs() {
            guard let info = Proc.info(pid), info.name == "Google Chrome" || info.name.hasPrefix("Google Chrome") || info.name == "Chromium",
                  let args = Proc.arguments(pid), !args.contains(where: { $0.hasPrefix("--type=") }),
                  !args.contains(where: { $0.hasPrefix(Chrome.sessionFlag) }),
                  let dataDir = args.first(where: { $0.hasPrefix("--user-data-dir=") })?.dropFirst("--user-data-dir=".count)
            else { continue }
            let dir = String(dataDir)
            let isPuppeteer = dir.contains("puppeteer_dev_chrome_profile-") || dir.contains("/.cache/chrome-devtools-mcp/")
            guard isPuppeteer, args.contains("--remote-debugging-pipe") || args.contains("--enable-automation") else { continue }
            result.append(LegacyBrowser(pid: pid, startMicros: info.startMicros, profile: dir, orphaned: info.ppid == 1))
        }
        return result
    }

    /// Ends a legacy browser after explicit confirmation. Re-checks identity.
    public static func endLegacyBrowser(_ b: LegacyBrowser) -> Bool {
        guard Proc.isAlive(pid: b.pid, startMicros: b.startMicros),
              let args = Proc.arguments(b.pid), args.contains("--user-data-dir=\(b.profile)") else { return false }
        return Proc.terminate(b.pid)
    }
}
