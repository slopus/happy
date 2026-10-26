import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for a sidebar proposal in Prioritizing's chat
/// (`sidebar-proposal.css`).
final class StemCellSidebarProposalLayoutTests: XCTestCase {
    /// A section, a row with one under it, and a separator, at the phone
    /// sidebar's desktop half again: 9 + 42 + 3 + 48 + 3 + 48 + 3 + 26 + 9 tall.
    private let rows: [StemCellsSidebarLayout.Row] = [
        .init(kind: .section),
        .init(kind: .row),
        .init(kind: .row, depth: 1),
        .init(kind: .separator),
    ]

    func testAnOpenProposalHoldsItsAnswersAtTheRight() {
        let layout = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: false)))
        // 360 at most, 12 inside the hairline.
        XCTAssertEqual(layout.size, CGSize(width: 360, height: 279))
        XCTAssertEqual(layout.title, rect(12, 12, 104, 20))
        XCTAssertEqual(layout.version, rect(122, 12, 226, 20))
        XCTAssertEqual(layout.frame, rect(12, 40, 336, 191))
        XCTAssertEqual(layout.footer, rect(12, 239, 336, 28))
        // Each label padded 10 either side inside a 1pt ring, 8 apart.
        XCTAssertEqual(layout.use, rect(246, 239, 102, 28))
        XCTAssertEqual(layout.keep, rect(165, 239, 73, 28))
        XCTAssertNil(layout.notice)
        XCTAssertNil(layout.status)
    }

    func testANoticeTakesTheFootersLeftWithoutAddingALine() {
        let layout = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: true)))
        XCTAssertEqual(layout.notice, rect(12, 245, 145, 16))
        XCTAssertEqual(layout.size.height, 279)
    }

    func testAnsweringChangesOnlyTheLineUnderTheRows() {
        let open = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: false)))
        let answered = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .status))
        XCTAssertEqual(answered.size, open.size)
        XCTAssertEqual(answered.frame, open.frame)
        XCTAssertEqual(answered.status, rect(12, 245, 336, 16))
        XCTAssertNil(answered.keep)
        XCTAssertNil(answered.use)
    }

    func testANarrowColumnTakesTheCardAcross() {
        let layout = StemCellSidebarProposalLayout(width: 300, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: false)))
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 279))
        XCTAssertEqual(layout.frame, rect(12, 40, 276, 191))
        XCTAssertEqual(layout.use, rect(186, 239, 102, 28))
        XCTAssertEqual(layout.keep, rect(105, 239, 73, 28))
    }

    func testFoldingMovesOnlyWhatIsUnderTheRows() {
        let folded = StemCellSidebarProposalLayout(width: 400, input: .init(rows: [.init(kind: .section), .init(kind: .separator)], titleWidth: 103.4, footer: .status))
        // 12 + 56 + 4 + 34 + 12.
        XCTAssertEqual(folded.frame, rect(12, 40, 336, 89))
        XCTAssertEqual(folded.status, rect(12, 143, 336, 16))
        XCTAssertEqual(folded.size, CGSize(width: 360, height: 177))
    }

    func testTheMessagePlacesTheCardAtTheColumnsLeft() {
        let input = StemCellSidebarProposalLayout.Input(rows: rows, titleWidth: 103.4, footer: .status)
        let message = StemCellMessageLayout.agent(width: 400, parts: [.proposal(input)])
        guard case .proposal(let layout, let frame) = message.parts.first else { return XCTFail("no proposal") }
        XCTAssertEqual(frame, rect(16, 8, 360, 279))
        XCTAssertEqual(layout.size, frame.size)
        XCTAssertEqual(message.size, CGSize(width: 400, height: 295))
    }

    private func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}
