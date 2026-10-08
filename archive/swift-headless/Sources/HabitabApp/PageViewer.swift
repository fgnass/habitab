import AppKit
import Foundation
import HabitabCore

/// Screencast and input for one page. Coordinates in input events are CSS
/// pixels of the page viewport, taken from the metadata of the last frame,
/// so display, viewport and input stay in sync when the agent resizes or
/// emulates a device.
@MainActor
final class PageViewer: ObservableObject {
    struct FrameMeta: Equatable {
        var deviceWidth: Double
        var deviceHeight: Double
        var pageScale: Double
        var offsetTop: Double
    }

    @Published private(set) var image: CGImage?
    @Published private(set) var frame: FrameMeta?
    @Published private(set) var targetId: String?
    @Published private(set) var url = ""
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published var dialog: (message: String, type: String, defaultPrompt: String)?
    @Published private(set) var fileChooserPending = false

    private weak var cdp: CDPClient?
    var debugPort: Int? { cdp?.url.port }
    private var sessionId: String?
    private var maxSize = CGSize(width: 1600, height: 1200)
    private var generation = 0
    private var listener: UUID?
    var onInput: (() -> Void)?

    func attach(cdp: CDPClient?, targetId: String?) {
        guard let cdp, let targetId else { detach(); return }
        if self.cdp === cdp && self.targetId == targetId && sessionId != nil { return }
        detach()
        self.cdp = cdp
        self.targetId = targetId
        generation += 1
        let gen = generation
        Task {
            guard let att = try? await cdp.call("Target.attachToTarget", ["targetId": targetId, "flatten": true]),
                  let sid = att["sessionId"] as? String, gen == self.generation else { return }
            self.sessionId = sid
            self.listener = cdp.addListener { [weak self] method, params, eventSession in
                guard eventSession == sid else { return }
                Task { @MainActor in self?.event(method, params, sid: sid) }
            }
            _ = try? await cdp.call("Page.enable", sessionId: sid)
            // A headless page has no window focus; without this, inputs show no caret.
            _ = try? await cdp.call("Emulation.setFocusEmulationEnabled", ["enabled": true], sessionId: sid)
            self.startScreencast()
            await self.refreshHistory()
        }
    }

    func detach() {
        if let cdp, let sid = sessionId {
            cdp.send("Page.stopScreencast", sessionId: sid)
            cdp.send("Target.detachFromTarget", ["sessionId": sid])
        }
        if let cdp, let listener { cdp.removeListener(listener) }
        listener = nil
        generation += 1
        sessionId = nil
        targetId = nil
        image = nil
        frame = nil
        dialog = nil
    }

    func setViewSize(_ size: CGSize, scale: CGFloat) {
        let newMax = CGSize(width: max(320, (size.width * scale).rounded()), height: max(240, (size.height * scale).rounded()))
        guard abs(newMax.width - maxSize.width) > 40 || abs(newMax.height - maxSize.height) > 40 else { return }
        maxSize = newMax
        if sessionId != nil { startScreencast() }
    }

    private func startScreencast() {
        guard let cdp, let sid = sessionId else { return }
        cdp.send("Page.startScreencast", ["format": "jpeg", "quality": 80, "everyNthFrame": 1,
                                          "maxWidth": Int(maxSize.width), "maxHeight": Int(maxSize.height)], sessionId: sid)
    }

