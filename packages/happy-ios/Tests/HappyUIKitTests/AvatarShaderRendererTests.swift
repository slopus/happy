#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The Metal port draws what the browser drew: at its phase each live
/// placeholder is its still picture, and it moves from there.
@MainActor
final class AvatarShaderRendererTests: XCTestCase {
    /// Both drawn `side` across into the same sRGB bytes, so the grain
    /// (random per pixel in each) averages out.
    static func pixels(_ image: CGImage, side: Int) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        let context = CGContext(
            data: &bytes, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        )!
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return bytes
    }

    /// The mean difference of each channel, 0...255.
    static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        var total = 0, count = 0
        for index in a.indices where index % 4 != 3 {
            total += abs(Int(a[index]) - Int(b[index]))
            count += 1
        }
        return Double(total) / Double(count)
    }

    static func still(_ index: Int) throws -> CGImage {
        let url = try XCTUnwrap(AvatarPlaceholderImages.url(AvatarPlaceholder.name(index)))
        return try XCTUnwrap(AvatarPlaceholderImages.decode(url, pixels: 384, scale: 1, monochrome: false)?.cgImage)
    }

    func testEveryPlaceholderStartsOnItsPicture() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        let side = 24
        var worst = (index: -1, difference: 0.0)
        var byEffect: [AvatarShader.Effect: [Double]] = [:]
        var sheet: [(CGImage, CGImage)] = []
        for index in 0..<AvatarPlaceholder.count {
            let live = try await XCTUnwrapAsync(await renderer.image(index: index, pixels: 384))
            let still = try Self.still(index)
            let difference = Self.difference(Self.pixels(live, side: side), Self.pixels(still, side: side))
            byEffect[AvatarShader.parameters(index).effect, default: []].append(difference)
            if difference > worst.difference { worst = (index, difference) }
            sheet.append((still, live))
        }
        for (effect, values) in byEffect.sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            print(String(format: "SHADER %@ mean %.2f max %.2f", "\(effect)", values.reduce(0, +) / Double(values.count), values.max() ?? 0))
        }
        print(String(format: "SHADER worst %d: %.2f", worst.index + 1, worst.difference))
        Self.saveSheet(sheet)
        XCTAssertLessThan(worst.difference, 3, "placeholder \(worst.index + 1) drifts from its picture")
    }

    /// The clock moves it: a second on, the frame is another.
    func testTheClockMovesIt() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        for index in [0, 45, 90, 130, 170] {
            let phase = AvatarShader.parameters(index).phase
            let start = try await XCTUnwrapAsync(await renderer.image(index: index, pixels: 96))
            let later = try await XCTUnwrapAsync(await renderer.image(index: index, pixels: 96, time: phase + 4))
            XCTAssertGreaterThan(Self.difference(Self.pixels(start, side: 24), Self.pixels(later, side: 24)), 1, "placeholder \(index + 1)")
        }
    }

    func testBlackAndWhiteIsGrey() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        let image = try await XCTUnwrapAsync(await renderer.image(index: 7, pixels: 48, monochrome: true))
        let bytes = Self.pixels(image, side: 12)
        for pixel in stride(from: 0, to: bytes.count, by: 4) {
            XCTAssertLessThanOrEqual(abs(Int(bytes[pixel]) - Int(bytes[pixel + 1])), 2)
            XCTAssertLessThanOrEqual(abs(Int(bytes[pixel + 1]) - Int(bytes[pixel + 2])), 2)
        }
    }

    /// Still and live side by side, for a person to look at, when
    /// HAPPY_PREVIEW_DIR is set.
    static func saveSheet(_ pairs: [(CGImage, CGImage)]) {
        guard let folder = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let cell = 64, columns = 20
        let rows = (pairs.count + columns / 2 - 1) / (columns / 2)
        let size = CGSize(width: cell * columns, height: cell * rows)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            for (index, pair) in pairs.enumerated() {
                let x = (index % (columns / 2)) * 2 * cell, y = (index / (columns / 2)) * cell
                for (offset, picture) in [pair.0, pair.1].enumerated() {
                    UIImage(cgImage: picture).draw(in: CGRect(x: x + offset * cell, y: y, width: cell, height: cell))
                }
            }
        }
        try? image.jpegData(compressionQuality: 0.9)?.write(to: URL(fileURLWithPath: folder).appendingPathComponent("live-vs-still.jpg"))
    }
}

/// XCTUnwrap for an async expression.
func XCTUnwrapAsync<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}
#endif
