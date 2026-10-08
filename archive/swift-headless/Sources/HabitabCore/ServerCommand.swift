import Foundation

/// Analysis of a configured MCP command line (`command` + `args`).
///
/// The analysis finds the chrome-devtools-mcp token, splits the command
/// into the runner part (for example `npx -y chrome-devtools-mcp@latest`)
/// and the server options, and classifies the browser options.
public struct ServerCommand: Equatable, Sendable {
    public enum Mode: String, Codable, Sendable {
        /// Server launches its own browser: Habitab can manage it.
        case managed
        /// Server connects to a browser that someone else runs.
        case external
        /// Server uses a persistent profile directory that Habitab must not share.
        case persistentProfile
    }

    public var argv: [String]
    /// Index in `argv` of the token that names chrome-devtools-mcp.
    public var serverIndex: Int
    public var mode: Mode
    /// Human readable reasons for `mode` (option names).
    public var reasons: [String]
    public var launch: LaunchOptions

    public var runner: [String] { Array(argv[...serverIndex]) }
    public var serverArgs: [String] { Array(argv[(serverIndex + 1)...]) }
}

/// Browser launch options taken from the server arguments. Habitab applies
/// them to the Chrome instance that it starts itself.
public struct LaunchOptions: Codable, Equatable, Sendable {
    public var executablePath: String?
    public var channel: String?
    public var chromeArgs: [String] = []
    public var ignoreDefaultChromeArgs: [String] = []
    public var proxyServer: String?
    public var viewport: String?
    public var acceptInsecureCerts = false
    public var headful = false

    public init() {}
}

public enum ServerCommandParser {
    /// True for a token that names the chrome-devtools-mcp package or its
    /// entry script: `chrome-devtools-mcp`, `chrome-devtools-mcp@latest`,
    /// `/opt/bin/chrome-devtools-mcp`, `.../node_modules/chrome-devtools-mcp/build/src/index.js`.
    public static func isServerToken(_ token: String) -> Bool {
        let t = token.lowercased()
        let last = (t as NSString).lastPathComponent
        if last == "chrome-devtools-mcp" || last.hasPrefix("chrome-devtools-mcp@") { return true }
        if last == "chrome-devtools-mcp.js" || last == "chrome-devtools-mcp-main.js" { return true }
        if t.contains("/chrome-devtools-mcp/") && t.hasSuffix(".js") { return true }
        // Scoped forks are not the official server; do not claim them.
        return false
    }

    public static func parse(command: String, args: [String]) -> ServerCommand? {
        let argv = [command] + args
        guard let index = argv.firstIndex(where: isServerToken) else { return nil }
        return analyze(argv: argv, serverIndex: index)
    }

    /// Value-taking options of chrome-devtools-mcp 1.x (short aliases mapped).
    static let stringOptions: Set<String> = [
        "browserUrl", "wsEndpoint", "wsHeaders", "executablePath", "userDataDir", "channel",
        "proxyServer", "chromeArg", "ignoreDefaultChromeArg", "logFile", "viewport", "config",
        "blockedUrlPattern", "allowedUrlPattern", "filesystemRoot", "experimentalFfmpegPath",
        "experimentalScreencastFps", "screenshotFormat", "screenshotQuality", "screenshotMaxWidth",
        "screenshotMaxHeight", "clearcutEndpoint", "clearcutForceFlushIntervalMs", "experimentalDataFormat",
    ]
    static let aliases: [String: String] = ["u": "browserUrl", "w": "wsEndpoint", "e": "executablePath", "workspace": "filesystemRoot"]

    /// Options that Habitab takes over because they control how the browser
    /// is launched. They are removed before the server starts.
    static let launchOptions: Set<String> = [
        "isolated", "headless", "executablePath", "channel", "chromeArg",
        "ignoreDefaultChromeArg", "proxyServer", "acceptInsecureCerts",
    ]

    public struct Option: Equatable {
        public var key: String          // camelCase, no "no-" prefix
        public var negated: Bool
        public var value: String?
        public var range: Range<Int>    // token range in the argument list
    }

    public static func camel(_ name: String) -> String {
        let parts = name.split(separator: "-")
        guard let first = parts.first else { return name }
        return String(first) + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
    }

    /// Tokenizes yargs-style options: `--a b`, `--a=b`, `-u b`, `--no-a`.
    public static func options(in args: [String]) -> [Option] {
        var result: [Option] = []
        var i = 0
        while i < args.count {
            let token = args[i]
            guard token.hasPrefix("-"), token != "-", token != "--" else { i += 1; continue }
            var name = String(token.drop(while: { $0 == "-" }))
            var value: String?
            if let eq = name.firstIndex(of: "=") {
                value = String(name[name.index(after: eq)...])
                name = String(name[..<eq])
            }
            var key = aliases[name] ?? camel(name)
            var negated = false
            if key.hasPrefix("no") && key.count > 2 && key.dropFirst(2).first?.isUppercase == true && !stringOptions.contains(key) {
                negated = true
                key = key.dropFirst(2).prefix(1).lowercased() + key.dropFirst(3)
            }
            let start = i
            i += 1
            if value == nil {
                if stringOptions.contains(key) {
                    if i < args.count { value = args[i]; i += 1 }
                } else if i < args.count, ["true", "false"].contains(args[i].lowercased()) {
                    value = args[i]; i += 1
                }
            }
            result.append(Option(key: key, negated: negated, value: value, range: start..<i))
        }
        return result
    }

