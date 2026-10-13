import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class DesignTokenTests: XCTestCase {
    func testHexParsing() {
        XCTAssertEqual(RGBA(hex: "#FF0000"), RGBA(red: 1, green: 0, blue: 0))
        XCTAssertEqual(RGBA(hex: "00ff00"), RGBA(red: 0, green: 1, blue: 0))
        XCTAssertEqual(RGBA(hex: "#fff"), .white)
        XCTAssertEqual(RGBA(hex: "#00000080")?.alpha ?? 0, 128.0 / 255, accuracy: 0.0001)
        XCTAssertNil(RGBA(hex: "#12345"))
        XCTAssertNil(RGBA(hex: "#GGGGGG"))
    }

    func testEveryTokenParsed() {
        let magenta = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in Palette.all {
            XCTAssertNotEqual(token.light, magenta)
            XCTAssertNotEqual(token.dark, magenta)
        }
    }

    func testThemeValuesFromHappyApp() {
        XCTAssertEqual(Palette.groupedBackground, ColorToken(light: RGBA(hex: "#F2F2F7")!, dark: .black))
        XCTAssertEqual(Palette.textDestructive.dark, RGBA(hex: "#FF453A"))
        XCTAssertEqual(Palette.surface.dark, RGBA(hex: "#161616"))
        XCTAssertEqual(Palette.roundButtonFill.dark, RGBA(hex: "#F5F5F5"))
        XCTAssertEqual(Palette.itemDivider.light.alpha, 0.12)
    }

    func testRoundButtonTextStyles() {
        XCTAssertEqual(TextStyles.roundButton(.large, display: .filled), TextStyle(.semiBold, size: 17, lineHeight: 22))
        XCTAssertEqual(TextStyles.roundButton(.normal, display: .inverted), TextStyle(.regular, size: 15, lineHeight: 20))
    }

    /// Every face the tokens name ships in HappyUI's resources.
    func testBundledFontFilesExist() {
        let fonts = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../Sources/HappyUI/Resources/Fonts")
            .standardizedFileURL
        for face in FontFace.allCases {
            let path = fonts.appendingPathComponent(face.fileName).path
            XCTAssertTrue(FileManager.default.fileExists(atPath: path), "missing \(path)")
        }
    }
}

final class VectorPathTests: XCTestCase {
    func testAbsoluteCommands() throws {
        let path = try VectorPath(svg: "M0 0H10V10L0 10Z")
        XCTAssertEqual(path.elements, [
            .move(CGPoint(x: 0, y: 0)),
            .line(CGPoint(x: 10, y: 0)),
            .line(CGPoint(x: 10, y: 10)),
            .line(CGPoint(x: 0, y: 10)),
            .close,
        ])
    }

    func testRelativeCommandsAndImplicitLines() throws {
        let path = try VectorPath(svg: "m1 1 2 0l0 2h-2v-2z")
        XCTAssertEqual(path.elements, [
            .move(CGPoint(x: 1, y: 1)),
            .line(CGPoint(x: 3, y: 1)),
            .line(CGPoint(x: 3, y: 3)),
            .line(CGPoint(x: 1, y: 3)),
            .line(CGPoint(x: 1, y: 1)),
            .close,
        ])
    }

    func testCurvesRepeatImplicitly() throws {
        let path = try VectorPath(svg: "M0 0Q5 5 10 0 15 -5 20 0C1 2 3 4 5 6")
        XCTAssertEqual(path.elements, [
            .move(.zero),
            .quadCurve(to: CGPoint(x: 10, y: 0), control: CGPoint(x: 5, y: 5)),
            .quadCurve(to: CGPoint(x: 20, y: 0), control: CGPoint(x: 15, y: -5)),
            .curve(to: CGPoint(x: 5, y: 6), control1: CGPoint(x: 1, y: 2), control2: CGPoint(x: 3, y: 4)),
        ])
    }

    func testCompactNumbers() throws {
        let path = try VectorPath(svg: "M1.5.5L3-4L1e1,2E-1")
        XCTAssertEqual(path.elements, [
            .move(CGPoint(x: 1.5, y: 0.5)),
            .line(CGPoint(x: 3, y: -4)),
            .line(CGPoint(x: 10, y: 0.2)),
        ])
    }

    func testRejectsWhatItCannotDraw() {
        XCTAssertThrowsError(try VectorPath(svg: "M0 0A1 1 0 0 1 2 2")) { error in
            XCTAssertEqual(error as? VectorPathError, .unsupportedCommand("A"))
        }
        XCTAssertThrowsError(try VectorPath(svg: "M0")) { error in
            XCTAssertEqual(error as? VectorPathError, .missingNumber(command: "M"))
        }
        XCTAssertThrowsError(try VectorPath(svg: "10 10"))
    }

    func testWordmarkParsesInsideItsViewBox() throws {
        let happy = try VectorPath(svg: Wordmark.happyPath)
        let engineering = try VectorPath(svg: Wordmark.engineeringPath)
        XCTAssertGreaterThan(happy.elements.count, 100)
        XCTAssertGreaterThan(engineering.elements.count, 300)
        XCTAssertEqual(Wordmark.graphic.layers.map(\.path), [happy, engineering])
        let bounds = happy.controlBounds.union(engineering.controlBounds)
        XCTAssertTrue(Wordmark.viewBox.contains(bounds), "\(bounds)")
        // The view box starts at the top of "Happy" and ends at the bottom of
        // the g in "Engineering".
        XCTAssertEqual(bounds.minY, -700)
        XCTAssertEqual(bounds.maxY, 1232)
    }

    func testWordmarkFitsItsLayoutFrame() {
        let frame = CGRect(origin: CGPoint(x: 10, y: 20), size: WordmarkMetrics.size())
        let layers = Wordmark.graphic.fitted(into: frame)
        let bounds = layers.map(\.path.controlBounds).reduce(CGRect.null) { $0.union($1) }
        XCTAssertGreaterThanOrEqual(bounds.minX, frame.minX - 0.001)
        XCTAssertLessThanOrEqual(bounds.maxX, frame.maxX + 0.001)
        XCTAssertEqual(bounds.minY, frame.minY, accuracy: 0.1)
        XCTAssertEqual(bounds.maxY, frame.maxY, accuracy: 0.1)
        XCTAssertEqual(layers.map(\.color), [Palette.wordmarkHappy, Palette.wordmarkEngineering])
    }
}
