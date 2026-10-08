import AppKit
import Carbon.HIToolbox
import HabitabCore
import SwiftUI

/// Shows screencast frames and translates mouse, scroll and keyboard input
/// into CDP Input events. Text input goes through NSTextInputClient, so dead
/// keys, Option combinations and input methods produce the right characters.
final class ScreencastNSView: NSView, NSTextInputClient {
    weak var viewer: PageViewer?
    var image: CGImage? { didSet { needsDisplay = true } }
    var frameMeta: PageViewer.FrameMeta?
    var onSizeChange: ((CGSize, CGFloat) -> Void)?
    var onShortcut: ((String) -> Void)?

    private var currentKeyEvent: NSEvent?
    private var keyHandledByText = false
    private var marked = ""
    private var lastMove = Date.distantPast
    private var pressedButtons = 0
    private var tracking: NSTrackingArea?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        // Since macOS 14 views do not clip by default; drawing must stay inside.
        clipsToBounds = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        onSizeChange?(newSize, window?.backingScaleFactor ?? 2)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onSizeChange?(bounds.size, window?.backingScaleFactor ?? 2)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    /// Rectangle where the page is drawn (aspect fit, top aligned).
    var pageRect: CGRect {
        guard let meta = frameMeta, meta.deviceWidth > 0, meta.deviceHeight > 0 else {
            guard let image else { return bounds }
            return fit(CGSize(width: image.width, height: image.height))
        }
        return fit(CGSize(width: meta.deviceWidth, height: meta.deviceHeight))
    }

    private func fit(_ content: CGSize) -> CGRect {
        let scale = min(bounds.width / content.width, bounds.height / content.height)
        let w = content.width * scale, h = content.height * scale
        return CGRect(x: (bounds.width - w) / 2, y: 0, width: w, height: h)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.underPageBackgroundColor.setFill()
        bounds.intersection(dirtyRect).fill()
        guard let image, let ctx = NSGraphicsContext.current?.cgContext else { return }
        let rect = pageRect
        ctx.saveGState()
        ctx.interpolationQuality = .high
        // Flipped view: draw the image upright.
        ctx.translateBy(x: rect.minX, y: rect.maxY)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(image, in: CGRect(origin: .zero, size: rect.size))
        ctx.restoreGState()
        NSColor.separatorColor.setStroke()
        NSBezierPath(rect: rect.insetBy(dx: -0.5, dy: -0.5)).stroke()
    }

    // MARK: Coordinates

    /// View point to page CSS pixels.
    private func pagePoint(_ event: NSEvent) -> (Double, Double)? {
        let p = convert(event.locationInWindow, from: nil)
        let rect = pageRect
        guard rect.width > 0, let meta = frameMeta, meta.deviceWidth > 0 else { return nil }
        let x = (p.x - rect.minX) / rect.width * meta.deviceWidth
        let y = (p.y - rect.minY) / rect.height * meta.deviceHeight
        return (min(max(x, 0), meta.deviceWidth - 1), min(max(y, 0), meta.deviceHeight - 1))
    }

    static func modifiers(_ flags: NSEvent.ModifierFlags) -> Int {
        var m = 0
        if flags.contains(.option) { m |= 1 }
        if flags.contains(.control) { m |= 2 }
        if flags.contains(.command) { m |= 4 }
        if flags.contains(.shift) { m |= 8 }
        return m
    }

    // MARK: Mouse

    private func mouse(_ type: String, _ event: NSEvent, button: String, bit: Int) {
        guard let (x, y) = pagePoint(event) else { return }
        if type == "mousePressed" { pressedButtons |= bit }
        if type == "mouseReleased" { pressedButtons &= ~bit }
        viewer?.mouse(type, x: x, y: y, button: button, buttons: type == "mouseReleased" ? pressedButtons : pressedButtons | (type == "mousePressed" ? bit : 0),
                      clickCount: event.clickCount, modifiers: Self.modifiers(event.modifierFlags))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        mouse("mousePressed", event, button: "left", bit: 1)
    }
    override func mouseUp(with event: NSEvent) { mouse("mouseReleased", event, button: "left", bit: 1) }
    override func rightMouseDown(with event: NSEvent) { mouse("mousePressed", event, button: "right", bit: 2) }
    override func rightMouseUp(with event: NSEvent) { mouse("mouseReleased", event, button: "right", bit: 2) }
    override func otherMouseDown(with event: NSEvent) { mouse("mousePressed", event, button: "middle", bit: 4) }
    override func otherMouseUp(with event: NSEvent) { mouse("mouseReleased", event, button: "middle", bit: 4) }

