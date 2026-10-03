import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Package the approved artwork without replacing its texture, ring or glow.
// Run from the repository root: swift scripts/generate-vigil-icons.swift
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let sourceURL = root.appendingPathComponent("build/branding/vigil-ring-dot.png")
guard FileManager.default.fileExists(atPath: root.appendingPathComponent("package.json").path),
      let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil),
      artwork.width == artwork.height, artwork.width >= 1024 else {
    fatalError("Run from the repository root with the approved square artwork present.")
}

let palette: [String: (Double, Double, Double)] = [
    "selected": (20, 25, 25), "graphite": (38, 44, 57), "mist": (210, 226, 248)
]

// Simplify the same ring-and-dot silhouette for template and tiny icons.
// A minimum stroke/dot size keeps it visible after native 16/22px rendering.
func drawMark(_ context: CGContext, variant: String, pixelScale: CGFloat, tray: Bool) {
    let center = CGPoint(x: 512, y: tray ? 512 : 532)
    let radius: CGFloat = tray ? 370 : 317
    let mark: CGColor
    if tray { mark = CGColor(gray: 0, alpha: 1) }
    else if variant == "mist" { mark = CGColor(red: 0.12, green: 0.20, blue: 0.37, alpha: 1) }
    else if variant == "graphite" { mark = CGColor(gray: 1, alpha: 1) }
    else { mark = CGColor(red: 0.90, green: 0.83, blue: 0.68, alpha: 1) }
    context.setStrokeColor(mark)
    context.setFillColor(mark)
    context.setLineWidth(max(19.6, (tray ? 1.15 : 0.9) / pixelScale))
    context.setLineCap(.butt)
    context.beginPath()
    context.addArc(center: center, radius: radius, startAngle: .pi * 86 / 180,
                   endAngle: .pi * 27 / 180, clockwise: false)
    context.strokePath()
    context.saveGState()
    context.setAlpha(0.24)
    context.beginPath()
    context.addArc(center: center, radius: radius, startAngle: .pi * 77 / 180,
                   endAngle: .pi * 50 / 180, clockwise: true)
    context.strokePath()
    context.restoreGState()
    let angle: CGFloat = .pi * 43.6 / 180
    let dot = CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
    let dotRadius = max(33, (tray ? 1.05 : 0.8) / pixelScale)
    context.fillEllipse(in: CGRect(x: dot.x - dotRadius, y: dot.y - dotRadius,
                                  width: dotRadius * 2, height: dotRadius * 2))
}

func writeIcon(_ path: String, size: Int, variant: String = "selected", kind: String = "app") throws {
    let tray = kind == "tray"
    let phone = kind == "phone"
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let alpha: CGImageAlphaInfo = phone ? .noneSkipLast : .premultipliedLast
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: size * 4, space: colorSpace,
                            bitmapInfo: alpha.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    context.setAllowsAntialiasing(true)
    context.interpolationQuality = .high
    if tray {
        drawMark(context, variant: variant, pixelScale: CGFloat(size) / 1024, tray: true)
    } else {
        let inset: CGFloat = phone ? 0 : 80
        let rect = CGRect(x: inset, y: inset, width: 1024 - inset * 2, height: 1024 - inset * 2)
        context.saveGState()
        if !phone {
            context.addPath(CGPath(roundedRect: rect, cornerWidth: 190, cornerHeight: 190, transform: nil))
            context.clip()
        }
        let rgb = palette[variant]!
        context.setFillColor(CGColor(red: rgb.0 / 255, green: rgb.1 / 255, blue: rgb.2 / 255, alpha: 1))
        context.fill(rect)
        if variant == "selected" && size > 64 {
            context.draw(artwork, in: rect)
        } else {
            context.translateBy(x: rect.minX, y: rect.minY)
            context.scaleBy(x: rect.width / 1024, y: rect.height / 1024)
            drawMark(context, variant: variant,
                     pixelScale: CGFloat(size) / 1024 * rect.width / 1024, tray: false)
        }
        context.restoreGState()
    }
    let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "VigilIcons", code: 1) }
}

// Keep persisted appearance keys and migration mappings unchanged. The default
// blue key now selects the approved artwork; Graphite and Mist remain options.
for key in ["blue", "graphite", "mist"] {
    let variant = key == "blue" ? "selected" : key
    try writeIcon("public/app-icons/\(key).png", size: 1024, variant: variant)
    try writeIcon("public/app-icons/tray-\(key)Template.png", size: 22, kind: "tray")
    try writeIcon("public/app-icons/tray-\(key)Template@2x.png", size: 44, kind: "tray")
}
try writeIcon("build/icon.png", size: 1024)
try writeIcon("ios/VigilSocial/VigilSocial/Assets.xcassets/AppIcon.appiconset/icon.png", size: 1024, kind: "phone")
for size in [16, 32, 64, 128, 256, 512, 1024] {
    try writeIcon("macos/Vigil Safari/Vigil Safari/Assets.xcassets/AppIcon.appiconset/icon-\(size).png", size: size)
}
try writeIcon("macos/Vigil Safari/Vigil Safari/Resources/Icon.png", size: 256)

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("vigil-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }
for size in [16, 32, 128, 256, 512] {
    for retina in [false, true] {
        let filename = "icon_\(size)x\(size)\(retina ? "@2x" : "").png"
        try writeIcon(iconset.appendingPathComponent(filename).path, size: size * (retina ? 2 : 1))
    }
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["--convert", "icns", "--output", root.appendingPathComponent("build/icon.icns").path, iconset.path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("ICNS generation failed.") }
