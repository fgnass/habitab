import Foundation

/// File system locations used by all Habitab components.
///
/// `HABITAB_HOME` and `HABITAB_SOCKET` override the defaults. Tests use them to
/// run a complete, separate instance next to a real installation.
public enum Paths {
    public static let bundleIdentifier = "dev.habitab.Habitab"

    public static var home: URL {
        if let custom = ProcessInfo.processInfo.environment["HABITAB_HOME"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Habitab", isDirectory: true)
    }

    /// Unix domain socket of the manager app. Paths for AF_UNIX are limited to
    /// 104 bytes on macOS, so an override must stay short.
    public static var socket: URL {
        if let custom = ProcessInfo.processInfo.environment["HABITAB_SOCKET"], !custom.isEmpty {
            return URL(fileURLWithPath: custom)
        }
        return home.appendingPathComponent("habitab.sock")
    }

    public static var profiles: URL { home.appendingPathComponent("profiles", isDirectory: true) }
    public static var bin: URL { home.appendingPathComponent("bin", isDirectory: true) }
    public static var launcher: URL { bin.appendingPathComponent("habitab") }
    public static var backups: URL { home.appendingPathComponent("backups", isDirectory: true) }
    public static var logs: URL { home.appendingPathComponent("logs", isDirectory: true) }
    public static var state: URL { home.appendingPathComponent("state.json") }
    public static var appPathFile: URL { home.appendingPathComponent("app-path") }
    public static var installLog: URL { home.appendingPathComponent("install-log.jsonl") }
    public static var tmp: URL { home.appendingPathComponent("tmp", isDirectory: true) }

    /// Creates the support directory with owner-only permissions.
    public static func ensureHome() {
        let fm = FileManager.default
        for dir in [home, profiles, bin, backups, logs, tmp] {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        }
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: home.path)
    }

    public static func profileDir(session: String) -> URL {
        profiles.appendingPathComponent(session, isDirectory: true)
    }

    /// True if `url` is inside Habitab's profile root. Cleanup code only
    /// deletes directories that pass this check.
    public static func isOwnedProfile(_ url: URL) -> Bool {
        let root = profiles.standardizedFileURL.path + "/"
        let path = url.standardizedFileURL.path
        return path.hasPrefix(root) && path.count > root.count
    }
}

public enum Log {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handle: FileHandle?
    nonisolated(unsafe) public static var component = "habitab"
    nonisolated(unsafe) public static var alsoStderr = false

    public static func open(_ name: String) {
        component = name
        Paths.ensureHome()
        let url = Paths.logs.appendingPathComponent("\(name).log")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil,
                                           attributes: [.posixPermissions: 0o600])
        }
        // Keep log files small; one old generation is enough for debugging.
        if let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int,
           size > 5_000_000 {
            let old = url.appendingPathExtension("1")
            try? FileManager.default.removeItem(at: old)
            try? FileManager.default.moveItem(at: url, to: old)
            FileManager.default.createFile(atPath: url.path, contents: nil,
                                           attributes: [.posixPermissions: 0o600])
        }
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }

    public static func write(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) [\(component):\(getpid())] \(message)\n"
        lock.lock(); defer { lock.unlock() }
        if let data = line.data(using: .utf8) {
            handle?.write(data)
            if alsoStderr { FileHandle.standardError.write(data) }
        }
    }
}
