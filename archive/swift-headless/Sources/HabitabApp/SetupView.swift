import AppKit
import HabitabCore
import SwiftUI

@MainActor
final class SetupModel: ObservableObject {
    @Published var findings: [Finding] = []
    @Published var selected: Set<String> = []
    @Published var results: [ChangeResult] = []
    @Published var legacyServers: [Installer.LegacyServer] = []
    @Published var legacyBrowsers: [Installer.LegacyBrowser] = []
    @Published var busy = false
    @Published var lastRun: Date?

    var pendingCount: Int { findings.filter(\.isActionable).count }
    var needsAttention: Bool { pendingCount > 0 && !UserDefaults.standard.bool(forKey: "setupSeen") }

    func refresh() {
        busy = true
        Task.detached {
            let findings = Installer.scan()
            let servers = Installer.legacyServers()
            let browsers = Installer.legacyBrowsers()
            await MainActor.run {
                self.findings = findings
                // Preselect personal configurations; shared project files only on request.
                self.selected = Set(findings.filter { $0.isActionable && $0.scope != "project" || ($0.isActionable && $0.shadow) }.map(\.id))
                self.legacyServers = servers
                self.legacyBrowsers = browsers
                self.busy = false
            }
        }
    }

    func apply() {
        let chosen = findings.filter { selected.contains($0.id) && $0.isActionable }
        busy = true
        Task.detached {
            let results = Installer.apply(chosen)
            await MainActor.run {
                self.results = results
                self.lastRun = Date()
                UserDefaults.standard.set(true, forKey: "setupSeen")
                self.refresh()
            }
        }
    }

    func uninstall() {
        busy = true
        Task.detached {
            let results = Installer.uninstall()
            await MainActor.run {
                self.results = results
                self.refresh()
            }
        }
    }

    func end(_ b: Installer.LegacyBrowser) {
        Task.detached {
            _ = Installer.endLegacyBrowser(b)
            await MainActor.run { self.refresh() }
        }
    }
}

struct SetupView: View {
    @EnvironmentObject var model: SetupModel
    @State private var confirmUninstall = false
    @State private var confirmBrowser: Installer.LegacyBrowser?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Migrate MCP Configurations").font(.title2.weight(.semibold))
                Text("Habitab puts its launcher in front of existing chrome-devtools-mcp entries. The server itself, its arguments and environment variables stay unchanged. Habitab creates a backup before each change.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(18)
            Divider()
            List {
                if model.findings.isEmpty && !model.busy {
                    Text("No chrome-devtools-mcp entries found in Claude Code or Codex.").foregroundStyle(.secondary)
                }
                ForEach(ClientKind.allCases, id: \.self) { client in
                    let items = model.findings.filter { $0.client == client }
                    if !items.isEmpty {
                        Section(client.label) {
                            ForEach(items) { f in FindingRow(finding: f, selected: binding(f)) }
                        }
                    }
                }
                if !model.results.isEmpty {
                    Section("Result") {
                        ForEach(model.results) { r in
                            Label("\(r.finding.name) · \(r.finding.location): \(r.message)",
                                  systemImage: r.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                                .foregroundStyle(r.ok ? .green : .red)
                        }
                    }
                }
                if !model.legacyServers.isEmpty {
                    Section("Restart Required") {
                        Text("These running sessions still use the old configuration. They count as migrated only after the MCP server restarts. Claude Code: /mcp → reconnect the server or restart the session. Codex: restart the session.")
                            .font(.callout).foregroundStyle(.secondary)
                        ForEach(model.legacyServers, id: \.self) { l in
                            Label("\(l.client) (pid \(l.clientPid.map(String.init) ?? "?")) in \(l.cwd ?? "?")", systemImage: "arrow.clockwise.circle")
                        }
                    }
                }
                if !model.legacyBrowsers.isEmpty {
                    Section("Browsers Started by chrome-devtools-mcp Itself") {
                        Text("Habitab does not quit these browsers on its own. Orphaned browsers no longer have an MCP server.")
                            .font(.callout).foregroundStyle(.secondary)
                        ForEach(model.legacyBrowsers) { b in
                            HStack {
                                Label(b.orphaned ? "Orphaned" : "In Use", systemImage: b.orphaned ? "exclamationmark.triangle" : "circle")
                                    .foregroundStyle(b.orphaned ? .orange : .secondary)
                                Text("pid \(b.pid)").monospacedDigit()
                                Text(b.profile).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Button("Quit …") { confirmBrowser = b }
                            }
                        }
                    }
                }
            }
            Divider()
            HStack {
                Button("Remove Habitab from All Configurations …") { confirmUninstall = true }
                    .disabled(model.busy || !model.findings.contains { $0.status == .migrated || $0.status == .updatePath })
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Check Again") { model.refresh() }.disabled(model.busy)
                Button("Apply \(model.selected.count) Change(s)") { model.apply() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.selected.isEmpty)
            }
            .padding(14)
        }
        .confirmationDialog("Remove Habitab from all configurations?", isPresented: $confirmUninstall) {
            Button("Remove", role: .destructive) { model.uninstall() }
        } message: {
            Text("Unchanged entries get their original back. Entries that you changed since then are only unwrapped; your changes stay. Running sessions use Habitab until they restart.")
        }
        .confirmationDialog("Quit this browser?", isPresented: Binding(get: { confirmBrowser != nil }, set: { if !$0 { confirmBrowser = nil } })) {
            Button("Quit", role: .destructive) { if let b = confirmBrowser { model.end(b) } }
        } message: {
            Text("pid \(confirmBrowser?.pid ?? 0), profile \(confirmBrowser?.profile ?? ""). Unsaved data in this browser will be lost.")
        }
        .onAppear { model.refresh() }
    }

    private func binding(_ f: Finding) -> Binding<Bool> {
        Binding(get: { model.selected.contains(f.id) },
                set: { on in if on { model.selected.insert(f.id) } else { model.selected.remove(f.id) } })
    }
}

struct FindingRow: View {
    var finding: Finding
    @Binding var selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if finding.isActionable {
                Toggle("", isOn: $selected).toggleStyle(.checkbox).labelsHidden().padding(.top, 2)
            } else {
                Image(systemName: icon).foregroundStyle(color).frame(width: 16).padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(finding.name).fontWeight(.semibold)
                    Text(statusLabel).font(.caption).padding(.horizontal, 6).padding(.vertical, 1)
                        .background(color.opacity(0.15), in: Capsule()).foregroundStyle(color)
                    Text(finding.location).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                if !finding.command.isEmpty {
                    Text(finding.commandLine).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let after = finding.proposedLine {
                    Text("→ " + after).font(.caption.monospaced()).textSelection(.enabled)
                }
                Text(finding.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }

    var statusLabel: String {
        switch finding.status {
        case .migrate: return finding.shadow ? "Migrate (local override)" : "Migrate"
        case .updatePath: return "Update path"
        case .migrated: return "Migrated"
        case .external: return "Managed externally"
        case .persistentProfile: return "Fixed profile"
        case .unsupported: return "Not supported"
        }
    }

    var icon: String {
        switch finding.status {
        case .migrated: return "checkmark.circle.fill"
        case .external: return "link"
        case .persistentProfile: return "person.crop.circle.badge.exclamationmark"
        default: return "exclamationmark.triangle"
        }
    }

    var color: Color {
        switch finding.status {
        case .migrate, .updatePath: return .blue
        case .migrated: return .green
        case .external: return .secondary
        case .persistentProfile, .unsupported: return .orange
        }
    }
}
