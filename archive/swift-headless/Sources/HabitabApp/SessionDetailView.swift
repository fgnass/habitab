import AppKit
import HabitabCore
import SwiftUI
import WebKit

struct SessionDetailView: View {
    @EnvironmentObject var store: Store
    @ObservedObject var session: SessionModel
    @ObservedObject var browser: BrowserController
    @StateObject private var viewer = PageViewer()
    @State private var selectedTab: String?
    @State private var urlText = ""
    @State private var showActivity = false
    @State private var viewSize = CGSize(width: 1280, height: 800)
    @FocusState private var urlFocused: Bool

    var body: some View {
        let _ = store.tick
        VStack(spacing: 0) {
            header
            Divider()
            if session.held { holdBanner }
            if browser.isConnected {
                tabStrip
                navBar
                Divider()
                ZStack(alignment: .top) {
                    GeometryReader { geo in
                        ScreencastView(viewer: viewer, onShortcut: shortcut)
                            .onAppear { viewSize = geo.size }
                            .onChange(of: geo.size) { _, s in viewSize = s }
                    }
                    if let d = viewer.dialog { dialogBanner(d) }
                }
            } else {
                browserPlaceholder
            }
            if showActivity { Divider(); activityPanel }
        }
        .onAppear(perform: syncSelection)
        .onChange(of: browser.tabs) { _, _ in syncSelection() }
        .onChange(of: browser.isConnected) { _, _ in syncSelection() }
        .onChange(of: selectedTab) { _, id in viewer.attach(cdp: browser.cdp, targetId: id) }
        .onChange(of: viewer.url) { _, u in if !urlFocused { urlText = u } }
        .onDisappear { viewer.detach() }
        .onAppear { viewer.onInput = { [weak store, weak session] in
            if let store, let session { store.noteInteraction(session) }
        } }
        .toolbar { toolbar }
        .navigationTitle(store.displayName(session))
        .navigationSubtitle(session.projectName)
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    StatusDot(phase: session.phase, adopted: session.adopted)
                    Text(StatusDot.label(session.phase, adopted: session.adopted)).font(.callout)
                    if let tool = session.currentTool {
                        Text("· \(tool.tool)\(tool.summary.map { " \($0)" } ?? "")")
                            .font(.callout).foregroundStyle(.blue).lineLimit(1)
                    } else if let last = session.lastActivity {
                        Text("· last MCP activity \(relative(last))").font(.callout).foregroundStyle(.secondary)
                    }
                    if let reason = session.protectedReason {
                        Label(reason, systemImage: "lock.shield").font(.caption).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    ClientBadge(client: session.meta.client)
                    Text(session.clientLabel + (session.meta.clientVersion.map { " \($0)" } ?? ""))
                    Text("·")
                    Text(session.projectPath).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                }
                .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Text("Habitab \(session.id)").textSelection(.enabled)
                    if let a = session.meta.agentSessionId {
                        Text("· Agent session \(a)").textSelection(.enabled)
                            .help("Source: \(sourceLabel(session.meta.agentSessionSource))")
                    } else {
                        Text("· Agent session not provided").help("The client did not provide a session identifier.")
                    }
                    Text("· Browser: \(browserStateLabel)")
                }
                .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var browserStateLabel: String {
        switch session.browserState {
        case "running": return "running" + (session.chromePid.map { " (pid \($0))" } ?? "")
        case "resting": return "sleeping"
        case "notStarted": return "not started yet"
        case "failed": return "start failed"
        default: return "stopped"
        }
    }

