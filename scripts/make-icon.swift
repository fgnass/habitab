// Renders the Habitab app icon into an .iconset directory.
//   swift scripts/make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

let amberTop = 0xFFB547 as UInt32, amberBottom = 0xE36A1E as UInt32, ember = 0x7A3206 as UInt32

// All geometry uses a 1024 grid with y pointing down (the design canvas's SVG coordinates).
func tile() -> CGPath {
    CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 185, cornerHeight: 185, transform: nil)
}

// The page below the tab strip, following the tile's rounded bottom corners.
func page() -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 100, y: 730))
    p.addLine(to: CGPoint(x: 924, y: 730))
    p.addLine(to: CGPoint(x: 924, y: 739))
    p.addArc(tangent1End: CGPoint(x: 924, y: 924), tangent2End: CGPoint(x: 739, y: 924), radius: 185)
    p.addLine(to: CGPoint(x: 285, y: 924))
    p.addArc(tangent1End: CGPoint(x: 100, y: 924), tangent2End: CGPoint(x: 100, y: 739), radius: 185)
    p.closeSubpath()
    return p
}

// A browser tab with a gable roof; its flared feet run into the page.
// It reaches below the page edge: two shapes that only touch show a seam.
func house() -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 202, y: 760))
    p.addLine(to: CGPoint(x: 202, y: 730))
    p.addCurve(to: CGPoint(x: 262, y: 680), control1: CGPoint(x: 236, y: 730), control2: CGPoint(x: 262, y: 712))
    p.addLine(to: CGPoint(x: 262, y: 486))
    p.addQuadCurve(to: CGPoint(x: 278, y: 454), control: CGPoint(x: 262, y: 466))
    p.addLine(to: CGPoint(x: 490, y: 290))
    p.addQuadCurve(to: CGPoint(x: 534, y: 290), control: CGPoint(x: 512, y: 273))
    p.addLine(to: CGPoint(x: 746, y: 454))
    p.addQuadCurve(to: CGPoint(x: 762, y: 486), control: CGPoint(x: 762, y: 466))
    p.addLine(to: CGPoint(x: 762, y: 680))
    p.addCurve(to: CGPoint(x: 822, y: 730), control1: CGPoint(x: 762, y: 712), control2: CGPoint(x: 788, y: 730))
    p.addLine(to: CGPoint(x: 822, y: 760))
    p.closeSubpath()
    return p
}

func render(_ px: Int) -> Data {
    let s = CGFloat(px), k = s / 1024
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.translateBy(x: 0, y: s)
    ctx.scaleBy(x: k, y: -k)

    // Fills `path` with a vertical gradient running from y0 to y1.
    func fill(_ path: CGPath, _ stops: [(CGFloat, CGColor)], _ y0: CGFloat, _ y1: CGFloat) {
        let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: stops.map { $0.1 } as CFArray,
                           locations: stops.map { $0.0 })!
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: y0), end: CGPoint(x: 0, y: y1),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        ctx.restoreGState()
    }

    // Amber tile with a soft warm shadow. Shadow offsets are in device space (y up).
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -18 * k), blur: 26 * k, color: color(0x502305, 0.30))
    ctx.addPath(tile())
    ctx.setFillColor(color(amberBottom))
    ctx.fillPath()
    ctx.restoreGState()
    fill(tile(), [(0, color(amberTop)), (1, color(amberBottom))], 100, 924)

    // Sheen on the upper part of the tile.
    ctx.saveGState()
    ctx.addPath(tile())
    ctx.clip()
    fill(CGPath(rect: CGRect(x: 100, y: 100, width: 824, height: 320), transform: nil),
         [(0, color(0xFFFFFF, 0.16)), (1, color(0xFFFFFF, 0))], 100, 420)
    ctx.restoreGState()

    // House and page, lifted off the tile by one shared shadow.
    let paper: [(CGFloat, CGColor)] = [(0, color(0xFFFFFF)), (0.6, color(0xFBF1E6)), (1, color(0xF2DCC6))]
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12 * k), blur: 32 * k, color: color(ember, 0.45))
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    fill(page(), paper, 280, 924)
    fill(house(), paper, 280, 924)
    ctx.endTransparencyLayer()
    ctx.restoreGState()

    // The opening: dark at the top like an inner shadow.
    fill(CGPath(ellipseIn: CGRect(x: 452, y: 500, width: 120, height: 120), transform: nil),
         [(0, color(ember)), (1, color(amberTop))], 500, 620)

    // Light rim along the top edge of the tile.
    let rim = CGPath(roundedRect: CGRect(x: 102, y: 102, width: 820, height: 820), cornerWidth: 183, cornerHeight: 183, transform: nil)
        .copy(strokingWithWidth: 4, lineCap: .butt, lineJoin: .round, miterLimit: 10)
    fill(rim, [(0, color(0xFFFFFF, 0.55)), (0.35, color(0xFFFFFF, 0.08)), (1, color(0xFFFFFF, 0))], 100, 924)

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: out.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: out.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