    override func mouseMoved(with event: NSEvent) { move(event) }
    override func mouseDragged(with event: NSEvent) { move(event) }
    override func rightMouseDragged(with event: NSEvent) { move(event) }

    private func move(_ event: NSEvent) {
        // At most ~60 move events per second.
        guard Date().timeIntervalSince(lastMove) > 0.016, let (x, y) = pagePoint(event) else { return }
        lastMove = Date()
        let button = pressedButtons & 1 != 0 ? "left" : pressedButtons & 2 != 0 ? "right" : "none"
        viewer?.mouse("mouseMoved", x: x, y: y, button: button, buttons: pressedButtons,
                      modifiers: Self.modifiers(event.modifierFlags))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let (x, y) = pagePoint(event) else { return }
        let factor: Double = event.hasPreciseScrollingDeltas ? 1 : 40
        let scale = frameMeta.map { $0.deviceWidth / max(pageRect.width, 1) } ?? 1
        viewer?.mouse("mouseWheel", x: x, y: y, modifiers: Self.modifiers(event.modifierFlags),
                      deltaX: -Double(event.scrollingDeltaX) * factor * scale,
                      deltaY: -Double(event.scrollingDeltaY) * factor * scale)
    }

    // MARK: Keyboard

    static let debug = ProcessInfo.processInfo.environment["HABITAB_DEBUG_INPUT"] == "1"

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if Self.debug { Log.write("keyEquivalent \(event.charactersIgnoringModifiers ?? "") fr=\(window?.firstResponder === self)") }
        guard window?.firstResponder === self, event.type == .keyDown,
              event.modifierFlags.contains(.command) else { return super.performKeyEquivalent(with: event) }
        let chars = event.charactersIgnoringModifiers?.lowercased() ?? ""
        let shift = event.modifierFlags.contains(.shift)
        switch chars {
        case "c": onShortcut?("copy"); return true
        case "x": onShortcut?("cut"); return true
        case "v": onShortcut?("paste"); return true
        case "a": sendCommandKey(event, commands: ["selectAll"]); return true
        case "z": sendCommandKey(event, commands: [shift ? "redo" : "undo"]); return true
        case "l": onShortcut?("focusURL"); return true
        case "r": onShortcut?("reload"); return true
        case "[": onShortcut?("back"); return true
        case "]": onShortcut?("forward"); return true
        default: break
        }
        if let special = Self.special[Int(event.keyCode)], let cmd = Self.commandEditing(special.code, event.modifierFlags) {
            sendKey(event, info: special, text: nil, commands: [cmd])
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        // Command shortcuts normally arrive via performKeyEquivalent; handle
        // them here too when an event is delivered straight to the view.
        if event.modifierFlags.contains(.command) {
            _ = performKeyEquivalent(with: event)
            return
        }
        currentKeyEvent = event
        keyHandledByText = false
        if event.modifierFlags.contains(.control), let info = Self.keyInfo(event) {
            sendKey(event, info: info, text: nil, commands: [])
        } else {
            interpretKeyEvents([event])
        }
        currentKeyEvent = nil
    }

    override func keyUp(with event: NSEvent) {
        guard let info = Self.keyInfo(event) else { return }
        viewer?.key(["type": "keyUp", "key": info.key, "code": info.code, "windowsVirtualKeyCode": info.vk,
                     "nativeVirtualKeyCode": Int(event.keyCode), "modifiers": Self.modifiers(event.modifierFlags)])
    }

    private func sendCommandKey(_ event: NSEvent, commands: [String]) {
        guard let info = Self.keyInfo(event) else { return }
        sendKey(event, info: info, text: nil, commands: commands)
    }

    private func sendKey(_ event: NSEvent, info: KeyInfo, text: String?, commands: [String]) {
        var p: [String: Any] = ["type": text == nil ? "rawKeyDown" : "keyDown", "key": text ?? info.key, "code": info.code,
                                "windowsVirtualKeyCode": info.vk, "nativeVirtualKeyCode": Int(event.keyCode),
                                "modifiers": Self.modifiers(event.modifierFlags), "autoRepeat": event.isARepeat]
        if let text { p["text"] = text; p["unmodifiedText"] = text }
        if !commands.isEmpty { p["commands"] = commands }
        if Self.debug { Log.write("key \(p)") }
        viewer?.key(p)
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        marked = ""
        if let event = currentKeyEvent, !keyHandledByText, text.count == 1, let info = Self.keyInfo(event) {
            keyHandledByText = true
            sendKey(event, info: info, text: text, commands: [])
        } else {
            viewer?.insertText(text)
        }
    }