    private func sourceLabel(_ s: String?) -> String {
        switch s {
        case "env": return "client environment variable"
        case "claude-sessions-file": return "Claude Code process file (~/.claude/sessions, unofficial)"
        case "mcp-meta-threadId": return "_meta.threadId of tool calls (Codex)"
        case "mcp-meta-sessionId": return "_meta.sessionId of tool calls"
        default: return "unknown"
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            if session.connected {
                Button {
                    store.setHold(session, !session.held)
                } label: {
                    Label(session.held ? "Resume Agent" : "Take Control",
                          systemImage: session.held ? "play.fill" : "hand.raised")
                }
                .help("Holds back new tool calls of the agent while you work (max. 10 minutes).")
            }
            Button { openDevTools() } label: { Label("DevTools", systemImage: "hammer") }
                .disabled(selectedTab == nil)
                .help("Open DevTools for this tab")
            Button { store.togglePin(session) } label: {
                Label(store.isPinned(session) ? "Unpin" : "Pin", systemImage: store.isPinned(session) ? "pin.slash" : "pin")
            }
            .help("Pinned sessions are shown on top; their browser stays open after the session ends.")
            Button { showActivity.toggle() } label: { Label("Activity", systemImage: "list.bullet.rectangle") }
            Menu {
                Button("Rename …") { promptRename(store: store, session: session) }
                Button("Fit Viewport to Window") { viewer.fitViewport(to: viewSize) }
                    .disabled(selectedTab == nil)
                Toggle("Hide Empty Tabs", isOn: $store.hideBlankTabs)
                Divider()
                Button("Quit Browser") { store.stopBrowser(session) }
                    .disabled(session.chromePid == nil && !session.adopted)
                if !session.connected { Button("Remove from List") { store.remove(session) } }
            } label: { Label("More", systemImage: "ellipsis.circle") }
        }
    }

    // MARK: Tabs and navigation

    private var tabStrip: some View {
        let visible = browser.visibleTabs(hideBlank: store.hideBlankTabs, selected: selectedTab)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(visible.tabs) { tab in
                    TabButton(tab: tab, selected: tab.id == selectedTab, agentActive: tab.id == browser.activeTabId,
                              thumbnail: browser.thumbnails[tab.id]) {
                        selectedTab = tab.id
                    } close: {
                        browser.closeTab(tab.id)
                    }
                }
                if visible.hidden > 0 {
                    Button("+\(visible.hidden) empty") { store.hideBlankTabs = false }
                        .buttonStyle(.borderless).font(.caption).foregroundStyle(.secondary)
                        .help("\(visible.hidden) empty tabs are hidden, not closed")
                }
                Button {
                    Task { if let id = await browser.newTab() { selectedTab = id } }
                } label: { Image(systemName: "plus") }
                .buttonStyle(.borderless).help("New Tab")
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
    }

