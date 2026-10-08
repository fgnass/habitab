// Renders the Habitab app icon into an .iconset directory.
//   swift Tools/make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext

    // Squircle-ish background with the macOS icon margin.
    let inset = s * 0.1
    let body = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let bg = NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.01), blur: s * 0.03, color: NSColor.black.withAlphaComponent(0.35).cgColor)
    NSGradient(colors: [NSColor(calibratedRed: 0.13, green: 0.17, blue: 0.32, alpha: 1),
                        NSColor(calibratedRed: 0.24, green: 0.33, blue: 0.62, alpha: 1)])!.draw(in: bg, angle: 90)
    ctx.restoreGState()

    // A house whose roof is a row of browser tabs.
    let u = body.width / 10
    let ox = body.minX, oy = body.minY
    func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: ox + x * u, y: oy + y * u, width: w * u, height: h * u) }

    let tabColors = [NSColor(calibratedRed: 1.0, green: 0.62, blue: 0.30, alpha: 1),
                     NSColor(calibratedRed: 0.36, green: 0.85, blue: 0.80, alpha: 1),
                     NSColor(calibratedRed: 0.98, green: 0.85, blue: 0.35, alpha: 1)]
    // Roof: three tabs, stepped like a gable.
    let tabs = [r(2.0, 6.0, 2.0, 1.0), r(4.0, 6.7, 2.0, 1.0), r(6.0, 6.0, 2.0, 1.0)]
    for (i, t) in tabs.enumerated() {
        let p = NSBezierPath(roundedRect: t, xRadius: u * 0.3, yRadius: u * 0.3)
        tabColors[i].setFill()
        p.fill()
    }
    // House body = browser window.
    let window = r(2.0, 2.0, 6.0, 4.3)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: window, xRadius: u * 0.45, yRadius: u * 0.45).fill()
    // Content lines.
    NSColor(calibratedRed: 0.24, green: 0.33, blue: 0.62, alpha: 0.35).setFill()
    for (i, w) in [3.6, 2.6, 3.1].enumerated() {
        NSBezierPath(roundedRect: r(2.7, 5.0 - CGFloat(i) * 0.75, CGFloat(w), 0.35), xRadius: u * 0.17, yRadius: u * 0.17).fill()
    }
    // Door.
    NSColor(calibratedRed: 0.13, green: 0.17, blue: 0.32, alpha: 1).setFill()
    NSBezierPath(roundedRect: r(5.6, 2.0, 1.4, 1.9), xRadius: u * 0.3, yRadius: u * 0.3).fill()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: out.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: out.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
