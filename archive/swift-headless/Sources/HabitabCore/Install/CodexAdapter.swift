import Foundation

/// Codex configuration: `$CODEX_HOME/config.toml`, profile files
/// `$CODEX_HOME/<name>.config.toml` and `.codex/config.toml` of trusted
/// projects. Plugin servers are reported, not changed.
///
/// `codex mcp add` replaces a whole entry and drops `tools.*` approvals, so
/// Habitab edits only the `command` and `args` values in place.
public enum CodexAdapter {
    public static var home: URL {
        if let dir = ProcessInfo.processInfo.environment["CODEX_HOME"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
    }

    struct Located {
        var name: String
        var command: TOMLScanner.Pair
        var args: TOMLScanner.Pair?
    }

    /// Server entries in the standard `[mcp_servers.<name>]` form.
    static func locate(_ scanner: TOMLScanner) -> (entries: [Located], unsupported: [String]) {
        var commands: [String: TOMLScanner.Pair] = [:]
        var args: [String: TOMLScanner.Pair] = [:]
        var unsupported: [String] = []
        for pair in scanner.pairs where pair.path.count >= 2 && pair.path[0] == "mcp_servers" {
            let name = pair.path[1]
            let standard = pair.table == ["mcp_servers", name] && pair.keyCount == 1
            if pair.path.count == 2 {
                // `name = { command = ... }` under [mcp_servers] or dotted at root.
                if scanner.text(pair.valueRange).contains("chrome-devtools-mcp") { unsupported.append(name) }
                continue
            }
            guard pair.path.count == 3 else { continue }
            if pair.path[2] == "command" {
                if standard { commands[name] = pair }
                else if pair.value.string.map({ ServerCommandParser.isServerToken($0) || Wrapper.isLauncher($0) }) == true
                            || scanner.text(pair.lineRange).contains("chrome-devtools-mcp") { unsupported.append(name) }
            } else if pair.path[2] == "args" {
                if standard { args[name] = pair }
                else if scanner.text(pair.valueRange).contains("chrome-devtools-mcp") { unsupported.append(name) }
            }
        }
        let entries = commands.keys.sorted().map { Located(name: $0, command: commands[$0]!, args: args[$0]) }
        return (entries, Array(Set(unsupported).subtracting(commands.keys)).sorted())
    }

    static func configFiles() -> [(scope: String, file: URL, project: String?)] {
        var files: [(String, URL, String?)] = []
        let user = home.appendingPathComponent("config.toml")
        files.append(("user", user, nil))
        if let items = try? FileManager.default.contentsOfDirectory(atPath: home.path) {
            for item in items.sorted() where item.hasSuffix(".config.toml") {
                files.append(("profile", home.appendingPathComponent(item), nil))
            }
        }
        if let text = try? String(contentsOf: user, encoding: .utf8), let scanner = try? TOMLScanner(text) {
            for pair in scanner.pairs where pair.path.count == 3 && pair.path[0] == "projects" && pair.path[2] == "trust_level"
                && pair.value.string == "trusted" {
                let project = pair.path[1]
                let file = URL(fileURLWithPath: project).appendingPathComponent(".codex/config.toml")
                if FileManager.default.fileExists(atPath: file.path) { files.append(("project", file, project)) }
            }
        }
        // A trusted project can be CODEX_HOME's parent (for example ~), so
        // its .codex/config.toml is the user file. Keep each file once.
        var seen = Set<String>()
        return files.filter { seen.insert($0.1.resolvingSymlinksInPath().standardizedFileURL.path).inserted }
    }

    public static func scan() -> [Finding] {
        var findings: [Finding] = []
        for (scope, file, project) in configFiles() {
            guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
            let scanner: TOMLScanner
            do { scanner = try TOMLScanner(text) } catch {
                if text.contains("chrome-devtools-mcp") {
                    findings.append(Finding(id: Classifier.id(.codex, scope, file.path, project, "?"), client: .codex, scope: scope,
                                            file: file.path, project: project, name: "?", command: "", args: [],
                                            status: .unsupported, detail: "File not readable: \(error)"))
                }
                continue
            }
            let (entries, unsupported) = locate(scanner)
            for e in entries {
                guard let command = e.command.value.string else { continue }
                let args = e.args?.value.stringArray ?? []
                if e.args != nil && e.args?.value.stringArray == nil { continue }
                guard var f = Classifier.classify(client: .codex, scope: scope, file: file.path, project: project,
                                                  name: e.name, command: command, args: args) else { continue }
                if scope == "project" && f.isActionable {
                    f.detail += " Note: project file, often shared in the repository. The launcher path only applies to this machine."
                }
                findings.append(f)
            }
            for name in unsupported {
                findings.append(Finding(id: Classifier.id(.codex, scope, file.path, project, name), client: .codex, scope: scope,
                                        file: file.path, project: project, name: name, command: "", args: [],
                                        status: .unsupported,
                                        detail: "Entry in inline or dotted notation. Write it as an [mcp_servers.\(name)] table, then Habitab can migrate it."))
            }
        }
        findings += pluginFindings()
        return findings
    }

    static func pluginFindings() -> [Finding] {
        let cache = home.appendingPathComponent("plugins/cache")
        guard let walker = FileManager.default.enumerator(atPath: cache.path) else { return [] }
        var findings: [Finding] = []
        for case let path as String in walker where path.hasSuffix(".mcp.json") {
            let full = cache.appendingPathComponent(path).path
            guard let data = FileManager.default.contents(atPath: full),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let servers = json["mcpServers"] as? [String: Any] else { continue }
            for (name, value) in servers {
                guard let entry = value as? [String: Any], let command = entry["command"] as? String else { continue }
                let args = entry["args"] as? [String] ?? []
                guard var f = Classifier.classify(client: .codex, scope: "plugin", file: full, project: nil,
                                                  name: name, command: command, args: args) else { continue }
                if f.status != .external {
                    f.status = .unsupported
                    f.proposedCommand = nil; f.proposedArgs = nil
                    f.detail = "Plugin server. Plugin files are replaced on updates. An [mcp_servers.\(name)] entry in config.toml overrides it; create one, then Habitab migrates it."
                }
                findings.append(f)
            }
        }
        return findings
    }

    // MARK: Apply / restore

    static func load(_ path: String) throws -> (String, TOMLScanner, [Located]) {
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let scanner = try TOMLScanner(text)
        return (text, scanner, locate(scanner).entries)
    }

    static func write(_ text: String, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).habitab-tmp")
        try text.write(to: tmp, atomically: false, encoding: .utf8)
        if let perms = attrs?[.posixPermissions] { try? FileManager.default.setAttributes([.posixPermissions: perms], ofItemAtPath: tmp.path) }
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }

