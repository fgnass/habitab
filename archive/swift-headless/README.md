# Habitab – one home for your agent browsers

Habitab bundles the Chrome browsers of parallel Codex CLI and Claude Code sessions
into **one** macOS app: one Dock icon, one session list grouped by project, one
interactive browser view per session. Each session keeps its own
isolated Chrome profile. The official
[Chrome DevTools MCP Server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
keeps running unchanged; Habitab only puts a launcher in front of it.

## Architecture

```
Claude Code / Codex
   │ stdio (MCP)
   ▼
habitab mcp -- npx -y chrome-devtools-mcp@latest --isolated      ← Launcher (stdio proxy)
   │  • starts the original command as a child process; only launch options
   │    (--isolated, --headless, -e, --channel, --chromeArg …) are removed
   │    and replaced by --browserUrl http://127.0.0.1:<own port>
   │  • the first DevTools access to this port starts Chrome (lazy):
   │    headless, own profile profiles/<session>, port 0, 127.0.0.1 only
   │  • observes MCP traffic: clientInfo, roots, tool calls, _meta.threadId
   │  • end (stdin EOF, SIGTERM/SIGINT/SIGHUP, server exit) → Chrome + profile removed
   ▼                                    ▲ Unix socket (0600, same user only)
Habitab.app (Manager)  ─────────────────┘
   • session registry, display, interaction (second CDP client: screencast + input)
   • adopts browsers of ended sessions only if pinned or recently used
   • reaper for orphaned browsers, DevTools window via token-protected relay
```

Key decisions:

- **No fork of the MCP server.** chrome-devtools-mcp connects via `--browserUrl`
  and reconnects on its own when the browser restarts (verified with 1.10.1).
- **Headless Chrome instead of windows.** Headless Chrome does not appear in the Dock or
  in Cmd+Tab (verified on macOS 26.5 / Chrome 154). The page is shown in Habitab via
  CDP screencast; mouse, scrolling and keyboard go back via `Input.*`.
- **The launcher owns Chrome, not the app.** Agents also work without
  a running app. If the app is not installed, the launcher runs the
  original command unchanged (`HABITAB_DISABLE=1` forces this).
- **Ownership in the process itself.** Every Habitab Chrome carries
  `--habitab-session=<id>` and `--habitab-owner=<pid>:<starttime>`. Only processes that carry
  these markers **and** whose profile is under
  `~/Library/Application Support/Habitab/profiles/` are cleaned up. Your personal Chrome and
  other browsers never match this rule.

## Build and run

Requirements: macOS 14+, Swift 6 (Command Line Tools are enough), Google Chrome, Node.js.

```bash
./build.sh             # creates ./Habitab.app
./build.sh --install   # also copies to ~/Applications and starts it
```

On startup the app copies the launcher to
`~/Library/Application Support/Habitab/bin/habitab`. Client configurations point to
this stable path, not into the app bundle.

## Setup (drop-in)

In the app: **Habitab → Setup …** (⇧⌘,). Alternatively via CLI:

```bash
~/Library/Application\ Support/Habitab/bin/habitab setup           # preview only
~/Library/Application\ Support/Habitab/bin/habitab setup --apply   # apply all proposals
~/Library/Application\ Support/Habitab/bin/habitab uninstall       # restore everything
~/Library/Application\ Support/Habitab/bin/habitab status          # browsers, leftovers, configurations
```

Entries are detected by their command, regardless of the server name
(`chrome-devtools-mcp`, `chrome-devtools-mcp@…`, absolute paths, `node …/chrome-devtools-mcp/…js`).

| Location | Handling |
|---|---|
| Claude Code, user scope (`~/.claude.json` → `mcpServers`) | via `claude mcp remove/add-json -s user` |
| Claude Code, local scope (`projects[path].mcpServers`) | via `claude mcp … -s local` in the project |
| Claude Code, project `.mcp.json` | **file stays unchanged**; Habitab adds a local override with the same name (local takes precedence) |
| Claude Code, plugins / `managed-mcp.json` | shown only ("not supported", with a hint) |
| Codex, `$CODEX_HOME/config.toml` and profile files `*.config.toml` | direct edit of only the `command` and `args` values; all other bytes stay the same (`tools.*.approval_mode`, comments, timeouts) |
| Codex, `.codex/config.toml` of trusted projects | offered but not preselected (often shared in the repository) |
| Codex, inline/dotted notation, plugins | shown only ("not supported", with a hint) |

Why not `codex mcp add`? The command replaces the whole entry and discards
`tools.*` approvals, timeouts and comments (verified in a sandbox with Codex 0.159.1).

Conflicts:

- `--browserUrl`/`-u`, `--wsEndpoint`/`-w`, `--autoConnect` → **managed externally**,
  never migrated (e.g. an Electron debug entry). The launcher passes such commands
  through unchanged if they ever run through it.
- `--userDataDir` → fixed profile, not migrated (logins would otherwise be missing).
- `--executablePath`, `--channel`, `--chromeArg`, `--proxyServer`, `--viewport`,
  `--acceptInsecureCerts` → applied to the Habitab Chrome.
- Options from `--config <json>` are evaluated the same way; the launcher removes launch
  options in it via a cleaned copy.

Safety of changes:

- Before each change, a copy of the file goes to `backups/<timestamp>/`.
- `install-manifest.json` records the original and the written value.
- **Safe to run repeatedly:** wrapped entries count as "migrated"; an outdated
  launcher path is updated, never wrapped twice.
- **Uninstall:** if an entry is still exactly as Habitab wrote it, the
  original comes back (byte for byte for Codex). If the user has changed it since, Habitab
  only unwraps it (`habitab mcp -- <original>` → `<original>`); later changes
  stay. An old backup is never written back blindly.
- **Restart required:** running sessions keep using the old configuration. Setup
  and `status` list such sessions explicitly (Claude Code: `/mcp` → reconnect
  or restart the session; Codex: restart the session).

## Session mapping

Habitab only shows what a client actually provides, and names the source:

| Information | Claude Code 2.1.292 (measured) | Codex 0.159.1 (measured) |
|---|---|---|
| Client | `clientInfo.name = claude-code` | `clientInfo.name = codex-mcp-client` |
| Project | `CLAUDE_PROJECT_DIR`, roots, cwd | server cwd (= session cwd), Git root |
| Chat session | `CLAUDE_CODE_SESSION_ID` (transcript verified); after `/clear` matched against `~/.claude/sessions/<pid>.json` (unofficial, marked as such) | `_meta.threadId` of each `tools/call`; title from `session_index.jsonl` |
| Roots | yes (`roots/list`) | no |

An MCP connection is not the same as a chat session. If an identifier is missing,
Habitab shows "Agent session not provided" and its own identifier `hb-…`.

## Usage

- Session list grouped by project, searchable (project, path, session ID, tab title, URL).
- Status: **Connected**, **Tool running** (with tool name), **Inactive** (> 2 min without MCP activity),
  **Connection to app lost**, **Connection ended** (possibly "browser open").
- Tabs per session; empty tabs are hidden, not closed ("+N empty").
- Address bar, back/forward/reload, viewport display, "Fit viewport to window".
- Rename, pin (on top + browser stays open after session end), quit browser.
- **Take control:** new tool calls of the agent wait until you choose "Resume agent"
  (automatically after 10 minutes at the latest).
- **DevTools** of the selected tab in a separate Habitab window.
- JavaScript dialogs of the page appear as a bar with OK/Cancel.
- Clipboard: ⌘C/⌘X copy the page selection (also in form fields), ⌘V pastes text.

## Lifecycle

- Chrome starts only on the MCP server's first browser access.
- Normal end (stdin EOF, signal, server exit): the launcher closes Chrome (`Browser.close`,
  then SIGTERM/SIGKILL) and deletes the profile.
- Launcher crash (SIGKILL): Chrome stays around briefly; the reaper (in every new launcher,
  in the app every 60 s and via `habitab reap`) detects the dead owner and cleans up.
- Client crash: stdin EOF at the launcher → normal end.
- App restart: browsers keep running, launchers reconnect on their own and report their state.
- **Inactive ≠ ended:** after 20 min without activity Chrome sleeps (profile, cookies, storage
  stay; the next tool call restarts it). Not during a running performance trace,
  running screencast tool, running tool call, or when the session is being
  viewed/used in Habitab. `HABITAB_IDLE_MINUTES=0` turns this off.
- Session end with handover: pinned or used in the last 5 min → the app
  adopts the browser (`state.json` → `adopted`) and shows "Connection ended, browser open".
  Without pinning it closes after 30 min without use.
- Old browsers that chrome-devtools-mcp started itself (Puppeteer profile) are shown by
  setup; they are quit only after confirmation.

Network: Chrome debug ports, the launcher port and the DevTools relay bind only to
`127.0.0.1`. The relay requires a random token and only allows ports of
Habitab browsers. `--remote-allow-origins=*` is intentionally not set.

## Tests

```bash
./run-tests.sh
```

- `habitab-selftest`: command analysis, wrapper, TOML scanner/edits, path protection.
- `Tests/integration/lifecycle.mjs`: two parallel sessions, separate profiles,
  cookie/storage separation, headless, no Dock entry, end cleans up, SIGKILL + reaper.
- `Tests/integration/protocol.mjs`: manager protocol with a simulated manager (hold, sleep
  with profile kept, reconnect, handover).
- `Tests/integration/install.mjs`: setup/uninstall in a sandbox (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`) with copies of real entries and edge cases; byte-exact restore.
- In-app input test: `HABITAB_SELFTEST_INPUT=1` with `Tests/integration/demo-sessions.mjs`
  sends real `NSEvent`s through the window (click coordinates, umlauts, backspace, ⌘A,
  copy, scrolling, DevTools connection) and checks the result via CDP.

All tests use their own `HABITAB_HOME`/`HABITAB_SOCKET` and do not touch a real
installation.

## Known limitations (as of 0.1.0)

- The view shows the page content, not the Chrome UI (no Chrome context menus,
  no autofill UI). `<select>` popups and file dialogs do not appear in headless mode;
  the agent does uploads with `upload_file`. Habitab sets no download target; Chrome's headless behavior applies.
- The mouse cursor shape (hand, text cursor) is not transferred.
- IME composition (e.g. Japanese) is implemented but not verified; dead keys and
  umlauts are verified.
- Human and agent can type at the same time; "Take control" only holds back
  new tool calls, not one that is already running.
- Plugin servers (Claude Code, Codex) are detected but not migrated automatically.
- The app is ad-hoc signed, not notarized; launch at login is not set up
  (not needed: the launcher starts the app when needed).
