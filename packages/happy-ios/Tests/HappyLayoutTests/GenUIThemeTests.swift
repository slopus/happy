import Foundation
@testable import HappyLayout
import XCTest

/// The shared Gen UI theme the app bundles reads whole, and every icon it
/// names ships at all three scales.
final class GenUIThemeTests: XCTestCase {
    private var resources: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/HappyUI/Resources/GenUI")
    }

    private func bundledTheme() throws -> GenUITheme {
        try XCTUnwrap(GenUITheme.parse(Data(contentsOf: resources.appendingPathComponent("genui-theme.json"))))
    }

    func testTheBundledThemeReadsWhole() throws {
        let theme = try bundledTheme()
        XCTAssertEqual(Set(theme.ink.keys), Set(GenUITheme.tones + theme.colors))
        XCTAssertEqual(Set(theme.fill.keys), Set(GenUITheme.tones + theme.colors))
        XCTAssertEqual(Set(theme.text.keys), Set(GenUITheme.tones + theme.colors))
        XCTAssertEqual(theme.markers, ["done": "success", "failed": "danger", "active": "accent", "pending": "muted"])
        XCTAssertEqual(theme.ink["neutral"]?.light, RGBA(hex: "#000000"))
        XCTAssertEqual(theme.palette.count, 8)
        XCTAssertEqual(theme.ink["accent"], ColorToken(light: RGBA(hex: "#007AFF")!, dark: RGBA(hex: "#0A84FF")!))
        // Alpha comes last.
        XCTAssertEqual(theme.fill["accent"]?.light.alpha ?? 0, 0x1F / 255, accuracy: 0.0001)
        XCTAssertEqual(theme.muted.dark, RGBA(hex: "#48484A"))
    }

    func testRawColoursReadLikeTones() throws {
        let theme = try bundledTheme()
        XCTAssertEqual(theme.colors, ["blue", "brown", "cyan", "gray", "green", "indigo", "orange", "pink", "purple", "red", "teal", "yellow"])
        for name in theme.colors {
            XCTAssertNotNil(theme.ink[name], name)
            XCTAssertNotNil(theme.fill[name], name)
        }
    }

    func testPlotColoursWrapRoundThePalette() throws {
        let theme = try bundledTheme()
        XCTAssertEqual(theme.series(1), theme.palette[0])
        XCTAssertEqual(theme.series(9), theme.palette[0])
        XCTAssertEqual(theme.series(0), theme.palette[7])
    }

    func testEveryIconShipsAtEveryScale() throws {
        let theme = try bundledTheme()
        XCTAssertEqual(theme.icons.count, 39)
        for name in theme.icons {
            for suffix in ["", "@2x", "@3x"] {
                let file = resources.appendingPathComponent("Icons/genui-\(name)\(suffix).png")
                XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), file.lastPathComponent)
            }
        }
    }

    func testAThemeMissingAToneIsRejected() {
        let json = ##"{"tones": {"neutral": {"ink": {"light": "#000000", "dark": "#ffffff"}, "fill": {"light": "#000000", "dark": "#ffffff"}}}, "chart": {}}"##
        XCTAssertNil(GenUITheme.parse(Data(json.utf8)))
    }
}