    override func doCommand(by selector: Selector) {
        guard let event = currentKeyEvent, let info = Self.keyInfo(event) else { return }
        let name = NSStringFromSelector(selector)
        // Editing commands that Chrome on macOS receives from NSTextInputClient.
        let map: [String: String] = [
            "moveWordLeft:": "moveWordLeft", "moveWordRight:": "moveWordRight",
            "moveWordLeftAndModifySelection:": "moveWordLeftAndModifySelection",
            "moveWordRightAndModifySelection:": "moveWordRightAndModifySelection",
            "deleteWordBackward:": "deleteWordBackward", "deleteWordForward:": "deleteWordForward",
            "moveToBeginningOfParagraph:": "moveToBeginningOfParagraph", "moveToEndOfParagraph:": "moveToEndOfParagraph",
        ]
        let text = info.code == "Enter" || info.code == "NumpadEnter" ? "\r" : nil
        sendKey(event, info: info, text: text, commands: map[name].map { [$0] } ?? [])
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        marked = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        viewer?.setComposition(marked, selection: selectedRange)
    }

    func unmarkText() {
        if !marked.isEmpty { viewer?.insertText(marked) }
        marked = ""
    }

    func hasMarkedText() -> Bool { !marked.isEmpty }
    func markedRange() -> NSRange { marked.isEmpty ? NSRange(location: NSNotFound, length: 0) : NSRange(location: 0, length: marked.utf16.count) }
    func selectedRange() -> NSRange { NSRange(location: 0, length: 0) }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        window?.convertToScreen(convert(bounds, to: nil)) ?? .zero
    }

    // MARK: Key tables

    struct KeyInfo { var key: String; var code: String; var vk: Int }

    static func commandEditing(_ code: String, _ flags: NSEvent.ModifierFlags) -> String? {
        let shift = flags.contains(.shift)
        let suffix = shift ? "AndModifySelection" : ""
        switch code {
        case "ArrowLeft": return "moveToBeginningOfLine" + suffix
        case "ArrowRight": return "moveToEndOfLine" + suffix
        case "ArrowUp": return "moveToBeginningOfDocument" + suffix
        case "ArrowDown": return "moveToEndOfDocument" + suffix
        case "Backspace": return "deleteToBeginningOfLine"
        default: return nil
        }
    }

    static let special: [Int: KeyInfo] = [
        kVK_Return: KeyInfo(key: "Enter", code: "Enter", vk: 13),
        kVK_ANSI_KeypadEnter: KeyInfo(key: "Enter", code: "NumpadEnter", vk: 13),
        kVK_Tab: KeyInfo(key: "Tab", code: "Tab", vk: 9),
        kVK_Delete: KeyInfo(key: "Backspace", code: "Backspace", vk: 8),
        kVK_ForwardDelete: KeyInfo(key: "Delete", code: "Delete", vk: 46),
        kVK_Escape: KeyInfo(key: "Escape", code: "Escape", vk: 27),
        kVK_LeftArrow: KeyInfo(key: "ArrowLeft", code: "ArrowLeft", vk: 37),
        kVK_UpArrow: KeyInfo(key: "ArrowUp", code: "ArrowUp", vk: 38),
        kVK_RightArrow: KeyInfo(key: "ArrowRight", code: "ArrowRight", vk: 39),
        kVK_DownArrow: KeyInfo(key: "ArrowDown", code: "ArrowDown", vk: 40),
        kVK_Home: KeyInfo(key: "Home", code: "Home", vk: 36),
        kVK_End: KeyInfo(key: "End", code: "End", vk: 35),
        kVK_PageUp: KeyInfo(key: "PageUp", code: "PageUp", vk: 33),
        kVK_PageDown: KeyInfo(key: "PageDown", code: "PageDown", vk: 34),
        kVK_Space: KeyInfo(key: " ", code: "Space", vk: 32),
        kVK_F1: KeyInfo(key: "F1", code: "F1", vk: 112), kVK_F2: KeyInfo(key: "F2", code: "F2", vk: 113),
        kVK_F3: KeyInfo(key: "F3", code: "F3", vk: 114), kVK_F4: KeyInfo(key: "F4", code: "F4", vk: 115),
        kVK_F5: KeyInfo(key: "F5", code: "F5", vk: 116), kVK_F6: KeyInfo(key: "F6", code: "F6", vk: 117),
        kVK_F7: KeyInfo(key: "F7", code: "F7", vk: 118), kVK_F8: KeyInfo(key: "F8", code: "F8", vk: 119),
        kVK_F9: KeyInfo(key: "F9", code: "F9", vk: 120), kVK_F10: KeyInfo(key: "F10", code: "F10", vk: 121),
        kVK_F11: KeyInfo(key: "F11", code: "F11", vk: 122), kVK_F12: KeyInfo(key: "F12", code: "F12", vk: 123),
    ]

    static let letters: [Int: String] = [
        kVK_ANSI_A: "A", kVK_ANSI_B: "B", kVK_ANSI_C: "C", kVK_ANSI_D: "D", kVK_ANSI_E: "E", kVK_ANSI_F: "F",
        kVK_ANSI_G: "G", kVK_ANSI_H: "H", kVK_ANSI_I: "I", kVK_ANSI_J: "J", kVK_ANSI_K: "K", kVK_ANSI_L: "L",
        kVK_ANSI_M: "M", kVK_ANSI_N: "N", kVK_ANSI_O: "O", kVK_ANSI_P: "P", kVK_ANSI_Q: "Q", kVK_ANSI_R: "R",
        kVK_ANSI_S: "S", kVK_ANSI_T: "T", kVK_ANSI_U: "U", kVK_ANSI_V: "V", kVK_ANSI_W: "W", kVK_ANSI_X: "X",
        kVK_ANSI_Y: "Y", kVK_ANSI_Z: "Z",
    ]
    static let digits: [Int: Int] = [
        kVK_ANSI_0: 0, kVK_ANSI_1: 1, kVK_ANSI_2: 2, kVK_ANSI_3: 3, kVK_ANSI_4: 4,
        kVK_ANSI_5: 5, kVK_ANSI_6: 6, kVK_ANSI_7: 7, kVK_ANSI_8: 8, kVK_ANSI_9: 9,
    ]
    static let punctuation: [Int: (String, Int)] = [
        kVK_ANSI_Minus: ("Minus", 189), kVK_ANSI_Equal: ("Equal", 187), kVK_ANSI_LeftBracket: ("BracketLeft", 219),
        kVK_ANSI_RightBracket: ("BracketRight", 221), kVK_ANSI_Backslash: ("Backslash", 220),
        kVK_ANSI_Semicolon: ("Semicolon", 186), kVK_ANSI_Quote: ("Quote", 222), kVK_ANSI_Comma: ("Comma", 188),
        kVK_ANSI_Period: ("Period", 190), kVK_ANSI_Slash: ("Slash", 191), kVK_ANSI_Grave: ("Backquote", 192),
        kVK_ISO_Section: ("IntlBackslash", 226),
    ]

    /// DOM key/code/virtual key code for an event. `code` is the physical
    /// key (US layout names); `key` is the produced character.
    static func keyInfo(_ event: NSEvent) -> KeyInfo? {
        let kc = Int(event.keyCode)
        if let s = special[kc] { return s }
        let ch = event.charactersIgnoringModifiers ?? ""
        if let l = letters[kc] {
            return KeyInfo(key: ch.isEmpty ? l.lowercased() : ch, code: "Key\(l)", vk: Int(l.unicodeScalars.first!.value))
        }
        if let d = digits[kc] { return KeyInfo(key: ch.isEmpty ? "\(d)" : ch, code: "Digit\(d)", vk: 48 + d) }
        if let (code, vk) = punctuation[kc] { return KeyInfo(key: ch, code: code, vk: vk) }
        guard !ch.isEmpty else { return nil }
        return KeyInfo(key: ch, code: "", vk: 0)
    }
}

/// SwiftUI wrapper.
struct ScreencastView: NSViewRepresentable {
    @ObservedObject var viewer: PageViewer
    var onShortcut: (String) -> Void

    func makeNSView(context: Context) -> ScreencastNSView {
        let view = ScreencastNSView(frame: .zero)
        view.viewer = viewer
        view.onSizeChange = { [weak viewer] size, scale in
            Task { @MainActor in viewer?.setViewSize(size, scale: scale) }
        }
        return view
    }

    func updateNSView(_ view: ScreencastNSView, context: Context) {
        view.viewer = viewer
        view.frameMeta = viewer.frame
        view.image = viewer.image
        view.onShortcut = onShortcut
    }
}
