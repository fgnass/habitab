# Habitab – one home for your agent browsers

Habitab is **one** app for the browsers of parallel Claude Code and Codex
sessions. On the left, sessions are grouped by project (with client, current
tool call and tabs); on the right is the real Chromium browser of the selected
session with docked DevTools. One Dock icon, no extra Chrome process, every
session isolated.

The official [Chrome DevTools MCP Server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
runs unchanged; Habitab only puts a launcher in front of it.

## Architecture

```
Claude Code / Codex
   │ stdio (MCP)
   ▼
habitab mcp -- npx -y chrome-devtools-mcp@latest --isolated        Launcher
   │  • starts the original command as a child process; launch options
   │    (--isolated, --headless, …) are replaced by --browserUrl
   │  • --browserUrl points to a local port of the launcher; the first
   │    access starts the app if needed and gets the session browser
   │  • observes MCP: clientInfo, roots, tool calls, _meta.threadId
   ▼                                   Unix socket (0600) / named pipe
Habitab.app (Electron)
   • per session: its own in-memory partition (cookies, storage, cache)
     and tabs as embedded Chromium views
   • one CDP proxy per session: the MCP server only sees the tabs of its
     session; new tabs/popups land in the same session
   • sidebar: one row per active tab with a small live thumbnail (stable order),
     grouped by session under a quiet header (client, project, state, the
     session's options and its menu); tabs that neither the agent nor the user used
     during the session's last 25 tool calls fold away as inactive tabs; full
     width or thumbnails only (⇧⌘B),
     View → Show Sidebar (⌃⌘S) hides it
   • pause the agent's debugger while you test (per project, session menu): an
     enabled CDP debugger makes V8 run WebAssembly as slow debug code (also in
     audio worklets). Your input in a tab pauses it; the agent's next work in
     that tab turns it on again. A tab with high CPU use shows a hint in the
     top bar
   • persistent profile per project (optional): cookies, localStorage, IndexedDB,
     service workers and cache are stored on disk and survive app restarts; one
     live session uses the profile, parallel ones start with a copy of its cookies
   • docked DevTools (resizable), address bar, find in page (⌘F, ⌘G/⇧⌘G),
     mute a whole session (its menu)
   • status line under the top bar, always there (the same height in every
     session): the agent's current or last tool call (time, name, duration),
     short notices. Its one button (⇧⌘Y) opens the timeline downwards over the
     page: thumbnails of the changes on top, then all calls of the chosen change
     with scripts and errors. The hovered link's URL shows in a bubble at the
     bottom of the page
   • responsive mode (⇧⌘M): fills the free space by default (zoom: fit); drag
     handles like Chrome's, Tailwind breakpoints (sm–2xl), width × height
   • take control: a click in a page holds the agent's next tool calls (key
     presses only after a click since you came back to Habitab, so Cmd+Tab
     does not count); it goes on after 10 s without input, when you switch
     to another app, or on Resume
   • app restart: connected and pinned sessions come back with their tabs,
     responsive settings and cookies (sessions.json); the launchers reconnect
     and the agents continue (page ids change). localStorage and IndexedDB
     survive only with a persistent profile
   • agents never raise the window (bringToFront only switches the tab)
   • feedback: the launcher adds a `wait_for_user_feedback` tool; the user marks an
     area of the page (⇧⌘A) and writes a comment; the agent gets comment, URL,
     elements and the area as an image. Without a waiting agent it is kept for the
     next call (and copied to the clipboard)
   • feedback on an earlier screenshot: with a timeline change open, marking an
     area (⇧⌘A) works on its screenshot; the agent gets that part of it and the
     note that it is an earlier state (after which call, when, which URL)
   • send element: the page's context menu has "Send Element to Agent…"; the
     marking overlay opens with the element under the pointer already marked
   • console errors (also uncaught exceptions and failed requests, as the
     console reports them) per tab, repeats counted, cleared by a new document;
     "3 errors" in the tab's row (thumbnails only: a red count on the thumbnail)
     and a button in the top bar open the DevTools console (⇧⌘E); their context
     menu sends the errors to the agent like a marked area. The note that wakes
     the agent has no page text, the tool result marks the lines as page content
   • send from the DevTools: "Send to Agent…" in the context menus of the
     DevTools (console, elements, network) sends the selected text to the agent
   • timeline (⇧⌘Y, in the status line): what the agent did, with screenshots of its tab. A
     screenshot follows each tool call at once (the launcher reports the end
     before the agent gets the answer), and again after 400 ms when no new call
     started (pages that were still painting). One card per change of the page; calls that left
     it as it was join the card before ("+N"). Only thumbnails (details in their
     tooltips); a click shows the screenshot large, and its calls in the status line. Screenshots are
     files in `timeline/<session>/` (300 steps per session), deleted with the
     session
   • Claude Code inbox: without a waiting agent, the launcher posts a short note
     (user's words and URL) to the session's inbox socket
     (CLAUDE_CODE_MESSAGING_SOCKET, cross-session messaging). An idle session
     starts a new turn, a busy one reads it between tool calls; Claude then
     calls `wait_for_user_feedback` for the details. The session accepts it
     without asking because the launcher is its child process. The line format
     is internal to Claude Code (measured with 2.1.296); no flag needed
   • Codex queue: for Codex, the launcher queues the same note for the thread
     with `codex queue --thread <id>` (the codex executable of its parent
     process, Codex 0.162+). An idle session starts a new turn with it, as if
     the user typed it
   • Claude Code channel (wins over the inbox): started with
     `claude --dangerously-load-development-channels server:chrome-devtools`
     (the name of the server entry), a marked area reaches Claude at once as a
     channel event; Claude then calls `wait_for_user_feedback` for the details.
     Channels are a research preview; Habitab is not on Anthropic's allowlist,
     hence the development flag (with a warning dialog at every start)
```

Why Electron: Chromium runs in the app process, so there is only one Dock icon
and no processes that can become orphaned. Partitions, embedded views and
docked DevTools are built in. The architecture isolates platform-specific code in
`src/shared/platform.ts`. macOS and Linux (tested on Ubuntu with GNOME) are
supported; Windows is prepared but not tested.

The launcher runs on the app's Node runtime (`ELECTRON_RUN_AS_NODE`), so no
separate Node is needed. If the app is not installed, the launcher script runs the
original command unchanged.

## Installation

```bash
git clone <repo> habitab && cd habitab
./install.sh
```

The script checks Node (≥ 20) and npm, builds the app, installs it and starts it:

- macOS: to `/Applications` (without write access: `~/Applications`).
- Linux: to `~/.local/lib/habitab`. The app adds itself to the applications
  (`~/.local/share/applications/habitab.desktop`). Where the system does not
  allow user namespaces (Ubuntu 24.04 and newer), Chromium's sandbox needs its
  setuid helper: the script asks for `sudo` once to make `chrome-sandbox` owned
  by root with mode 4755.

The app then offers the MCP setup (see [Setup](#setup)). The script itself changes no
client configuration. The first build downloads Electron.

| Option | Effect |
|---|---|
| `--prefix DIR` | different target folder |
| `--uninstall` | restore configurations, remove the app, optionally delete data |
| `--uninstall --yes` | same, delete data without asking |

Running it again updates an existing installation.

## Development

```bash
npm install
npm start          # electron .
npm run preview    # look at changes before installing: separate instance with demo projects (tests/integration/demo-site.mjs)
npm run dist       # release/*/Habitab.app (ad-hoc signed)
npm run dist:linux # release/linux-*-unpacked/
```

Linux: `npm start` needs the Electron binary and its sandbox helper. After
`npm install`:

```bash
node node_modules/electron/install.js
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

On startup the app creates the launcher script:
`~/Library/Application Support/Habitab/bin/habitab` (Linux: `~/.local/share/habitab/bin/habitab`).

## Setup

In the app: **Habitab → Setup …** (⌘,; Linux: **Setup** in the sidebar). Or from the CLI with the launcher script:

```bash
habitab setup            # preview
habitab setup --apply    # apply
habitab uninstall        # restore
habitab status           # configurations, sessions that need a restart, old MCP browsers
```

| Location | Handling |
|---|---|
| Claude Code, user and local scope (`~/.claude.json`) | via `claude mcp remove/add-json` (official CLI) |
| Claude Code, project `.mcp.json` | file stays unchanged; local override with the same name |
| Codex `config.toml`, profile files | only `command`/`args` are replaced, all other bytes stay (tool approvals, comments) |
| Codex, project files of trusted projects | offered, not preselected |
| OpenCode (`~/.config/opencode/opencode.json[c]`, project `opencode.json[c]`), Cursor (`~/.cursor/mcp.json`, `.cursor/mcp.json`), Gemini CLI (`~/.gemini/settings.json`, `.gemini/settings.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`) | JSON/JSONC via [jsonc-parser](https://www.npmjs.com/package/jsonc-parser): only the `command`/`args` values are replaced in place, comments and formatting stay; project files only in projects Claude Code or Codex know, not preselected |
| Plugins, managed configuration, inline TOML | shown, not changed |

- `--browserUrl`, `--wsEndpoint`, `--autoConnect`: managed externally, never migrated.
- `--userDataDir`: fixed profile, not migrated.
- `--proxyServer`, `--acceptInsecureCerts`, `--viewport` apply to the session;
  `--executablePath`, `--channel`, `--chromeArg` have no effect (built-in Chromium).
- Backups in `backups/`, manifest `install-manifest.json`. Safe to run repeatedly.
- Uninstall never copies backups back. It finds the wrapped entries, takes the
  original command from the wrapper (`habitab mcp -- <original>`) and changes
  only `command`/`args`. Unchanged entries are restored byte for byte; entries
  changed later are only unwrapped, your changes stay. Files listed in the
  manifest are always checked, also Codex projects that are no longer trusted.
- Running sessions need a restart; setup and `status` list them.

## Session mapping (measured)

| | Claude Code 2.1.292 | Codex 0.159.1 |
|---|---|---|
| Client | `clientInfo.name = claude-code` | `clientInfo.name = codex-mcp-client` |
| Project | `CLAUDE_PROJECT_DIR`, roots, cwd | cwd, Git root |
| Chat session | `CLAUDE_CODE_SESSION_ID`; after `/clear` matched against `~/.claude/sessions/<pid>.json` (unofficial) | `_meta.threadId` of each tool call |

If an identifier is missing, Habitab shows that and does not invent one.

## Lifecycle

- The app starts on an agent's first browser access (in the background);
  so does a session's browser.
- Session end (stdin EOF, signal, launcher crash): all tabs close and the
  partition is cleared. Exception: pinned, or used by you in the last 5 min –
  then the browser stays open ("Ended · browser open", closes after
  30 min without use).
- App restart: sessions are gone; launchers reconnect, and the next
  tool call gets a fresh browser.
- Inactive ≠ ended: hidden sessions without activity are throttled by
  Chromium after 5 min; agent activity, running traces/screencasts and your
  use lift the throttling.
- Take control (⇧⌘P): new tool calls wait until you resume (max. 10 min).
- Errors appear as a notice in the sidebar and in the log, never as a blocking dialog.

Network: the app's debug port, the session proxies and the launcher ports bind
only to `127.0.0.1`. The socket is accessible only to your own user.

## Tests

```bash
npm test                  # unit tests
npm run test:integration  # app + launcher + real chrome-devtools-mcp; installer in sandbox
```

All tests use their own `HABITAB_HOME`/`HABITAB_SOCKET` and do not touch a real
installation. They run invisibly (no Dock icon, no focus); `HABITAB_TEST_VISIBLE=1` shows the window. Among other things, the integration tests check: separate tabs/cookies/storage,
parallel screenshots in visible and hidden sessions, `new_page`/`close_page`,
popups with `window.opener`, exact `resize_page`, DevTools in parallel with the agent,
take control (manual and automatic, agent input does not count), responsive mode
shared with the agent's `emulate`, the window never takes focus, no Chrome process,
exactly one Dock entry, session end,
launcher crash, app restart.

## Limitations

- Chromium of the Electron version (currently 152), a few weeks behind Chrome.
- No Chrome Sync, no Chrome extensions.
- New windows from `window.open` become tabs of the session.
- Downloads go to `~/Downloads`. Camera, microphone and reading the clipboard:
  a page's request asks you (Allow / Block, kept per project and origin; Site
  Permissions in the session menu forgets an answer). Writing the clipboard is
  allowed, as in Chrome. Other permissions (location, notifications) are denied.
- Web Share: Electron has no `navigator.share`; Habitab adds `share()` and
  `canShare()` to the pages (macOS) and opens the native share menu. The menu
  does not report whether you shared, so the promise resolves when it closes
  (Chrome rejects a cancel with `AbortError`).
- Plain http under an own host name (e.g. `app.test` → 127.0.0.1) is no secure
  context, so camera, clipboard & co. are missing. The session menu offers
  "Treat http://app.test:5173 as Secure…" (Chromium's
  `--unsafely-treat-insecure-origin-as-secure`; exact origin with port, applied
  after a restart). `localhost`, `127.0.0.1` and `*.localhost` are secure anyway.
- Local network: Chromium's own prompt (Local Network Access) is off in
  Electron, so pages reach LAN addresses without asking. macOS still asks once
  per app (localhost is exempt). The permission is tied to the code signature:
  after a rebuild of the ad-hoc signed app, LAN requests may fail with "No route
  to host" and no dialog; turn Habitab off and on again in System Settings →
  Privacy & Security → Local Network.
- Linux/Windows: prepared, not tested. App ad-hoc signed, not notarized.

The earlier Swift version (headless + screencast) is in `archive/swift-headless/`.

## Third-party assets

- UI icons: [Lucide](https://lucide.dev) (ISC), in `src/ui/icons.js`.
- Client logos: [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT), in `src/ui/client-icons.js`. The logos are trademarks of their owners.