    private func event(_ method: String, _ params: [String: Any], sid: String) {
        guard sid == sessionId else { return }
        switch method {
        case "Page.screencastFrame":
            if let ack = params["sessionId"] as? Int { cdp?.send("Page.screencastFrameAck", ["sessionId": ack], sessionId: sid) }
            if let meta = params["metadata"] as? [String: Any] {
                let f = FrameMeta(deviceWidth: meta["deviceWidth"] as? Double ?? 0,
                                  deviceHeight: meta["deviceHeight"] as? Double ?? 0,
                                  pageScale: meta["pageScaleFactor"] as? Double ?? 1,
                                  offsetTop: meta["offsetTop"] as? Double ?? 0)
                if f != frame { frame = f }
            }
            if let b64 = params["data"] as? String, let data = Data(base64Encoded: b64),
               let src = CGImageSourceCreateWithData(data as CFData, nil),
               let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
                image = img
            }
        case "Page.frameNavigated":
            if let fr = params["frame"] as? [String: Any], fr["parentId"] == nil {
                url = fr["url"] as? String ?? url
                Task { await refreshHistory() }
            }
        case "Page.navigatedWithinDocument":
            url = params["url"] as? String ?? url
        case "Page.javascriptDialogOpening":
            dialog = (params["message"] as? String ?? "", params["type"] as? String ?? "alert",
                      params["defaultPrompt"] as? String ?? "")
        case "Page.javascriptDialogClosed":
            dialog = nil
        default:
            break
        }
    }

    private func refreshHistory() async {
        guard let cdp, let sid = sessionId,
              let h = try? await cdp.call("Page.getNavigationHistory", sessionId: sid),
              let index = h["currentIndex"] as? Int, let entries = h["entries"] as? [[String: Any]] else { return }
        canGoBack = index > 0
        canGoForward = index < entries.count - 1
        if index < entries.count { url = entries[index]["url"] as? String ?? url }
    }

    private func send(_ method: String, _ params: [String: Any] = [:]) {
        guard let cdp, let sid = sessionId else { return }
        cdp.send(method, params, sessionId: sid)
    }

    private func call(_ method: String, _ params: [String: Any] = [:]) async -> [String: Any]? {
        guard let cdp, let sid = sessionId else { return nil }
        return try? await cdp.call(method, params, sessionId: sid)
    }

    // MARK: Navigation

    func navigate(_ text: String) {
        var s = text.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return }
        if !s.contains("://") && !s.hasPrefix("about:") && !s.hasPrefix("data:") {
            s = (s.contains(".") || s.hasPrefix("localhost") || s.hasPrefix("127.")) && !s.contains(" ")
                ? (s.hasPrefix("localhost") || s.hasPrefix("127.") ? "http://" : "https://") + s
                : "https://www.google.com/search?q=" + (s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s)
        }
        onInput?()
        send("Page.navigate", ["url": s])
    }

    func goBack() { history(-1) }
    func goForward() { history(1) }

    private func history(_ delta: Int) {
        onInput?()
        Task {
            guard let h = await call("Page.getNavigationHistory"), let index = h["currentIndex"] as? Int,
                  let entries = h["entries"] as? [[String: Any]], index + delta >= 0, index + delta < entries.count,
                  let id = entries[index + delta]["id"] as? Int else { return }
            send("Page.navigateToHistoryEntry", ["entryId": id])
        }
    }

    func reload() { onInput?(); send("Page.reload") }

    func answerDialog(accept: Bool, text: String? = nil) {
        var p: [String: Any] = ["accept": accept]
        if let text { p["promptText"] = text }
        send("Page.handleJavaScriptDialog", p)
        dialog = nil
    }

    /// Resizes the page to the viewer. This changes the viewport for the
    /// agent too, so it is only done on explicit request.
    func fitViewport(to size: CGSize) {
        guard let cdp, let targetId else { return }
        Task {
            guard let w = try? await cdp.call("Browser.getWindowForTarget", ["targetId": targetId]),
                  let windowId = w["windowId"] as? Int else { return }
            let chromeHeight = 87.0
            cdp.send("Browser.setWindowBounds", ["windowId": windowId,
                                                  "bounds": ["width": Int(size.width), "height": Int(size.height + chromeHeight)]])
        }
    }

    // MARK: Input

    func mouse(_ type: String, x: Double, y: Double, button: String = "none", buttons: Int = 0,
               clickCount: Int = 0, modifiers: Int = 0, deltaX: Double = 0, deltaY: Double = 0) {
        var p: [String: Any] = ["type": type, "x": x, "y": y, "modifiers": modifiers, "button": button,
                                "buttons": buttons, "clickCount": clickCount]
        if type == "mouseWheel" { p["deltaX"] = deltaX; p["deltaY"] = deltaY }
        if type != "mouseMoved" { onInput?() }
        send("Input.dispatchMouseEvent", p)
    }

    func key(_ params: [String: Any]) {
        onInput?()
        send("Input.dispatchKeyEvent", params)
    }

    func insertText(_ text: String) {
        onInput?()
        send("Input.insertText", ["text": text])
    }

    func setComposition(_ text: String, selection: NSRange) {
        onInput?()
        send("Input.imeSetComposition", ["text": text, "selectionStart": selection.location,
                                          "selectionEnd": selection.location + selection.length])
    }

    func evaluate(_ expression: String) async -> Any? {
        let r = await call("Runtime.evaluate", ["expression": expression, "returnByValue": true, "awaitPromise": true])
        return (r?["result"] as? [String: Any])?["value"]
    }

    /// Selected text of the page, including selections inside form fields.
    func selectedText() async -> String? {
        let js = """
        (() => { const a = document.activeElement;
          if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number')
            return a.value.substring(a.selectionStart, a.selectionEnd);
          return String(getSelection() ?? ''); })()
        """
        let r = await call("Runtime.evaluate", ["expression": js, "returnByValue": true])
        return (r?["result"] as? [String: Any])?["value"] as? String
    }
}
