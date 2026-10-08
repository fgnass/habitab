import AppKit
import HabitabCore
import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var setup: SetupModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 260, ideal: 310, max: 420)
        } detail: {
            if let s = store.selected {
                SessionDetailView(session: s, browser: s.browser)
                    .id(s.id)
            } else {
                EmptyStateView()
            }
        }
        .searchable(text: $store.search, placement: .sidebar, prompt: "Project, session, URL …")
        .onReceive(NotificationCenter.default.publisher(for: .openSetup)) { _ in openWindow(id: "setup") }
        .onAppear {
            if setup.needsAttention { openWindow(id: "setup") }
        }
        .overlay(alignment: .bottom) {
            if let error = store.serverError {
                Text("Habitab service not started: \(error)")
                    .padding(8).background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 6))
                    .foregroundStyle(.white).padding()
            }
        }
    }
}

struct EmptyStateView: View {
    @EnvironmentObject var setup: SetupModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "macwindow.on.rectangle")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)
            Text("No agent browsers yet").font(.title2)
            Text("As soon as Claude Code or Codex uses Chrome DevTools MCP through Habitab, the session appears here.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 420)
            if setup.pendingCount > 0 {
                Button("Migrate \(setup.pendingCount) configuration(s) …") { openWindow(id: "setup") }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("Open Setup …") { openWindow(id: "setup") }
            }
        }
        .padding(40)
    }
}

struct SidebarView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        List(selection: $store.selection) {
            ForEach(store.groups) { group in
                Section {
                    ForEach(group.sessions) { s in
                        SessionRow(session: s, browser: s.browser)
                            .tag(s.id)
                            .contextMenu { SessionMenu(session: s) }
                    }
                } header: {
                    HStack {
                        Image(systemName: "folder")
                        Text(group.name)
                        Spacer()
                        Text("\(group.sessions.count)").foregroundStyle(.tertiary)
                    }
                    .help(group.path)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Toggle("Show ended", isOn: $store.showEnded).toggleStyle(.checkbox).font(.caption)
                Spacer()
                Button("Clean Up") { store.removeAllEnded() }
                    .font(.caption).buttonStyle(.borderless)
                    .help("Remove ended sessions without an open browser from the list")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }
}

struct StatusDot: View {
    var phase: SessionPhase
    var adopted = false

    var body: some View {
        Group {
            switch phase {
            case .toolRunning: ProgressView().controlSize(.mini)
            default: Circle().fill(color).frame(width: 8, height: 8)
            }
        }
        .frame(width: 14, height: 14)
        .help(label)
    }

    var color: Color {
        switch phase {
        case .connected: return .green
        case .toolRunning: return .blue
        case .idle: return .gray
        case .disconnected: return .orange
        case .ended: return adopted ? .purple : .red.opacity(0.6)
        }
    }

    var label: String { Self.label(phase, adopted: adopted) }

    static func label(_ phase: SessionPhase, adopted: Bool) -> String {
        switch phase {
        case .connected: return "Connected"
        case .toolRunning: return "Tool running"
        case .idle: return "Inactive"
        case .disconnected: return "Connection to app lost"
        case .ended: return adopted ? "Connection ended, browser open" : "Connection ended"
        }
    }
}

struct SessionRow: View {
    @EnvironmentObject var store: Store
    @ObservedObject var session: SessionModel
    @ObservedObject var browser: BrowserController

    var body: some View {
        let _ = store.tick
        HStack(alignment: .top, spacing: 8) {
            StatusDot(phase: session.phase, adopted: session.adopted).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if store.isPinned(session) { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange) }
                    Text(store.displayName(session)).fontWeight(.medium).lineLimit(1)
                    Spacer(minLength: 4)
                    ClientBadge(client: session.meta.client)
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let tab = browser.activeTabId.flatMap({ id in browser.tabs.first { $0.id == id } }), !tab.isBlank {
                    Text(tab.displayTitle).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            if let id = browser.activeTabId, let thumb = browser.thumbnails[id] {
                Image(nsImage: thumb).resizable().aspectRatio(contentMode: .fit)
                    .frame(width: 56, height: 36).clipShape(RoundedRectangle(cornerRadius: 3))
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(.separator))
            }
        }
        .padding(.vertical, 2)
        .opacity(session.ended && !session.adopted ? 0.6 : 1)
    }

    var subtitle: String {
        if let tool = session.currentTool { return "▶ \(tool.tool)\(tool.summary.map { " · \($0)" } ?? "")" }
        if session.ended { return "Ended \(relative(session.endedAt))" }
        if session.held { return "Agent paused" }
        if let last = session.lastActivity { return "Last: \(session.activity.first?.tool ?? "active") · \(relative(last))" }
        switch session.browserState {
        case "notStarted": return "Connected · browser starts when needed"
        case "resting": return "Browser sleeping (profile kept)"
        default: return StatusDot.label(session.phase, adopted: session.adopted)
        }
    }
}

func relative(_ date: Date?) -> String {
    guard let date else { return "" }
    if abs(date.timeIntervalSinceNow) < 10 { return "just now" }
    let f = RelativeDateTimeFormatter()
    f.locale = Locale(identifier: "en_US")
    f.unitsStyle = .short
    return f.localizedString(for: date, relativeTo: Date())
}

struct ClientBadge: View {
    var client: String?
    var body: some View {
        Text(client == "claude" ? "Claude" : client == "codex" ? "Codex" : "?")
            .font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
    var color: Color { client == "claude" ? .orange : client == "codex" ? .teal : .gray }
}

struct SessionMenu: View {
    @EnvironmentObject var store: Store
    @ObservedObject var session: SessionModel
    @State private var renaming = false

    var body: some View {
        Button("Rename …") { promptRename(store: store, session: session) }
        Button(store.isPinned(session) ? "Unpin" : "Pin") { store.togglePin(session) }
        Divider()
        Button("Copy Session ID") { copy(session.meta.agentSessionId ?? session.id) }
        Button("Show Project Folder in Finder") {
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.projectPath)
        }
        Divider()
        if session.chromePid != nil || session.adopted {
            Button("Quit Browser") { store.stopBrowser(session) }
        }
        if !session.connected {
            Button("Remove from List") { store.remove(session) }
        }
    }
}

@MainActor
func promptRename(store: Store, session: SessionModel) {
    let alert = NSAlert()
    alert.messageText = "Rename Session"
    alert.informativeText = "Leave empty for the default name."
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = store.state.names[session.id] ?? store.displayName(session)
    alert.accessoryView = field
    alert.addButton(withTitle: "Rename")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    if alert.runModal() == .alertFirstButtonReturn {
        store.rename(session, to: field.stringValue)
    }
}

func copy(_ s: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
}
