import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact slots for home's grouped list on UltraList: they tile the content
/// with no gap, each row's box lands where the grouped layout puts it, and
/// separators have none.
final class SidebarListSlotsTests: XCTestCase {
    private func grouped(_ rows: [SidebarLayout.Row], width: CGFloat = 390) -> SidebarLayout.Result {
        SidebarLayout.layout(rows, width: width, top: GroupedSidebarMetrics.contentTop, bottom: GroupedSidebarMetrics.contentBottom, scale: 3, style: .grouped)
    }

    /// Home's own shapes: a card, a separator, a card with a nested row,
    /// two separators running (an empty section), and the last card.
    func testSlotsTileTheContent() {
        let rows: [SidebarLayout.Row] = [
            .init(kind: .row),
            .init(kind: .row),
            .init(kind: .separator, hasMark: false),
            .init(kind: .row),
            .init(kind: .row, depth: 1, hasMark: false),
            .init(kind: .separator, hasMark: false),
            .init(kind: .separator, hasMark: false),
            .init(kind: .row, hasTrailing: true),
        ]
        let result = grouped(rows)
        let slots = SidebarLayout.slots(rows, result, width: 390)
        XCTAssertEqual(slots.map(\.row), [0, 1, 3, 4, 7])
        XCTAssertEqual(slots.map(\.frame), [
            // The room above the first card is the first row's.
            CGRect(x: 0, y: 0, width: 390, height: 56),
            CGRect(x: 0, y: 56, width: 390, height: 48),
            // Settings' 24 between the cards, above the next card's first row.
            CGRect(x: 0, y: 104, width: 390, height: 72),
            CGRect(x: 0, y: 176, width: 390, height: 48),
            // The second separator, after nothing, adds nothing.
            CGRect(x: 0, y: 224, width: 390, height: 72 + GroupedSidebarMetrics.contentBottom),
        ])
        XCTAssertEqual(slots.map(\.box), [
            CGRect(x: 16, y: 8, width: 358, height: 48),
            CGRect(x: 16, y: 0, width: 358, height: 48),
            CGRect(x: 16, y: 24, width: 358, height: 48),
            CGRect(x: 16, y: 0, width: 358, height: 48),
            CGRect(x: 16, y: 24, width: 358, height: 48),
        ])
        // Every box is the layout's, moved into its slot.
        for slot in slots {
            XCTAssertEqual(slot.box.offsetBy(dx: 0, dy: slot.frame.minY), result.frames[slot.row].box)
        }
        XCTAssertEqual(slots.last?.frame.maxY, result.contentHeight)
    }

    /// A heading's slot holds the gap under the card before it and its own
    /// 36; the card's first row starts right under it.
    func testAHeadingHoldsTheGapAboveIt() {
        let rows: [SidebarLayout.Row] = [
            .init(kind: .row),
            .init(kind: .section, hasMark: false),
            .init(kind: .row),
        ]
        let result = grouped(rows)
        let slots = SidebarLayout.slots(rows, result, width: 390)
        XCTAssertEqual(slots.map(\.frame), [
            CGRect(x: 0, y: 0, width: 390, height: 56),
            CGRect(x: 0, y: 56, width: 390, height: 14 + 36),
            CGRect(x: 0, y: 106, width: 390, height: 48 + 24),
        ])
        XCTAssertEqual(slots[1].box, CGRect(x: 16, y: 14, width: 358, height: 36))
        let heading = SidebarLayout.local(result.frames[1], top: slots[1].frame.minY)
        XCTAssertEqual(heading.box, slots[1].box)
        XCTAssertEqual(heading.label, CGRect(x: 32, y: 14 + 36 - 7 - 18, width: heading.label.width, height: 18))
    }

    /// A row keeps its frames, moved by the slot's top alone.
    func testLocalMovesEveryFrame() {
        let rows: [SidebarLayout.Row] = [
            .init(kind: .row),
            .init(kind: .row, hasWorkingSignal: true, hasFold: true),
        ]
        let result = grouped(rows)
        let slots = SidebarLayout.slots(rows, result, width: 390)
        let content = result.frames[1]
        let local = SidebarLayout.local(content, top: slots[1].frame.minY)
        let dy = -slots[1].frame.minY
        XCTAssertEqual(local.box, content.box.offsetBy(dx: 0, dy: dy))
        XCTAssertEqual(local.mark, content.mark?.offsetBy(dx: 0, dy: dy))
        XCTAssertEqual(local.label, content.label.offsetBy(dx: 0, dy: dy))
        XCTAssertEqual(local.chevron, content.chevron?.offsetBy(dx: 0, dy: dy))
        XCTAssertEqual(local.chevronGlyph, content.chevronGlyph?.offsetBy(dx: 0, dy: dy))
        XCTAssertNotNil(content.corner)
        XCTAssertEqual(local.corner, content.corner?.offsetBy(dx: 0, dy: dy))
        XCTAssertEqual(local.cell?.separator, nil)
        XCTAssertEqual(slots[0].box.maxY, 56)
        XCTAssertEqual(local.box.minY, 0)
    }

    func testNoRowsNoSlots() {
        let rows: [SidebarLayout.Row] = [.init(kind: .separator, hasMark: false)]
        XCTAssertEqual(SidebarLayout.slots(rows, grouped(rows), width: 390), [])
    }
}
