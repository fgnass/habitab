import AppKit
import Foundation
import HabitabCore

struct TabInfo: Identifiable, Hashable {
    var id: String
    var title: String
    var url: String
    var openerId: String?
    var updated: Date
    var created: Date

    var isBlank: Bool { url.isEmpty || url == "about:blank" || url == "chrome://newtab/" }
    var displayTitle: String {
        if !title.isEmpty && title != url { return title }
        if isBlank { return "Empty Tab" }
        return URL(string: url)?.host ?? url
    }
}

/// Browser-level CDP connection of one session: tab list and thumbnails.
/// The connection is a second client next to chrome-devtools-mcp; it only
/// reads target information unless a person interacts in the viewer.
@MainActor
final class BrowserController: ObservableObject {
    @Published private(set) var tabs: [TabInfo] = []
    @Published private(set) var thumbnails: [String: NSImage] = [:]
    @Published private(set) var isConnected = false
    private(set) var cdp: CDPClient?
    private(set) var port: Int?
    private var connecting = false
    private var thumbnailTask: Task<Void, Never>?
    private var thumbDebounce: Task<Void, Never>?

    /// Most recently changed page; the agent is most likely working there.
    var activeTabId: String? { tabs.max { $0.updated < $1.updated }?.id }

    func connect(port: Int) {
        if self.port == port, isConnected || connecting { return }
        disconnect()
        self.port = port
        connecting = true
        Task { await self.open(port: port) }
    }

    private func open(port: Int) async {
        defer { connecting = false }
        guard let url = URL(string: "http://127.0.0.1:\(port)/json/version"),
              let (data, _) = try? await URLSession.shared.data(from: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ws = json["webSocketDebuggerUrl"] as? String, let wsURL = URL(string: ws),
              self.port == port else { return }
        let client = CDPClient(url: wsURL)
        client.onEvent = { [weak self] method, params, _ in
            Task { @MainActor in self?.event(method, params) }
        }
        client.onClose = { [weak self, weak client] in
            Task { @MainActor in
                guard let self, self.cdp === client else { return }
                self.isConnected = false
                self.cdp = nil
            }
        }
        let ok = await withCheckedContinuation { cont in client.connect { cont.resume(returning: $0) } }
        guard ok, self.port == port else { client.close(); return }
        cdp = client
        isConnected = true
        _ = try? await client.call("Target.setDiscoverTargets", ["discover": true])
        if let result = try? await client.call("Target.getTargets"),
           let infos = result["targetInfos"] as? [[String: Any]] {
            infos.forEach(upsert)
        }
        refreshThumbnails()
        thumbnailTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                self?.refreshThumbnails()
            }
        }
    }

    func disconnect() {
        thumbnailTask?.cancel()
        thumbnailTask = nil
        cdp?.close()
        cdp = nil
        port = nil
        isConnected = false
        tabs = []
    }

    private func event(_ method: String, _ params: [String: Any]) {
        switch method {
        case "Target.targetCreated", "Target.targetInfoChanged":
            if let info = params["targetInfo"] as? [String: Any] { upsert(info) }
            if method == "Target.targetInfoChanged" { scheduleThumbnail() }
        case "Target.targetDestroyed":
            if let id = params["targetId"] as? String {
                tabs.removeAll { $0.id == id }
                thumbnails.removeValue(forKey: id)
            }
        default:
            break
        }
    }

    private func upsert(_ info: [String: Any]) {
        guard info["type"] as? String == "page", let id = info["targetId"] as? String else { return }
        let title = info["title"] as? String ?? ""
        let url = info["url"] as? String ?? ""
        if let i = tabs.firstIndex(where: { $0.id == id }) {
            if tabs[i].title != title || tabs[i].url != url {
                tabs[i].title = title
                tabs[i].url = url
                tabs[i].updated = Date()
            }
        } else {
            tabs.append(TabInfo(id: id, title: title, url: url, openerId: info["openerId"] as? String,
                                updated: Date(), created: Date()))
        }
    }

    func agentActivity() { scheduleThumbnail() }

    private func scheduleThumbnail() {
        thumbDebounce?.cancel()
        thumbDebounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled else { return }
            self?.refreshThumbnails(onlyActive: true)
        }
    }

    /// Small screenshots for the session list. A temporary CDP session is
    /// attached and detached again; the page is not activated.
    func refreshThumbnails(onlyActive: Bool = false) {
        guard let cdp else { return }
        let targets = onlyActive ? [activeTabId].compactMap { $0 } : tabs.filter { !$0.isBlank }.map(\.id)
        for id in targets.prefix(6) {
            Task {
                guard let att = try? await cdp.call("Target.attachToTarget", ["targetId": id, "flatten": true]),
                      let sid = att["sessionId"] as? String else { return }
                let shot = try? await cdp.call("Page.captureScreenshot", ["format": "jpeg", "quality": 45,
                                                                           "optimizeForSpeed": true], sessionId: sid)
                cdp.send("Target.detachFromTarget", ["sessionId": sid])
                if let b64 = shot?["data"] as? String, let data = Data(base64Encoded: b64), let image = NSImage(data: data) {
                    self.thumbnails[id] = image.resized(maxWidth: 480)
                }
            }
        }
    }

    func newTab(url: String = "about:blank") async -> String? {
        let result = try? await cdp?.call("Target.createTarget", ["url": url])
        return result?["targetId"] as? String
    }

    func closeTab(_ id: String) {
        cdp?.send("Target.closeTarget", ["targetId": id])
    }

    func devtoolsURL(for targetId: String) -> URL? {
        guard let port else { return nil }
        return DevToolsProxy.shared.frontendURL(chromePort: port, targetId: targetId)
    }

    /// Visible tabs. Blank tabs are hidden unless they are the only ones or selected.
    func visibleTabs(hideBlank: Bool, selected: String?) -> (tabs: [TabInfo], hidden: Int) {
        let sorted = tabs.sorted { $0.created < $1.created }
        guard hideBlank else { return (sorted, 0) }
        let shown = sorted.filter { !$0.isBlank || $0.id == selected }
        if shown.isEmpty { return (sorted, 0) }
        return (shown, sorted.count - shown.count)
    }
}

extension NSImage {
    func resized(maxWidth: CGFloat) -> NSImage {
        guard size.width > maxWidth else { return self }
        let scale = maxWidth / size.width
        let newSize = NSSize(width: maxWidth, height: size.height * scale)
        let image = NSImage(size: newSize)
        image.lockFocus()
        draw(in: NSRect(origin: .zero, size: newSize), from: .zero, operation: .copy, fraction: 1)
        image.unlockFocus()
        return image
    }
}
