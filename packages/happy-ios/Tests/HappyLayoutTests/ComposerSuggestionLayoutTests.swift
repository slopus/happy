import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// AgentInputSuggestionView.tsx's rows.
final class ComposerSuggestionRowLayoutTests: XCTestCase {
    func testACommandAndItsDescription() {
        let layout = ComposerSuggestionRowLayout(
            width: 361,
            input: .command(name: CGSize(width: 70, height: 17), description: CGSize(width: 400, height: 16))
        )
        XCTAssertEqual(layout.size, CGSize(width: 361, height: 48))
        assertFrame(layout.name, rect(16, 15.5, 70, 17))
        // 16 + 70 + 12 = 98, to 345.
        assertFrame(layout.description, rect(98, 16, 247, 16))
        XCTAssertNil(layout.icon)
    }

    func testACommandWithoutADescription() {
        let layout = ComposerSuggestionRowLayout(width: 361, input: .command(name: CGSize(width: 50, height: 17), description: nil))
        assertFrame(layout.name, rect(16, 15.5, 50, 17))
        XCTAssertNil(layout.description)
    }

    func testALongCommandStopsAtThePadding() {
        let layout = ComposerSuggestionRowLayout(
            width: 200,
            input: .command(name: CGSize(width: 300, height: 17), description: CGSize(width: 40, height: 16))
        )
        assertFrame(layout.name, rect(16, 15.5, 168, 17))
        assertFrame(layout.description, rect(196, 16, 0, 16))
    }

    func testAFile() {
        let layout = ComposerSuggestionRowLayout(
            width: 361,
            input: .file(path: CGSize(width: 500, height: 17), label: CGSize(width: 28, height: 14.5))
        )
        assertFrame(layout.icon, rect(16, 8, 32, 32))
        assertFrame(layout.iconGlyph, rect(23, 15, 18, 18))
        // 16 + 32 + 12 = 60; the label is 28 wide 8 in from 345.
        assertFrame(layout.path, rect(60, 15.5, 249, 17))
        assertFrame(layout.label, rect(317, 16.75, 28, 14.5))
    }

    func testAShortPathStillTakesTheRoom() {
        let layout = ComposerSuggestionRowLayout(
            width: 361,
            input: .file(path: CGSize(width: 40, height: 17), label: CGSize(width: 50, height: 14.5))
        )
        assertFrame(layout.path, rect(60, 15.5, 227, 17))
        assertFrame(layout.label, rect(295, 16.75, 50, 14.5))
    }

    func testTheListsRows() {
        let rows = ComposerSuggestionListLayout.rows(count: 3, width: 361, border: 0.5)
        XCTAssertEqual(rows.count, 3)
        assertFrame(rows[0], rect(0, 0, 360, 48))
        assertFrame(rows[2], rect(0, 96, 360, 48))
        XCTAssertTrue(ComposerSuggestionListLayout.rows(count: 0, width: 361, border: 0.5).isEmpty)
    }
}
