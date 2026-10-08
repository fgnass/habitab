import Foundation

/// Decides what Habitab does with one server definition.
public enum Classifier {
    public static func id(_ client: ClientKind, _ scope: String, _ file: String, _ project: String?, _ name: String) -> String {
        "\(client.rawValue)|\(scope)|\(project ?? "")|\(file)|\(name)"
    }

    public static func classify(client: ClientKind, scope: String, file: String, project: String?,
                                name: String, command: String, args: [String],
                                launcher: String = Paths.launcher.path) -> Finding? {
        var f = Finding(id: id(client, scope, file, project, name), client: client, scope: scope, file: file,
                        project: project, name: name, command: command, args: args, status: .migrate, detail: "")
        if let (innerCommand, innerArgs) = Wrapper.unwrap(command: command, args: args) {
            if command == launcher {
                f.status = .migrated
                f.detail = "Runs through Habitab."
            } else {
                f.status = .updatePath
                f.detail = "Runs through a Habitab launcher in another location (\(command)). The path will be updated."
                let (c, a) = Wrapper.wrap(command: innerCommand, args: innerArgs, launcher: launcher)
                f.proposedCommand = c
                f.proposedArgs = a
            }
            return f
        }
        guard let parsed = ServerCommandParser.parse(command: command, args: args) else { return nil }
        switch parsed.mode {
        case .external:
            f.status = .external
            f.detail = "Connects to an externally managed browser (\(parsed.reasons.joined(separator: ", "))). Habitab does not take over or quit this browser."
        case .persistentProfile:
            f.status = .persistentProfile
            f.detail = "Uses a fixed profile (--userDataDir). Habitab gives each session its own profile; logins from this profile would then not be available. Not migrated."
        case .managed:
            f.status = .migrate
            var notes: [String] = []
            let opts = ServerCommandParser.options(in: parsed.serverArgs).map(\.key)
            if opts.contains("isolated") { notes.append("--isolated is dropped: Habitab gives each session its own profile.") }
            if !opts.contains("headless") { notes.append("The browser runs headless and appears in the Habitab window instead of its own Chrome window.") }
            if opts.contains("headless") { notes.append("Habitab takes care of --headless.") }
            if let e = parsed.launch.executablePath { notes.append("--executablePath \(e) is used for the Habitab browser.") }
            if let c = parsed.launch.channel { notes.append("--channel \(c) is used for the Habitab browser.") }
            if !parsed.launch.chromeArgs.isEmpty { notes.append("--chromeArg values are passed to Chrome.") }
            if parsed.launch.proxyServer != nil { notes.append("--proxyServer is passed to Chrome.") }
            if parsed.launch.viewport != nil { notes.append("--viewport sets the window size.") }
            notes.append("All other arguments and environment variables stay unchanged.")
            f.detail = notes.joined(separator: " ")
            let (c, a) = Wrapper.wrap(command: command, args: args, launcher: launcher)
            f.proposedCommand = c
            f.proposedArgs = a
        }
        return f
    }
}
