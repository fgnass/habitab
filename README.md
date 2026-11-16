# Habitab – one home for your agent browsers

Habitab is **one** app for the browsers of parallel Claude Code and Codex
sessions. On the left, sessions are grouped by project (with client, current
tool call and tabs); on the right is the real Chromium browser of the selected
session with docked DevTools. One Dock icon, no extra Chrome process, every
session isolated.

The official [Chrome DevTools MCP Server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
runs unchanged, with the client configurations as they are. One setting gives
every server its browser in Habitab: the server's own global config names
Habitab's browser script as `executablePath` (`habitab setup --apply`). Every
chrome-devtools-mcp (1.10 or newer) that would start a Chrome starts this
script instead, also one a CLI bundles.

## Architecture

```
Claude Code / Codex / Gemini CLI / …
   │ stdio (MCP)
   ▼
npx -y chrome-devtools-mcp@latest                                  unchanged
   │  • reads ~/.config/cd4a/config.json: executablePath = habitab-browser
   │  • Puppeteer starts it like Chrome, with CDP on the pipe fds 3 and 4
   ▼
habitab browser <chrome args>                                      Browser bridge (bin/habitab-browser)
   │  • one session per MCP server process (hb-p<pid>): a browser the server
   │    starts again (after an app restart) rejoins it
   │  • client and project from the process tree and the working directory;
   │    Claude Code's session id and inbox socket from the environment
   │  • asks the app for the session browser (starts the app if needed),
   │    bridges pipe <-> WebSocket; take control holds the CDP commands
   │  • Claude Code: pushes feedback notes into the session's inbox socket
   │  • without the app (HABITAB_DISABLE=1, app unreachable): the real Chrome
   │  • HABITAB_CDP_TRACE=1 logs every CDP message (logs/browser.log)
   ▼                                   Unix socket (0600) / named pipe
Habitab.app (Electron)
   • per session: its own in-memory partition (cookies, storage, cache)
     and tabs as embedded Chromium views
   • one CDP proxy per session: the MCP server only sees the tabs of its
     session; new tabs/popups land in the same session
   • steps from CDP: a burst of commands is one step, named by what it did
     ("Navigate <url>", "Click", "Type", "Screenshot", "Script" with the
     agent's source); Puppeteer's bookkeeping and page listings make no step;
     tools without a pause between them join ("Click, Snapshot")
   • Codex (0.163+, app-server daemon): the MCP server is a child of the
     daemon, so the thread is found by its working directory among the
     daemon's threads (thread/list). Subscribed (thread/resume), the app shows
     the thread's tool calls by name instead of CDP steps and sends feedback
     as a user message (turn/steer into the running turn, else turn/start),
     the marked area as an image input. Socket: `$CODEX_HOME/app-server-control/`
   • sidebar: one row per active tab with a small live thumbnail (stable order),
     grouped by session under a quiet header (client, project, state, the
     session's options and its menu); tabs that neither the agent nor the user used
     during the session's last 25 steps fold away as inactive tabs; full
     width or thumbnails only (⇧⌘B),
     View → Show Sidebar (⌃⌘S) hides it
   • pause the agent's debugger while you test (per project, session menu): an
     enabled CDP debugger makes V8 run WebAssembly as slow debug code (also in
     audio worklets). Your input in a tab pauses it; the agent's next work in
     that tab turns it on again. A tab with high CPU use shows a hint in the
     top bar
   • GPU load per tab: the sidebar shows "GPU 60%" on a tab that loads the GPU
     (WebGL, WebGPU). The pages count their draw calls; the GPU time is the
     GPU process's (macOS IO registry). With several drawing tabs, each one
     holds its animation frames for a moment in turn, and the drop is its
     share (HABITAB_GPU_TRACE=1 logs the numbers). Habitab does not stop
     such a page by itself. The top bar shows "GPU 60% · Pause" for it: a
     click holds its animation frames and timers (the page shows its last
     frame), and the agent gets a note. Resume Animation in the top bar
     lets it run again, and a new page load starts it anew
   • pages that do not respond: a renderer that uses most of a core gets a
     tiny script; a page that does not answer within 5 s shows "Not
     Responding · Stop Page" in the top bar and is stopped after 30 s (the
     agent gets a note). Reload works on such a page (it is stopped first);
     a stopped or crashed page shows Reload Page
   • persistent profile per project (optional): cookies, localStorage, IndexedDB,
     service workers and cache are stored on disk and survive app restarts; one
     live session uses the profile, parallel ones start with a copy of its cookies
   • docked DevTools (resizable), address bar, find in page (⌘F, ⌘G/⇧⌘G),
     mute a whole session (its menu)
   • status line under the top bar, always there (the same height in every
     session): the agent's current or last step (time, name, duration),
     short notices. Its one button (⇧⌘Y) opens the timeline downwards over the
     page: thumbnails of the changes on top, then all steps of the chosen change
     with scripts and errors. The hovered link's URL shows in a bubble at the
     bottom of the page
   • responsive mode (⇧⌘M): fills the free space by default (zoom: fit); drag
     handles like Chrome's, width presets from phone to 2xl and one that fills
     the space again, width × height. The agent's size lights no preset.
     With touch, a long press goes to the page (as on a phone): no context
     menu of Habitab; a right click still opens it
   • take control: a click in a page holds the agent's next commands in that
     tab (key presses only after a click since you came back to Habitab, so
     Cmd+Tab does not count); it goes on after 10 s without input, when you
     switch to another app, or on Resume. In its other tabs the agent goes
     on; only commands that open or select a tab wait too. Take Control
     (⇧⌘P) and marking hold all tabs. Only the agent's actions wait (click,
     type, navigate, script, screenshot, snapshot, emulation;
     shared/agent-actions.ts), the server's own bookkeeping goes on. When an
     action begins to wait, the agent gets a note (Claude Code inbox, Codex) that the user has
     control and that it must not debug the delay; a command that waits 30 s
     fails with an error that says the same (for every client)
   • app restart: sessions whose server still runs, and pinned ones, come back
     with their tabs, responsive settings and cookies (sessions.json); the
     server starts a new bridge with its next call, which rejoins the session
     (page ids change). localStorage and IndexedDB survive only with a
     persistent profile
   • agents never raise the window (bringToFront only switches the tab)
   • downloads go to the Downloads folder without a dialog; a taken name gets
     a number like in Chrome ("name (1).ext"). The status line shows the
     progress, then the file with Show in Finder; app.log lists every download
   • feedback: the user marks an area of the page (⇧⌘A) and writes a comment;
     the agent gets a note with the comment, the page, the elements in the area
     and the area as an image (Claude Code: the path of a PNG in the session's
     timeline folder, through the inbox socket; Codex: as an image input,
     through the app-server daemon). Without a channel (other clients) the
     note goes to the clipboard
   • several notes at once: Add (⌘↵), or a new drag after a comment, keeps
     the note on the page with its number (a click on it opens it again);
     Send (↵, also in the status line) sends all as one numbered note with
     one image per area. The clipboard gets the part of the page with all areas
   • dictation (macOS): hold the microphone button (or Space in the comment
     field) and talk; let go and the words stand in the field, a meter shows
     what the microphone hears. Recognition runs on the Mac (Apple's Speech
     framework, no cloud) in the system's first language, or the one chosen
     next to the button; a missing model is downloaded when the overlay opens.
     The project's names, tab titles and the agent's last steps serve as
     vocabulary hints. The agent learns that the comment was dictated, so a
     misheard word does no harm
   • feedback on an earlier screenshot: with a timeline change open, marking an
     area (⇧⌘A) works on its screenshot; the agent gets that part of it and the
     note that it is an earlier state (after which step, when, which URL)
   • send element: the page's context menu has "Send Element to Agent…"; the
     marking overlay opens with the element under the pointer already marked
   • console errors (also uncaught exceptions and failed requests, as the
     console reports them) per tab, repeats counted, cleared by a new document;
     "3 errors" in the tab's row (thumbnails only: a red count on the thumbnail)
     and a button in the top bar open the DevTools console (⇧⌘E); their context
     menu sends the errors to the agent like a marked area
   • send from the DevTools: "Send to Agent…" in the context menus of the
     DevTools (console, elements, network) sends the selected text to the agent
   • timeline (⇧⌘Y, in the status line): what the agent did, with screenshots of its tab. A
     screenshot follows each step at once, and again after 400 ms when no new
     step started (pages that were still painting). One card per change of the page; steps that left
     it as it was join the card before ("+N"). Only thumbnails (details in their
     tooltips); a click shows the screenshot large, and its steps in the status line. Screenshots are
     files in `timeline/<session>/` (300 steps per session), deleted with the
     session
```

Why Electron: Chromium runs in the app process, so there is only one Dock icon
and no processes that can become orphaned. Partitions, embedded views and
docked DevTools are built in. The architecture isolates platform-specific code in
`src/shared/platform.ts`. macOS and Linux (tested on Ubuntu with GNOME) are
supported; Windows is prepared but not tested.

The browser bridge and the `habitab` command run on the app's Node runtime
(`ELECTRON_RUN_AS_NODE`), so no separate Node is needed. Without the app, the
bridge starts the real Chrome, so agents never break.

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

On startup the app creates the `habitab` command
`~/Library/Application Support/Habitab/bin/habitab` (Linux: `~/.local/share/habitab/bin/habitab`)
and the browser script `habitab-browser` next to it.

## Setup

Nothing to do: at every start the app names its browser in chrome-devtools-mcp's
global config (unless that file is invalid or names its own browser) and
removes the launcher wrappers of Habitab 0.2 from the client configurations.
**Habitab → Setup …** (⌘,; Linux: **Setup** in the sidebar) shows the state,
the client entries and the running sessions that still need a restart, and
removes Habitab again. The same from the CLI:

```bash
habitab setup            # show the global config and the client entries
habitab setup --apply    # executablePath = habitab-browser; remove 0.2 launcher wrappers
habitab uninstall        # remove the entry and all wrappers
habitab status           # configurations, sessions that need a restart, old MCP browsers
habitab cd4a [--apply|--remove]   # only the global config
```

The one setting is chrome-devtools-mcp's global config `~/.config/cd4a/config.json`
(`$XDG_CONFIG_HOME`; Windows: `%LOCALAPPDATA%\Google\cd4a\config.json`). Other
keys in it stay; a backup goes to `backups/`. Servers started from then on open
their browser in Habitab; running ones keep their browser until they restart
(setup and `status` list them).

- `executablePath` cannot be combined with `--channel`, `--browserUrl`,
  `--wsEndpoint` or `--autoConnect`: a server started with one of them refuses
  to start ("mutually exclusive"). Setup lists such entries. Give them
  `CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1` in their `env`, or drop the flag.
- Chrome arguments of the server (`--headless`, `--isolated`, `--userDataDir`,
  `--chromeArg`) reach the script and have no effect; `--proxy-server` applies
  to the session.
- Only servers from 1.10.0 read the file (Gemini CLI bundles an older one).
- Entries that Habitab 0.2 wrapped (`habitab mcp -- <command>`) are found in
  Claude Code (`~/.claude.json`), Codex (`config.toml`, profiles, trusted
  projects), OpenCode, Cursor, Gemini CLI and Windsurf, and get their original
  command back: exactly as recorded in `install-manifest.json` when nothing else
  changed, else only unwrapped. A client that starts such an entry before the
  app ran once gets the command unchanged (`habitab mcp` runs it); the server
  then reads the global config like any other.
- Sessions started through a 0.2 launcher that still runs show "Old launcher"
  in the sidebar until the agent's server restarts.

## Session mapping (measured)

| | Claude Code 2.1.292 | Codex 0.163 (app-server daemon) | others |
|---|---|---|---|
| Client | `claude` in the process tree above the server | the daemon in the process tree | process name (gemini, cursor, …) |
| Project | `CLAUDE_PROJECT_DIR`, cwd | cwd of the server, Git root | cwd, Git root |
| Chat session | `CLAUDE_CODE_SESSION_ID`; after `/clear` matched against `~/.claude/sessions/<pid>.json` (unofficial) | the active thread with that cwd in the daemon (`thread/list`) | – |
| Tool names | steps from CDP | from the daemon (`item/started`) | steps from CDP |
| Feedback | inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) | `turn/steer` / `turn/start` | clipboard |

