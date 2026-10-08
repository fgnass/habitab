import Foundation

public enum ClientKind: String, Codable, Sendable, CaseIterable {
    case claude, codex
    public var label: String { self == .claude ? "Claude Code" : "Codex" }
}

/// One chrome-devtools-mcp server definition found in a client configuration.
public struct Finding: Codable, Sendable, Identifiable, Hashable {
    public enum Status: String, Codable, Sendable {
        /// Can be wrapped; this is the proposed change.
        case migrate
        /// Already wrapped, but the launcher path is outdated.
        case updatePath
        /// Already wrapped. Nothing to do.
        case migrated
        /// Connects to a browser that someone else runs. Never taken over.
        case external
        /// Uses a persistent profile directory. Not taken over by default.
        case persistentProfile
        /// Found, but Habitab cannot change this kind of definition.
        case unsupported
    }

    public var id: String
    public var client: ClientKind
    /// user, local, project, profile, plugin, managed
    public var scope: String
    public var file: String
    public var project: String?
    public var name: String
    public var command: String
    public var args: [String]
    public var status: Status
    public var detail: String
    public var proposedCommand: String?
    public var proposedArgs: [String]?
    /// For a Claude `.mcp.json` entry: the change is a local-scope override
    /// with the same name; the shared project file stays unchanged.
    public var shadow: Bool = false
    /// Raw entry for Claude JSON entries (serialized JSON object).
    public var rawJSON: String?

    public var isActionable: Bool { status == .migrate || status == .updatePath }

    public var location: String {
        switch scope {
        case "user": return "User (\(file))"
        case "local": return "Local for \(project ?? "?")"
        case "project": return "Project \(project ?? file)"
        case "profile": return "Profile \(file)"
        default: return "\(scope): \(file)"
        }
    }

    public var commandLine: String { ([command] + args).map(shellQuote).joined(separator: " ") }
    public var proposedLine: String? {
        guard let c = proposedCommand, let a = proposedArgs else { return nil }
        return ([c] + a).map(shellQuote).joined(separator: " ")
    }
}

public func shellQuote(_ s: String) -> String {
    if !s.isEmpty && s.allSatisfy({ $0.isLetter || $0.isNumber || "-_./@=:+,".contains($0) }) { return s }
    return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// Record of an applied change. It enables exact restoration when the user
/// has not changed the entry since.
public struct ManifestEntry: Codable, Sendable {
    public var findingId: String
    public var client: ClientKind
    public var scope: String
    public var file: String
    public var project: String?
    public var name: String
    public var shadow: Bool
    public var originalCommand: String
    public var originalArgs: [String]
    /// Claude: original entry JSON. Codex: nil.
    public var originalJSON: String?
    /// Codex: exact original text of the `command` and `args` values.
    public var originalCommandRaw: String?
    public var originalArgsRaw: String?
    public var wrappedCommandRaw: String?
    public var wrappedArgsRaw: String?
    public var backup: String?
    public var appliedAt: Date
}

public struct Manifest: Codable, Sendable {
    public var entries: [ManifestEntry] = []

    static var url: URL { Paths.home.appendingPathComponent("install-manifest.json") }

    public static func load() -> Manifest {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = FileManager.default.contents(atPath: url.path),
              let m = try? decoder.decode(Manifest.self, from: data) else { return Manifest() }
        return m
    }

    public func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(self) else { return }
        Paths.ensureHome()
        FileManager.default.createFile(atPath: Manifest.url.path, contents: data, attributes: [.posixPermissions: 0o600])
    }

    public func latest(for id: String) -> ManifestEntry? { entries.last { $0.findingId == id } }
}

public struct ChangeResult: Sendable, Identifiable {
    public var id: String { finding.id }
    public var finding: Finding
    public var ok: Bool
    public var message: String
}