    static func flag(_ option: Option) -> Bool {
        if option.negated { return false }
        if let v = option.value?.lowercased() { return v != "false" && v != "0" }
        return true
    }

    public static func analyze(argv: [String], serverIndex: Int) -> ServerCommand {
        let args = Array(argv[(serverIndex + 1)...])
        var opts = options(in: args)
        var reasons: [String] = []
        var mode = ServerCommand.Mode.managed

        // Options from a JSON config file count like command line options.
        if let configPath = opts.last(where: { $0.key == "config" })?.value,
           let data = FileManager.default.contents(atPath: (configPath as NSString).expandingTildeInPath),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for (k, v) in json {
                let key = camel(k)
                let value: String? = (v as? String) ?? (v as? Bool).map { $0 ? "true" : "false" }
                opts.insert(Option(key: key, negated: false, value: value, range: 0..<0), at: 0)
            }
        }

        var launch = LaunchOptions()
        for o in opts {
            switch o.key {
            case "browserUrl", "wsEndpoint":
                if o.value?.isEmpty == false { mode = .external; reasons.append("--\(o.key)") }
            case "autoConnect":
                if flag(o) { mode = .external; reasons.append("--autoConnect") }
            case "userDataDir":
                if mode != .external, o.value?.isEmpty == false { mode = .persistentProfile; reasons.append("--userDataDir") }
            case "executablePath": launch.executablePath = o.value
            case "channel": launch.channel = o.value
            case "chromeArg": if let v = o.value { launch.chromeArgs.append(v) }
            case "ignoreDefaultChromeArg": if let v = o.value { launch.ignoreDefaultChromeArgs.append(v) }
            case "proxyServer": launch.proxyServer = o.value
            case "viewport": launch.viewport = o.value
            case "acceptInsecureCerts": launch.acceptInsecureCerts = flag(o)
            case "headless": launch.headful = !flag(o)
            default: break
            }
        }
        // Habitab always runs Chrome headless and shows it in its own window,
        // also for entries that did not pass --headless before.
        return ServerCommand(argv: argv, serverIndex: serverIndex, mode: mode, reasons: reasons, launch: launch)
    }

    /// Server arguments for a server that connects to Habitab's browser:
    /// launch options removed, `--browserUrl` added.
    public static func rewrittenServerArgs(_ args: [String], browserURL: String, sanitizedConfig: String?) -> [String] {
        let opts = options(in: args)
        var drop = IndexSet()
        for o in opts where launchOptions.contains(o.key) || (o.key == "config" && sanitizedConfig != nil) {
            drop.insert(integersIn: o.range)
        }
        var result = args.enumerated().filter { !drop.contains($0.offset) }.map(\.element)
        if let config = sanitizedConfig { result += ["--config", config] }
        result += ["--browserUrl", browserURL]
        return result
    }

    /// Removes launch options from a JSON config file. Returns the path of a
    /// sanitized copy, or nil if the file has no launch options.
    public static func sanitizedConfig(from args: [String], into dir: URL) -> String? {
        guard let path = options(in: args).last(where: { $0.key == "config" })?.value,
              let data = FileManager.default.contents(atPath: (path as NSString).expandingTildeInPath),
              var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let before = json.count
        json = json.filter { !launchOptions.contains(camel($0.key)) }
        guard json.count != before, let out = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        let url = dir.appendingPathComponent("config-\(getpid()).json")
        FileManager.default.createFile(atPath: url.path, contents: out, attributes: [.posixPermissions: 0o600])
        return url.path
    }
}

/// The wrapped form written into client configurations:
/// `<launcher> mcp -- <original command> <original args...>`
public enum Wrapper {
    public static let subcommand = "mcp"

    public static func isLauncher(_ command: String) -> Bool {
        let name = (command as NSString).lastPathComponent
        return name == "habitab"
    }

    public static func wrap(command: String, args: [String], launcher: String = Paths.launcher.path) -> (String, [String]) {
        (launcher, [subcommand, "--", command] + args)
    }

    /// Returns the original command if `command`/`args` is a Habitab wrapper.
    public static func unwrap(command: String, args: [String]) -> (String, [String])? {
        guard isLauncher(command), args.first == subcommand,
              let sep = args.firstIndex(of: "--"), sep + 1 < args.count else { return nil }
        let inner = Array(args[(sep + 1)...])
        return (inner[0], Array(inner.dropFirst()))
    }
}
