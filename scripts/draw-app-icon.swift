import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// Export the approved master artwork; never redraw the previous chart icon.
guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: swift scripts/draw-app-icon.swift <output.png>")
}
let master = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("appstore/brand/app-icon-master.png")
guard let source = CGImageSourceCreateWithURL(master as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil),
      artwork.width == artwork.height else {
    fatalError("Cannot read square master artwork: \(master.path)")
}
let size = 1024
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.interpolationQuality = .high
context.draw(artwork, in: CGRect(x: 0, y: 0, width: size, height: size))
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write app icon") }
