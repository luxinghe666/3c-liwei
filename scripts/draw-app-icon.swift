import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let size = 1024
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.035, green: 0.12, blue: 0.22, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
// Three accounting columns and an ascending path; drawn as vector geometry.
for (index, height) in [230, 355, 500].enumerated() {
    context.setFillColor(CGColor(red: 0.25, green: 0.72, blue: 0.87, alpha: 1))
    context.addPath(CGPath(roundedRect: CGRect(x: 205 + index * 210, y: 230, width: 145, height: height), cornerWidth: 24, cornerHeight: 24, transform: nil))
    context.fillPath()
}
context.move(to: CGPoint(x: 180, y: 690)); context.addLine(to: CGPoint(x: 415, y: 770)); context.addLine(to: CGPoint(x: 565, y: 760)); context.addLine(to: CGPoint(x: 800, y: 870))
context.setLineWidth(38); context.setLineCap(.round); context.setLineJoin(.round)
context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); context.strokePath()
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write app icon") }