Puppeteer passes the server's environment on to the browser it starts, so the
bridge sees what the client gave its MCP server. If an identifier is missing,
Habitab shows that and does not invent one.

## Lifecycle

- The app starts on an agent's first browser access (in the background);
  so does a session's browser.
- Session end (the server exits, or it and its bridge are killed): all tabs
  close and the partition is cleared. Exception: pinned, or used by you in the
  last 5 min – then the browser stays open ("Ended · browser open", closes
  after 30 min without use).
- App restart: sessions whose server still runs come back with their tabs;
  the server's next tool call starts a new bridge that rejoins them.
- Inactive ≠ ended: hidden sessions without activity are throttled by
  Chromium after 5 min; agent activity, running traces/screencasts and your
  use lift the throttling.
- Take control (⇧⌘P): the agent's commands wait until you resume (max. 10 min); a command that waits 30 s fails with the reason, and the agent gets a note.
- Errors appear as a notice in the sidebar and in the log, never as a blocking dialog.

Network: the app's debug port and the session proxies bind only to `127.0.0.1`. The socket is accessible only to your own user.

## Tests

```bash
npm test                  # unit tests
npm run test:integration  # app + bridge + real chrome-devtools-mcp (also a fake Codex daemon); installer in sandbox
```

All tests use their own `HABITAB_HOME`/`HABITAB_SOCKET` and do not touch a real
installation. They run invisibly (no Dock icon, no focus); `HABITAB_TEST_VISIBLE=1` shows the window. Among other things, the integration tests check: separate tabs/cookies/storage,
parallel screenshots in visible and hidden sessions, `new_page`/`close_page`,
popups with `window.opener`, exact `resize_page`, DevTools in parallel with the agent,
take control (manual and automatic, agent input does not count), responsive mode
shared with the agent's `emulate` and `resize_page`, Web Speech and dictation (with a fake
recognizer, `HABITAB_FAKE_SPEECH=1`), the window never takes focus, no Chrome process,
exactly one Dock entry, session end,
a crash of client, server and bridge, app restart, steps from CDP, feedback
notes through the inbox, the Codex thread with its tool calls and feedback
through the (fake) app-server daemon.

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
- Web Speech: Chrome's `SpeechRecognition` sends the audio to Google, and
  Electron ships only the interface (`start()` fails with `network`). Habitab
  replaces it in the pages (macOS) with recognition on the Mac: the events,
  result lists and error names of the spec, `continuous`, `interimResults`,
  `lang` (a language whose model is not installed yet is downloaded on first
  use), `SpeechRecognition.available()` and `install()` with `processLocally`.
  A page needs microphone access for its origin, asked like `getUserMedia`.
  One recognition at a time (one microphone): a new one ends the running one
  with `aborted`. One alternative per result; `grammars` are ignored. Speech
  synthesis (`speechSynthesis`) is Electron's own. The helper is built by
  `npm run build` with the Xcode command line tools (`src/speech/`); without
  them, pages get Electron's interface and the comment field has no dictation.
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
- Closing the window quits Habitab; it asks first only while an agent works
  (a tool call in the last 15 s). An agent that needs the browser starts the
  app again, and the tabs come back.
- Shortcuts in this README are the macOS ones. On Linux, Ctrl takes the place
  of ⌘ (DevTools: Ctrl+Shift+I, show sidebar: Ctrl+Shift+S, back/forward:
  Alt+←/→); the app shows the Linux keys.
- Linux: tested on Ubuntu 26.04 with GNOME (Wayland). No menu bar (its
  shortcuts work). When an agent starts the app, it stays hidden until you open
  Habitab, as GNOME would give the new window the focus. Web Share, Web Speech
  and dictation are macOS only.
- Windows: prepared, not tested. macOS: app ad-hoc signed, not notarized.

The earlier Swift version (headless + screencast) is in `archive/swift-headless/`.

## Third-party assets

- UI icons: [Lucide](https://lucide.dev) (ISC), in `src/ui/icons.js`.
- Client logos: [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT), in `src/ui/client-icons.js`. The logos are trademarks of their owners.

## License

MIT, see [LICENSE](LICENSE).
