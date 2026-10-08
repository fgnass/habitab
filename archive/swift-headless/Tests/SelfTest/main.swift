// Unit checks without XCTest (not available with Command Line Tools only).
//   swift run habitab-selftest
import Foundation
import HabitabCore

var failures = 0
func check(_ cond: Bool, _ label: String, _ extra: @autoclosure () -> String = "") {
    print("\(cond ? "PASS" : "FAIL") \(label)\(cond ? "" : " — " + extra())")
    if !cond { failures += 1 }
}

// MARK: Server command analysis

func parse(_ line: String) -> ServerCommand? {
    let parts = line.split(separator: " ").map(String.init)
    return ServerCommandParser.parse(command: parts[0], args: Array(parts.dropFirst()))
}

check(parse("npx -y chrome-devtools-mcp@latest --isolated")?.mode == .managed, "npx form is managed")
check(parse("npx -y chrome-devtools-mcp@latest --isolated")?.runner == ["npx", "-y", "chrome-devtools-mcp@latest"], "runner split")
check(parse("node /x/node_modules/chrome-devtools-mcp/build/src/index.js")?.serverIndex == 1, "node + script path")
check(parse("/opt/bin/chrome-devtools-mcp --headless")?.serverIndex == 0, "absolute binary")
check(parse("npx some-other-mcp") == nil, "other servers ignored")
check(parse("npx @acme/chrome-devtools-mcp-fork") == nil, "forks are not claimed")
check(parse("npx chrome-devtools-mcp --browser-url http://127.0.0.1:9222")?.mode == .external, "--browser-url external")
check(parse("npx chrome-devtools-mcp --browserUrl=http://x:1")?.mode == .external, "--browserUrl= external")
check(parse("npx chrome-devtools-mcp -u http://x:1")?.mode == .external, "-u external")
check(parse("npx chrome-devtools-mcp -w ws://x/devtools/browser/1")?.mode == .external, "-w external")
check(parse("npx chrome-devtools-mcp --autoConnect")?.mode == .external, "--autoConnect external")
check(parse("npx chrome-devtools-mcp --auto-connect=false")?.mode == .managed, "--auto-connect=false managed")
check(parse("npx chrome-devtools-mcp --no-auto-connect")?.mode == .managed, "--no-auto-connect managed")
check(parse("npx chrome-devtools-mcp --user-data-dir /p")?.mode == .persistentProfile, "--user-data-dir persistent")

let launch = parse("npx chrome-devtools-mcp -e /c/chrome --channel beta --chrome-arg=--lang=de --chromeArg --foo --proxy-server http://p:1 --viewport 1024x768 --accept-insecure-certs")!.launch
check(launch.executablePath == "/c/chrome", "executablePath alias -e")
check(launch.channel == "beta", "channel")
check(launch.chromeArgs == ["--lang=de", "--foo"], "chromeArg repeated", "\(launch.chromeArgs)")
check(launch.proxyServer == "http://p:1" && launch.viewport == "1024x768" && launch.acceptInsecureCerts, "proxy, viewport, certs")

let rewritten = ServerCommandParser.rewrittenServerArgs(
    ["--isolated", "--headless=true", "-e", "/c", "--viewport", "800x600", "--chromeArg", "--x", "--no-usage-statistics"],
    browserURL: "http://127.0.0.1:5", sanitizedConfig: nil)
check(rewritten == ["--viewport", "800x600", "--no-usage-statistics", "--browserUrl", "http://127.0.0.1:5"], "launch options removed, browserUrl added", "\(rewritten)")

// MARK: Wrapper

let (wc, wa) = Wrapper.wrap(command: "npx", args: ["chrome-devtools-mcp@latest", "--isolated"], launcher: "/L/habitab")
check(wc == "/L/habitab" && wa == ["mcp", "--", "npx", "chrome-devtools-mcp@latest", "--isolated"], "wrap")
check(Wrapper.unwrap(command: wc, args: wa)! == ("npx", ["chrome-devtools-mcp@latest", "--isolated"]), "unwrap")
check(Classifier.classify(client: .codex, scope: "user", file: "f", project: nil, name: "n", command: wc, args: wa, launcher: "/L/habitab")?.status == .migrated, "wrapped entry is migrated")
check(Classifier.classify(client: .codex, scope: "user", file: "f", project: nil, name: "n", command: "/old/habitab", args: wa, launcher: "/L/habitab")?.status == .updatePath, "moved launcher -> updatePath")

// MARK: TOML scanner and edits

let toml = """
# top comment
model = "x"

[mcp_servers."chrome devtools"] # comment
command = 'npx'
args = [
  "chrome-devtools-mcp@latest", # c1
  '--isolated',
]
env = { A = "1" }

[mcp_servers."chrome devtools".tools.click]
approval_mode = "approve"

[profiles.p]
s = \"\"\"multi
line\"\"\"
"""
do {
    let scanner = try TOMLScanner(toml)
    let cmd = scanner.pairs.first { $0.path == ["mcp_servers", "chrome devtools", "command"] }
    let args = scanner.pairs.first { $0.path == ["mcp_servers", "chrome devtools", "args"] }
    check(cmd?.value.string == "npx", "literal string value")
    check(args?.value.stringArray == ["chrome-devtools-mcp@latest", "--isolated"], "multi-line array with comments")
    check(scanner.pairs.contains { $0.path == ["profiles", "p", "s"] && $0.value.string == "multi\nline" }, "multi-line string")
    check(scanner.pairs.contains { $0.path == ["mcp_servers", "chrome devtools", "tools", "click", "approval_mode"] }, "sub-table keys")
    let edits = [TextEdit(start: cmd!.valueRange.lowerBound, end: cmd!.valueRange.upperBound, replacement: TOMLScanner.quote("/L/habitab")),
                 TextEdit(start: args!.valueRange.lowerBound, end: args!.valueRange.upperBound, replacement: TOMLScanner.array(["mcp", "--", "a\"b\\c"]))]
    let out = TextEdit.apply(edits, to: toml)
    let again = try TOMLScanner(out)
    check(again.pairs.first { $0.path.last == "args" }?.value.stringArray == ["mcp", "--", "a\"b\\c"], "escaped round trip")
    check(out.hasPrefix("# top comment\nmodel = \"x\"\n\n[mcp_servers.\"chrome devtools\"] # comment\ncommand = \"/L/habitab\""), "bytes before edit unchanged")
    check(out.hasSuffix("env = { A = \"1\" }\n\n[mcp_servers.\"chrome devtools\".tools.click]\napproval_mode = \"approve\"\n\n[profiles.p]\ns = \"\"\"multi\nline\"\"\""), "bytes after edit unchanged")
} catch {
    check(false, "TOML scan", "\(error)")
}
check((try? TOMLScanner("a = \"unterminated\n")) == nil, "syntax error detected")

// MARK: Paths safety

setenv("HABITAB_HOME", "/tmp/hb-selftest-home", 1)
check(Paths.isOwnedProfile(URL(fileURLWithPath: "/tmp/hb-selftest-home/profiles/hb-abc")), "own profile accepted")
check(!Paths.isOwnedProfile(URL(fileURLWithPath: "/tmp/hb-selftest-home/profiles")), "profile root itself rejected")
check(!Paths.isOwnedProfile(URL(fileURLWithPath: "/tmp/hb-selftest-home/profiles/../other")), "path traversal rejected")
check(!Paths.isOwnedProfile(URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/Google/Chrome")), "personal Chrome profile rejected")

print(failures == 0 ? "\nAll checks passed." : "\n\(failures) check(s) failed.")
exit(failures == 0 ? 0 : 1)
