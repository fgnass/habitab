import Foundation

/// Claude Code configuration: user and local scope in `~/.claude.json`
/// (`$CLAUDE_CONFIG_DIR/.claude.json`), project scope in `<project>/.mcp.json`,
/// plugins and managed configuration (read only).
///
/// Changes go through the official CLI (`claude mcp add-json/remove`),
/// because running sessions also write `~/.claude.json`.
public enum ClaudeAdapter {
    public static var configDir: URL {
        if let dir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }

    public static var configFile: URL {
        if let dir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir).appendingPathComponent(".claude.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude.json")
    }

    static let managedFile = "/Library/Application Support/ClaudeCode/managed-mcp.json"

    static func readJSON(_ path: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func jsonString(_ obj: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    public static func scan() -> [Finding] {
        var findings: [Finding] = []
        let file = configFile.path
        let root = readJSON(file) ?? [:]

        func add(_ servers: Any?, scope: String, file: String, project: String?, readOnly: String? = nil, shadow: Bool = false) {
            guard let servers = servers as? [String: Any] else { return }
            for (name, value) in servers.sorted(by: { $0.key < $1.key }) {
                guard let entry = value as? [String: Any], let command = entry["command"] as? String else { continue }
                let args = entry["args"] as? [String] ?? []
                guard var f = Classifier.classify(client: .claude, scope: scope, file: file, project: project,
                                                  name: name, command: command, args: args) else { continue }
                f.rawJSON = jsonString(entry)
                f.shadow = shadow
                if let readOnly, f.status != .external {
                    f.status = .unsupported
                    f.detail = readOnly
                    f.proposedCommand = nil; f.proposedArgs = nil
                }
                findings.append(f)
            }
        }

        add(root["mcpServers"], scope: "user", file: file, project: nil)
        var projectPaths: [String] = []
        if let projects = root["projects"] as? [String: Any] {
            for (path, value) in projects.sorted(by: { $0.key < $1.key }) {
                projectPaths.append(path)
                add((value as? [String: Any])?["mcpServers"], scope: "local", file: file, project: path)
            }
        }
        // Project files: the change is a local override with the same name.
        let localNames = Set(findings.filter { $0.scope == "local" }.map { "\($0.project ?? "")|\($0.name)" })
        for path in projectPaths {
            let mcp = (path as NSString).appendingPathComponent(".mcp.json")
            guard let json = readJSON(mcp) else { continue }
            let servers = (json["mcpServers"] as? [String: Any] ?? [:]).filter { !localNames.contains("\(path)|\($0.key)") }
            add(servers, scope: "project", file: mcp, project: path, shadow: true)
        }
        // Plugins and managed configuration cannot be edited.
        for (plugin, mcpPath) in pluginMCPFiles() {
            if let json = readJSON(mcpPath) {
                let servers = json["mcpServers"] ?? json
                add(servers, scope: "plugin", file: mcpPath, project: nil,
                    readOnly: "Plugin \"\(plugin)\": plugin files are replaced on updates. Disable the plugin or its server and let Habitab create a user entry.")
            }
        }
        if let json = readJSON(managedFile) {
            add(json["mcpServers"], scope: "managed", file: managedFile, project: nil,
                readOnly: "Managed configuration (administrator). Habitab does not change it.")
        }
        return findings
    }

    /// `.mcp.json` files and inline `mcpServers` of installed plugins.
    static func pluginMCPFiles() -> [(String, String)] {
        let installed = configDir.appendingPathComponent("plugins/installed_plugins.json").path
        guard let json = readJSON(installed), let plugins = json["plugins"] as? [String: Any] else { return [] }
        var result: [(String, String)] = []
        for (name, value) in plugins {
            for install in (value as? [[String: Any]]) ?? [] {
                guard let path = install["installPath"] as? String else { continue }
                let mcp = (path as NSString).appendingPathComponent(".mcp.json")
                if FileManager.default.fileExists(atPath: mcp) { result.append((name, mcp)) }
                let manifest = (path as NSString).appendingPathComponent(".claude-plugin/plugin.json")
                if let m = readJSON(manifest), m["mcpServers"] is [String: Any] { result.append((name, manifest)) }
            }
        }
        return result
    }

    // MARK: CLI

    public static func cliPath() -> String? {
        if let custom = ProcessInfo.processInfo.environment["HABITAB_CLAUDE_CLI"] { return custom }
        let home = NSHomeDirectory()
        let candidates = ["\(home)/.local/bin/claude", "\(home)/.claude/local/claude", "/opt/homebrew/bin/claude",
                          "/usr/local/bin/claude", "\(home)/.npm-global/bin/claude"]
        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return found }
        return Shell.which("claude")
    }

    static func cli(_ args: [String], cwd: String?) throws -> String {
        guard let path = cliPath() else { throw InstallError.message("Claude Code CLI not found") }
        let result = Shell.run(path, args, cwd: cwd)
        guard result.status == 0 else {
            throw InstallError.message("claude \(args.prefix(3).joined(separator: " ")): \(result.output.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return result.output
    }

    /// CLI scope and working directory for a finding.
    static func target(_ f: Finding) -> (scope: String, cwd: String?) {
        switch f.scope {
        case "user": return ("user", nil)
        default: return ("local", f.project)
        }
    }

    /// Replaces the entry `name` with `entry`. For shadows only adds.
    static func write(entry: [String: Any], name: String, finding f: Finding, removeFirst: Bool) throws {
        let (scope, cwd) = target(f)
        if removeFirst {
            _ = try cli(["mcp", "remove", name, "-s", scope], cwd: cwd)
        }
        do {
            _ = try cli(["mcp", "add-json", name, jsonString(entry), "-s", scope], cwd: cwd)
        } catch {
            Log.write("claude add-json failed after remove: \(error)")
            throw error
        }
    }

    public static func apply(_ f: Finding, backup: String?) throws -> ManifestEntry {
        guard let raw = f.rawJSON, var entry = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
              let command = f.proposedCommand, let args = f.proposedArgs else {
            throw InstallError.message("No proposal for \(f.name)")
        }
        let original = entry
        entry["command"] = command
        entry["args"] = args
        if entry["type"] == nil { entry["type"] = "stdio" }
        do {
            try write(entry: entry, name: f.name, finding: f, removeFirst: !f.shadow)
        } catch {
            // Put the original back if remove worked but add failed.
            if !f.shadow { try? write(entry: original, name: f.name, finding: f, removeFirst: false) }
            throw error
        }
        try verify(f, expectCommand: command)
        let isUpdate = f.status == .updatePath
        let prior = Manifest.load().latest(for: f.id)
        let unwrapped = Wrapper.unwrap(command: f.command, args: f.args)
        return ManifestEntry(
            findingId: f.id, client: .claude, scope: f.scope, file: f.file, project: f.project, name: f.name,
            shadow: f.shadow,
            originalCommand: isUpdate ? (prior?.originalCommand ?? unwrapped?.0 ?? f.command) : f.command,
            originalArgs: isUpdate ? (prior?.originalArgs ?? unwrapped?.1 ?? f.args) : f.args,
            originalJSON: isUpdate ? prior?.originalJSON : raw,
            backup: backup, appliedAt: Date())
    }

    static func currentEntry(_ f: Finding) -> [String: Any]? {
        let root = readJSON(configFile.path) ?? [:]
        let servers: Any?
        if f.scope == "user" {
            servers = root["mcpServers"]
        } else {
            servers = ((root["projects"] as? [String: Any])?[f.project ?? ""] as? [String: Any])?["mcpServers"]
        }
        return (servers as? [String: Any])?[f.name] as? [String: Any]
    }

    static func verify(_ f: Finding, expectCommand: String) throws {
        guard let entry = currentEntry(f), entry["command"] as? String == expectCommand else {
            throw InstallError.message("Change to \(f.name) did not arrive in \(configFile.path)")
        }
    }

    /// Restores one wrapped entry. Exact original JSON when the entry is still
    /// what Habitab wrote; otherwise only command/args are unwrapped, so later
    /// changes (env, other fields) stay.
    public static func restore(_ f: Finding, manifest: ManifestEntry?) throws -> String {
        guard let raw = f.rawJSON, var entry = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
              let (command, args) = Wrapper.unwrap(command: f.command, args: f.args) else {
            throw InstallError.message("\(f.name) is not a Habitab entry")
        }
        if let m = manifest, m.shadow, f.scope == "local" {
            // Override for a project file: remove it; the project entry applies again.
            _ = try cli(["mcp", "remove", f.name, "-s", "local"], cwd: f.project)
            return "Local override removed; .mcp.json applies again"
        }
        var exact = false
        if let m = manifest, let json = m.originalJSON,
           let original = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] {
            var expected = original
            expected["command"] = f.command
            expected["args"] = f.args
            if expected["type"] == nil { expected["type"] = "stdio" }
            // The CLI drops fields it does not know, so the stored entry may be
            // a subset of what was written. Every stored field must match.
            let unchanged = entry.allSatisfy { key, value in
                guard let e = expected[key] else { return false }
                return jsonString([key: e]) == jsonString([key: value])
            }
            if unchanged {
                entry = original
                exact = true
            }
        }
        if !exact {
            entry["command"] = command
            entry["args"] = args
        }
        try write(entry: entry, name: f.name, finding: f, removeFirst: true)
        try verify(f, expectCommand: entry["command"] as? String ?? command)
        return exact ? "Original restored" : "Unwrapped; later changes are kept"
    }
}

public enum InstallError: Error, CustomStringConvertible {
    case message(String)
    public var description: String { if case .message(let m) = self { return m }; return "Error" }
}

public enum Shell {
    public struct Result { public var status: Int32; public var output: String }

    public static func run(_ path: String, _ args: [String], cwd: String? = nil, timeout: TimeInterval = 60) -> Result {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        if let cwd { task.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        var env = ProcessInfo.processInfo.environment
        // GUI apps get a minimal PATH; node-based CLIs need the usual locations.
        let extra = ["\(NSHomeDirectory())/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        env["PATH"] = ((env["PATH"].map { [$0] } ?? []) + extra).joined(separator: ":")
        task.environment = env
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        task.standardInput = FileHandle.nullDevice
        do { try task.run() } catch { return Result(status: -1, output: "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return Result(status: task.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }

    /// Looks up a command in the user's login shell PATH.
    public static func which(_ name: String) -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let r = run(shell, ["-lc", "command -v \(name)"])
        let path = r.output.split(separator: "\n").last.map(String.init)?.trimmingCharacters(in: .whitespaces)
        guard r.status == 0, let path, path.hasPrefix("/") else { return nil }
        return path
    }
}
