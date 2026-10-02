import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Render the neutral Vigil identity directly from vector geometry.
// Run from the repository root: swift scripts/generate-vigil-icons.swift
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
guard FileManager.default.fileExists(atPath: root.appendingPathComponent("package.json").path) else {
    fatalError("Run the icon generator from the Vigil repository root.")
}
let palette: [String: (Double, Double, Double)] = [
    "blue": (49, 90, 232), "graphite": (38, 44, 57), "mist": (210, 226, 248)
]

func writeIcon(_ path: String, size: Int, variant: String = "blue", kind: String = "app") throws {
    let rgb = palette[variant]!
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let alpha: CGImageAlphaInfo = kind == "phone" ? .noneSkipLast : .premultipliedLast
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: size * 4, space: colorSpace,
                            bitmapInfo: alpha.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    context.setAllowsAntialiasing(true)
    let tray = kind == "tray"
    let phone = kind == "phone"
    if !tray {
        context.setFillColor(CGColor(red: rgb.0 / 255, green: rgb.1 / 255, blue: rgb.2 / 255, alpha: 1))
        let inset: CGFloat = phone ? 0 : (kind == "extension" ? 24 : 80)
        let rect = CGRect(x: inset, y: inset, width: 1024 - inset * 2, height: 1024 - inset * 2)
        if phone { context.fill(rect) }
        else { context.addPath(CGPath(roundedRect: rect, cornerWidth: 190, cornerHeight: 190, transform: nil)); context.fillPath() }
    }
    let darkMark = tray || variant == "mist"
    let mark = darkMark ? CGColor(red: 0.12, green: 0.20, blue: 0.37, alpha: 1) : CGColor(gray: 1, alpha: 1)
    context.setStrokeColor(mark)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    // The open circle and V are distinct and readable at menu-bar sizes.
    context.setLineWidth(tray ? 60 : 42)
    context.beginPath()
    context.addArc(center: CGPoint(x: 512, y: 512), radius: 277,
                   startAngle: CGFloat.pi * 0.23, endAngle: CGFloat.pi * 2.05, clockwise: false)
    context.strokePath()
    context.setLineWidth(tray ? 68 : 64)
    context.beginPath()
    context.move(to: CGPoint(x: 365, y: 572))
    context.addLine(to: CGPoint(x: 490, y: 390))
    context.addLine(to: CGPoint(x: 699, y: 688))
    context.strokePath()
    let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let image = context.makeImage()!
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "VigilIcons", code: 1) }
}

for variant in ["blue", "graphite", "mist"] {
    try writeIcon("public/app-icons/\(variant).png", size: 1024, variant: variant)
    try writeIcon("public/app-icons/tray-\(variant)Template.png", size: 22, variant: variant, kind: "tray")
    try writeIcon("public/app-icons/tray-\(variant)Template@2x.png", size: 44, variant: variant, kind: "tray")
}
try writeIcon("build/icon.png", size: 1024)
try writeIcon("ios/VigilSocial/VigilSocial/Assets.xcassets/AppIcon.appiconset/icon.png", size: 1024, kind: "phone")
for size in [16, 32, 48, 128] {
    try writeIcon("extension/icons/icon-\(size).png", size: size, kind: "extension")
    try writeIcon("ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/icons/icon-\(size).png", size: size, kind: "extension")
}
try writeIcon("ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/icons/toolbar.png", size: 48, kind: "tray")
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
