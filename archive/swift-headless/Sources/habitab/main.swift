import Foundation
import HabitabCore

let usage = """
habitab – one home for your agent browsers

  habitab mcp -- <command...>   Run a chrome-devtools-mcp command through Habitab
                                (this is what client configurations call)
  habitab setup                 Show which MCP configurations Habitab would change
  habitab setup --apply [ids]   Apply all proposed changes (or only the given ids)
  habitab uninstall             Restore all configurations
  habitab status                Running sessions, orphans, configurations
  habitab reap [--dry-run]      Remove Habitab browsers whose owner is gone
  habitab install-launcher      Copy this binary to the stable launcher location

"""

func out(_ s: String) { print(s) }

func describe(_ f: Finding) -> String {
    var s = "[\(f.status.rawValue)] \(f.client.label) · \(f.name) · \(f.location)\n"
    s += "    id: \(f.id)\n"
    s += "    now:   \(f.commandLine)\n"
    if let p = f.proposedLine { s += "    after: \(p)\n" }
    s += "    \(f.detail)"
    return s
}

func ensureLauncherInstalled() {
    let me = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    if me != Paths.launcher.path {
        do { try Installer.installLauncher(from: me) } catch { out("Launcher: \(error)") }
    }
}

var args = Array(CommandLine.arguments.dropFirst())
let sub = args.first ?? "help"
args = Array(args.dropFirst())

switch sub {
case "mcp":
    if args.first == "--" { args.removeFirst() }
    Launcher.run(args)

case "setup":
    let apply = args.contains("--apply")
    let ids = Set(args.filter { !$0.hasPrefix("--") })
    let findings = Installer.scan()
    if findings.isEmpty { out("No chrome-devtools-mcp entries found.") }
    for f in findings { out(describe(f)); out("") }
    guard apply else {
        out("To apply: habitab setup --apply")
        break
    }
    ensureLauncherInstalled()
    let selected = findings.filter { $0.isActionable && (ids.isEmpty || ids.contains($0.id)) }
    for r in Installer.apply(selected) { out("\(r.ok ? "✓" : "✗") \(r.finding.name) (\(r.finding.location)): \(r.message)") }
    let legacy = Installer.legacyServers()
    if !legacy.isEmpty {
        out("\nRestart required: \(legacy.count) running session(s) still use the old configuration:")
        for l in legacy { out("  \(l.client) pid \(l.clientPid.map(String.init) ?? "?") in \(l.cwd ?? "?")") }
        out("Claude Code: /mcp → reconnect the server or restart the session. Codex: restart the session.")
    }

case "uninstall":
    let results = Installer.uninstall()
    if results.isEmpty { out("No Habitab entries found.") }
    for r in results { out("\(r.ok ? "✓" : "✗") \(r.finding.name) (\(r.finding.location)): \(r.message)") }
    if !results.isEmpty { out("Running sessions keep using Habitab until they restart.") }

case "status":
    out("Habitab browsers:")
    let owned = Chrome.findOwned().filter { $0.profile.map { Paths.isOwnedProfile(URL(fileURLWithPath: $0)) } ?? false }
    if owned.isEmpty { out("  none") }
    for b in owned { out("  \(b.session) pid \(b.pid) owner \(b.owner) \(Proc.isAlive(identity: b.owner) ? "alive" : "ORPHANED")") }
    out("\nchrome-devtools-mcp without Habitab:")
    let legacy = Installer.legacyServers()
    if legacy.isEmpty { out("  none") }
    for l in legacy { out("  \(l.client) pid \(l.clientPid.map(String.init) ?? "?") in \(l.cwd ?? "?")") }
    out("\nBrowsers started by chrome-devtools-mcp itself:")
    let lb = Installer.legacyBrowsers()
    if lb.isEmpty { out("  none") }
    for b in lb { out("  pid \(b.pid) \(b.orphaned ? "ORPHANED" : "with parent process") \(b.profile)") }
    out("\nConfigurations:")
    for f in Installer.scan() { out("  [\(f.status.rawValue)] \(f.client.label) · \(f.name) · \(f.location)") }

case "reap":
    let dry = args.contains("--dry-run")
    let r = Reaper.run(dryRun: dry)
    out("\(dry ? "Would quit" : "Quit"): \(r.killed.map { "\($0.session) (pid \($0.pid))" })")
    out("Profiles \(dry ? "to delete" : "deleted"): \(r.removedProfiles.count)")

case "install-launcher":
    ensureLauncherInstalled()
    out(Paths.launcher.path)

default:
    out(usage)
}