    public static func apply(_ f: Finding, backup: String?) throws -> ManifestEntry {
        guard let newCommand = f.proposedCommand, let newArgs = f.proposedArgs else {
            throw InstallError.message("No proposal for \(f.name)")
        }
        let (text, scanner, entries) = try load(f.file)
        guard let e = entries.first(where: { $0.name == f.name }),
              e.command.value.string == f.command, (e.args?.value.stringArray ?? []) == f.args else {
            throw InstallError.message("\(f.file) changed since the check. Check again.")
        }
        let commandRaw = TOMLScanner.quote(newCommand)
        let argsRaw = TOMLScanner.array(newArgs)
        var edits = [TextEdit(start: e.command.valueRange.lowerBound, end: e.command.valueRange.upperBound, replacement: commandRaw)]
        if let a = e.args {
            edits.append(TextEdit(start: a.valueRange.lowerBound, end: a.valueRange.upperBound, replacement: argsRaw))
        } else {
            let end = e.command.lineRange.upperBound
            let needsNewline = end == 0 || scanner.bytes[end - 1] != 0x0A
            edits.append(TextEdit(start: end, end: end, replacement: (needsNewline ? "\n" : "") + "args = \(argsRaw)\n"))
        }
        let updated = TextEdit.apply(edits, to: text)
        // The result must still parse and contain exactly the intended values.
        let check = try TOMLScanner(updated)
        guard let after = locate(check).entries.first(where: { $0.name == f.name }),
              after.command.value.string == newCommand, after.args?.value.stringArray == newArgs else {
            throw InstallError.message("Verification after editing failed; file not written")
        }
        try write(updated, to: f.file)

        let prior = Manifest.load().latest(for: f.id)
        let isUpdate = f.status == .updatePath
        let inner = Wrapper.unwrap(command: f.command, args: f.args)
        return ManifestEntry(
            findingId: f.id, client: .codex, scope: f.scope, file: f.file, project: f.project, name: f.name, shadow: false,
            originalCommand: isUpdate ? (prior?.originalCommand ?? inner?.0 ?? f.command) : f.command,
            originalArgs: isUpdate ? (prior?.originalArgs ?? inner?.1 ?? f.args) : f.args,
            originalJSON: nil,
            originalCommandRaw: isUpdate ? prior?.originalCommandRaw : scanner.text(e.command.valueRange),
            originalArgsRaw: isUpdate ? prior?.originalArgsRaw : e.args.map { scanner.text($0.valueRange) },
            wrappedCommandRaw: commandRaw, wrappedArgsRaw: argsRaw, backup: backup, appliedAt: Date())
    }

    public static func restore(_ f: Finding, manifest m: ManifestEntry?) throws -> String {
        let (text, scanner, entries) = try load(f.file)
        guard let e = entries.first(where: { $0.name == f.name }), let command = e.command.value.string,
              let (innerCommand, innerArgs) = Wrapper.unwrap(command: command, args: e.args?.value.stringArray ?? []) else {
            throw InstallError.message("\(f.name) is not a Habitab entry")
        }
        var edits: [TextEdit] = []
        var exact = false
        if let m, let origCmd = m.originalCommandRaw, scanner.text(e.command.valueRange) == m.wrappedCommandRaw,
           let a = e.args, scanner.text(a.valueRange) == m.wrappedArgsRaw {
            exact = true
            edits.append(TextEdit(start: e.command.valueRange.lowerBound, end: e.command.valueRange.upperBound, replacement: origCmd))
            if let origArgs = m.originalArgsRaw {
                edits.append(TextEdit(start: a.valueRange.lowerBound, end: a.valueRange.upperBound, replacement: origArgs))
            } else {
                // Habitab inserted the args line; remove it again.
                edits.append(TextEdit(start: a.lineRange.lowerBound, end: a.lineRange.upperBound, replacement: ""))
            }
        } else {
            edits.append(TextEdit(start: e.command.valueRange.lowerBound, end: e.command.valueRange.upperBound,
                                  replacement: TOMLScanner.quote(innerCommand)))
            if let a = e.args {
                edits.append(TextEdit(start: a.valueRange.lowerBound, end: a.valueRange.upperBound,
                                      replacement: TOMLScanner.array(innerArgs)))
            }
        }
        let updated = TextEdit.apply(edits, to: text)
        let check = try TOMLScanner(updated)
        guard let after = locate(check).entries.first(where: { $0.name == f.name }),
              after.command.value.string == innerCommand, (after.args?.value.stringArray ?? []) == innerArgs else {
            throw InstallError.message("Verification after restoring failed; file not written")
        }
        try write(updated, to: f.file)
        return exact ? "Original restored" : "Unwrapped; later changes are kept"
    }
}
