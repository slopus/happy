#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The grouped sidebar's heading heights, measured off the main thread
/// from metrics: a new text size alone measures them again.
@MainActor
final class TabletGroupedHeightsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    func testANewTextSizeAloneMovesTheHeadingsWithoutNewRows() throws {
        let list = TabletGroupedList(
            ids: [.botsHeader, .machine("m"), .archiveToggle],
            rows: [.botsHeader, .machine(id: "m", name: "Studio"), .archiveToggle(hidden: true)],
            avatarStyle: .gradient,
            avatarMonochrome: false,
            offline: nil
        )
        let wake = ClockWake()
        defer { wake.cancel() }
        let large = TextEnvironment(scale: TextScale(.large), displayScale: 3)
        var input = TabletSidebarViewInput(width: 320, text: large)
        var state = TabletSidebarViewState()
        state.feeds.grouped = list
        let first = try XCTUnwrap(TabletGroupedHeights.derive(input, applied: state, wake: wake))
        XCTAssertNil(first.output.rows)
        XCTAssertEqual(first.output.headings.count, 3)
        XCTAssertEqual(first.output.moved, [])
        state = first.state
        // Nothing new: nothing for the main thread.
        XCTAssertNil(TabletGroupedHeights.derive(input, applied: state, wake: wake))
        input.text = TextEnvironment(scale: TextScale(.accessibilityExtraExtraExtraLarge), displayScale: 3)
        let larger = try XCTUnwrap(TabletGroupedHeights.derive(input, applied: state, wake: wake))
        XCTAssertNil(larger.output.rows)
        XCTAssertEqual(larger.output.moved, [.botsHeader, .machine("m"), .archiveToggle])
        for id in list.ids {
            XCTAssertGreaterThan(larger.output.headings.height(id) ?? 0, first.output.headings.height(id) ?? .infinity)
        }
    }
}
#endif
