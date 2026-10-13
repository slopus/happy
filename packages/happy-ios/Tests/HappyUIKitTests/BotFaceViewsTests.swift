#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import ImageIO
import UIKit
import XCTest

@MainActor
final class BotFaceViewsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testAFaceIsPaintedAsA256PixelPNG() async throws {
        let data = try await BotFacePainter.png(seed: "k3x9a0b2")
        XCTAssertEqual(Array(data.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(image.width, 256)
        XCTAssertEqual(image.height, 256)
    }

    func testTheSameSeedPaintsTheSameFace() async throws {
        let first = try await BotFacePainter.png(seed: "g0000029")
        let again = try await BotFacePainter.png(seed: "g0000029")
        let other = try await BotFacePainter.png(seed: "g0000030")
        XCTAssertEqual(first, again)
        XCTAssertNotEqual(first, other)
    }

    func testThePickerRingsThePickedFaceAndReportsPresses() {
        let picker = BotFacePickerView(frame: CGRect(x: 0, y: 0, width: 333, height: 92))
        picker.seeds = ["a", "b", "c", "d"]
        picker.slot = 2
        picker.apply(BotFacePickerLayout(width: 333, text: picker.text))
        picker.layoutIfNeeded()

        let faces = picker.subviews.compactMap { $0 as? BotFaceButton }
        XCTAssertEqual(faces.map(\.accessibilityLabel), ["Face 1", "Face 2", "Face 3", "Face 4"])
        XCTAssertEqual(faces.map(\.isPicked), [false, false, true, false])
        XCTAssertEqual(faces[0].frame.size, CGSize(width: 52, height: 52))
        XCTAssertEqual(faces[0].layer.borderWidth, 2, "the ring is there whether picked or not")

        var picked: [Int] = []
        var rolled = 0
        picker.onPick = { picked.append($0) }
        picker.onRoll = { rolled += 1 }
        faces[3].sendActions(for: .touchUpInside)
        picker.subviews.compactMap { $0 as? BotFaceDieButton }.first?.sendActions(for: .touchUpInside)
        XCTAssertEqual(picked, [3])
        XCTAssertEqual(rolled, 1)
    }
}
#endif
