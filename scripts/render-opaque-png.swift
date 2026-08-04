#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: render-opaque-png.swift <input> <output>\n".utf8))
    exit(64)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard
    let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
        data: nil,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: image.width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    )
else {
    FileHandle.standardError.write(Data("unable to decode \(inputURL.path)\n".utf8))
    exit(65)
}

context.interpolationQuality = .high
context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))

guard
    let opaqueImage = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(
        outputURL as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    )
else {
    FileHandle.standardError.write(Data("unable to create \(outputURL.path)\n".utf8))
    exit(73)
}

CGImageDestinationAddImage(destination, opaqueImage, nil)
guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write(Data("unable to write \(outputURL.path)\n".utf8))
    exit(74)
}
