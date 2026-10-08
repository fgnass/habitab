import AppKit
import HabitabCore
import WebKit

/// Development check for the input path: sends real NSEvents through the
/// window (hit testing, NSTextInputClient, coordinate mapping) and reads the
/// result back from the page. Enabled with HABITAB_SELFTEST_INPUT=1; the
/// page needs elements #q (input) and #b (button) and #c (output).
@MainActor
enum InputSelfTest {
    static func runIfRequested() {
        guard ProcessInfo.processInfo.environment["HABITAB_SELFTEST_INPUT"] == "1" else { return }
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await run()
        }
    }

    static func find(_ view: NSView) -> ScreencastNSView? {
        if let v = view as? ScreencastNSView { return v }
        for sub in view.subviews { if let v = find(sub) { return v } }
        return nil
    }

    static func report(_ s: String) {
        Log.write("selftest: \(s)")
        let url = Paths.home.appendingPathComponent("selftest.txt")
        let line = s + "\n"
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
        else { try? line.write(to: url, atomically: true, encoding: .utf8) }
    }

    static func run() async {
        var found: (NSWindow, ScreencastNSView)?
        for _ in 0..<40 {
            NSApp.activate(ignoringOtherApps: true)
            if let w = NSApp.windows.first(where: { $0.contentView.flatMap(find)?.frameMeta != nil }), let v = w.contentView.flatMap(find) {
                found = (w, v); break
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        guard let (window, view) = found, let viewer = view.viewer else {
            report("FAIL no screencast view with frames"); return
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        func eval(_ js: String) async -> Any? {
            await viewer.evaluate(js)
        }
        func rect(_ sel: String) async -> CGRect? {
            guard let s = await eval("JSON.stringify(document.querySelector('\(sel)').getBoundingClientRect())") as? String,
                  let d = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Double] else { return nil }
            return CGRect(x: d["x"]!, y: d["y"]!, width: d["width"]!, height: d["height"]!)
        }
        /// CSS point -> window point (inverse of the view mapping).
        func windowPoint(css: CGPoint) -> NSPoint? {
            guard let meta = view.frameMeta, meta.deviceWidth > 0 else { return nil }
            let r = view.pageRect
            let p = NSPoint(x: r.minX + css.x / meta.deviceWidth * r.width, y: r.minY + css.y / meta.deviceHeight * r.height)
            return view.convert(p, to: nil)
        }
        func click(_ p: NSPoint, count: Int = 1) {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: 1) {
                    window.sendEvent(e)
                }
            }
        }
        func key(_ chars: String, keyCode: UInt16, flags: NSEvent.ModifierFlags = []) {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: window.windowNumber, context: nil, characters: chars,
                                            charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode) {
                    window.sendEvent(e)
                }
            }
        }
        func pause(_ ms: UInt64 = 300) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

        report("--- input selftest \(Date())")
        _ = await eval("document.getElementById('q').value=''; document.getElementById('c').textContent=''; window.n=0; scrollTo(0,0); 1")
        await pause(800)
        guard let b = await rect("#b"), let bp = windowPoint(css: CGPoint(x: b.midX, y: b.midY)) else {
            report("FAIL page elements not found"); return
        }

        click(bp); await pause()
        let c = await eval("document.getElementById('c').textContent") as? String ?? ""
        report("\(c.hasPrefix("Click 1") ? "PASS" : "FAIL") click maps to button (\(c))")

        // Measure after the click: the output text above moves the field.
        guard let q = await rect("#q"), let qp = windowPoint(css: CGPoint(x: q.midX, y: q.midY)) else {
            report("FAIL input not found"); return
        }
        click(qp); await pause()
        for (ch, code) in [("G", UInt16(5)), ("r", 15), ("ü", 33), ("ß", 27), ("e", 14), (" ", 49), ("@", 37)] {
            key(ch, keyCode: code)
        }
        await pause()
        let value = await eval("document.getElementById('q').value") as? String ?? ""
        report("\(value == "Grüße @" ? "PASS" : "FAIL") typing incl. umlauts (\(value))")

        key("\u{7F}", keyCode: 51); await pause()   // Backspace
        let afterBack = await eval("document.getElementById('q').value") as? String ?? ""
        report("\(afterBack == "Grüße " ? "PASS" : "FAIL") backspace (\(afterBack))")

        key("a", keyCode: 0, flags: .command); await pause()   // Cmd+A -> selectAll
        let sel = await eval("(() => { const a = document.activeElement; return a.selectionEnd - a.selectionStart })()") as? Int ?? -1
        report("\(sel == afterBack.count ? "PASS" : "FAIL") Cmd+A selects field (\(sel))")

        let text = await viewer.selectedText() ?? ""
        report("\(text == afterBack ? "PASS" : "FAIL") selected text for copy (\(text))")

        click(qp, count: 1); await pause()
        let before = await eval("scrollY") as? Double ?? 0
        if let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -300, wheel2: 0, wheel3: 0) {
            let loc = window.convertPoint(toScreen: qp)
            e.location = CGPoint(x: loc.x, y: (NSScreen.screens.first?.frame.height ?? 0) - loc.y)
            if let ns = NSEvent(cgEvent: e) { view.scrollWheel(with: ns) }
        }
        await pause(600)
        let after = await eval("scrollY") as? Double ?? 0
        report("\(after > before ? "PASS" : "FAIL") scroll wheel (\(before) -> \(after))")
        // DevTools frontend through the relay.
        if let tid = viewer.targetId, let port = viewer.debugPort,
           let url = DevToolsProxy.shared.frontendURL(chromePort: port, targetId: tid) {
            let web = DevToolsWindow.open(url: url, title: "DevTools selftest")
            try? await Task.sleep(nanoseconds: 7_000_000_000)
            let closed = (try? await web.evaluateJavaScript("document.body.innerText.includes('Debugging connection was closed')")) as? Bool ?? true
            report("\(closed ? "FAIL" : "PASS") DevTools frontend stays connected")
            if let img = try? await web.takeSnapshot(configuration: nil), let tiff = img.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: Paths.home.appendingPathComponent("selftest-devtools.png"))
            }
        }
        report("--- done")
    }
}