    private var navBar: some View {
        HStack(spacing: 6) {
            Button { viewer.goBack() } label: { Image(systemName: "chevron.left") }.disabled(!viewer.canGoBack)
            Button { viewer.goForward() } label: { Image(systemName: "chevron.right") }.disabled(!viewer.canGoForward)
            Button { viewer.reload() } label: { Image(systemName: "arrow.clockwise") }
            TextField("URL", text: $urlText)
                .textFieldStyle(.roundedBorder)
                .focused($urlFocused)
                .onSubmit { viewer.navigate(urlText); urlFocused = false }
            if let f = viewer.frame {
                Text("\(Int(f.deviceWidth))×\(Int(f.deviceHeight))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .help("Browser viewport in CSS pixels")
            }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 10).padding(.bottom, 6)
    }

    private var holdBanner: some View {
        HStack {
            Image(systemName: "hand.raised.fill")
            Text("You have control. New tool calls of the agent wait.")
            Spacer()
            Button("Resume Agent") { store.setHold(session, false) }
        }
        .padding(8).background(.yellow.opacity(0.25))
    }

    private func dialogBanner(_ d: (message: String, type: String, defaultPrompt: String)) -> some View {
        HStack {
            Image(systemName: "exclamationmark.bubble")
            Text("Page \(d.type == "confirm" ? "confirmation" : d.type == "prompt" ? "prompt" : "alert"): \(d.message)")
                .lineLimit(3)
            Spacer()
            if d.type != "alert" { Button("Cancel") { viewer.answerDialog(accept: false) } }
            Button("OK") { viewer.answerDialog(accept: true, text: d.type == "prompt" ? d.defaultPrompt : nil) }
        }
        .padding(10).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8)).padding(10)
    }

    private var browserPlaceholder: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: session.browserState == "failed" ? "exclamationmark.triangle" : "moon.zzz")
                .font(.system(size: 36, weight: .light)).foregroundStyle(.secondary)
            switch session.browserState {
            case "notStarted": Text("The browser starts on the agent's first browser tool call.")
            case "resting": Text("The browser is sleeping due to inactivity. Profile, cookies and storage are kept; the next tool call starts it again.")
            case "failed": Text("Chrome could not start: \(session.browserDetail ?? "")")
            default: Text(session.ended ? "Session ended. The browser was closed and its profile deleted." : "No browser connected.")
            }
            Spacer()
        }
        .multilineTextAlignment(.center).foregroundStyle(.secondary).padding(30)
        .frame(maxWidth: .infinity)
    }

    private var activityPanel: some View {
        List(session.activity) { e in
            HStack {
                Image(systemName: e.isError ? "xmark.octagon" : "checkmark.circle")
                    .foregroundStyle(e.isError ? .red : .green)
                Text(e.tool).font(.callout.monospaced())
                Text(e.summary ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if let d = e.detail, e.isError { Text(d).font(.caption).foregroundStyle(.red).lineLimit(1) }
                Text(e.durationMs.map { "\($0) ms" } ?? "").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(e.start, style: .time).font(.caption).foregroundStyle(.tertiary)
            }
        }
        .frame(height: 170)
    }

    // MARK: Actions

    private func syncSelection() {
        if let id = selectedTab, browser.tabs.contains(where: { $0.id == id }) {
            viewer.attach(cdp: browser.cdp, targetId: id)
            return
        }
        let candidates = browser.visibleTabs(hideBlank: store.hideBlankTabs, selected: nil).tabs
        selectedTab = browser.activeTabId.flatMap { id in candidates.contains { $0.id == id } ? id : nil } ?? candidates.first?.id
        viewer.attach(cdp: browser.cdp, targetId: selectedTab)
    }

    private func shortcut(_ name: String) {
        switch name {
        case "copy", "cut":
            Task {
                if let text = await viewer.selectedText(), !text.isEmpty {
                    copy(text)
                    if name == "cut" { viewer.key(["type": "rawKeyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8]) }
                }
            }
        case "paste":
            if let text = NSPasteboard.general.string(forType: .string) { viewer.insertText(text) }
        case "focusURL": urlFocused = true
        case "reload": viewer.reload()
        case "back": viewer.goBack()
        case "forward": viewer.goForward()
        default: break
        }
    }

    private func openDevTools() {
        guard let id = selectedTab, let url = browser.devtoolsURL(for: id) else { return }
        DevToolsWindow.open(url: url, title: "DevTools – \(store.displayName(session))")
    }
}

struct TabButton: View {
    var tab: TabInfo
    var selected: Bool
    var agentActive: Bool
    var thumbnail: NSImage?
    var select: () -> Void
    var close: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            if agentActive { Circle().fill(.blue).frame(width: 5, height: 5).help("Last changed by the agent") }
            Text(tab.displayTitle).lineLimit(1).frame(maxWidth: 180, alignment: .leading)
            if hover || selected {
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                    .buttonStyle(.borderless).help("Close Tab")
            }
        }
        .font(.callout)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(hover ? 0.12 : 0.06),
                    in: RoundedRectangle(cornerRadius: 6))
        .onHover { hover = $0 }
        .onTapGesture(perform: select)
        .help(tab.url)
    }
}

/// DevTools frontend served by the headless browser itself, shown in a
/// separate window. No personal Chrome window is involved.
enum DevToolsWindow {
    @MainActor static var windows: [NSWindow] = []

    @discardableResult
    @MainActor static func open(url: URL, title: String) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: config)
        web.load(URLRequest(url: url))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = title
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        windows.append(window)
        windows.removeAll { !$0.isVisible && $0 !== window }
        return web
    }
}
