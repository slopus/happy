import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for a sidebar proposal in Prioritizing's chat
/// (`sidebar-proposal.css`).
final class StemCellSidebarProposalLayoutTests: XCTestCase {
    /// A section, a row with one under it, and a separator: 6 + 28 + 2 + 32
    /// + 2 + 32 + 2 + 17 + 6 tall.
    private let rows: [StemCellsSidebarLayout.Row] = [
        .init(kind: .section),
        .init(kind: .row),
        .init(kind: .row, depth: 1),
        .init(kind: .separator),
    ]

    func testAnOpenProposalHoldsItsAnswersAtTheRight() {
        let layout = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: false)))
        // 360 at most, 12 inside the hairline.
        XCTAssertEqual(layout.size, CGSize(width: 360, height: 215))
        XCTAssertEqual(layout.title, rect(12, 12, 104, 20))
        XCTAssertEqual(layout.version, rect(122, 12, 226, 20))
        XCTAssertEqual(layout.frame, rect(12, 40, 336, 127))
        XCTAssertEqual(layout.footer, rect(12, 175, 336, 28))
        // Each label padded 10 either side inside a 1pt ring, 8 apart.
        XCTAssertEqual(layout.use, rect(246, 175, 102, 28))
        XCTAssertEqual(layout.keep, rect(165, 175, 73, 28))
        XCTAssertNil(layout.notice)
        XCTAssertNil(layout.status)
    }

    func testANoticeTakesTheFootersLeftWithoutAddingALine() {
        let layout = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: true)))
        XCTAssertEqual(layout.notice, rect(12, 181, 145, 16))
        XCTAssertEqual(layout.size.height, 215)
    }

    func testAnsweringChangesOnlyTheLineUnderTheRows() {
        let open = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: false)))
        let answered = StemCellSidebarProposalLayout(width: 400, input: .init(rows: rows, titleWidth: 103.4, footer: .status))
        XCTAssertEqual(answered.size, open.size)
        XCTAssertEqual(answered.frame, open.frame)
        XCTAssertEqual(answered.status, rect(12, 181, 336, 16))
        XCTAssertNil(answered.keep)
        XCTAssertNil(answered.use)
    }

    func testANarrowColumnTakesTheCardAcross() {
        let layout = StemCellSidebarProposalLayout(width: 300, input: .init(rows: rows, titleWidth: 103.4, footer: .answers(keep: 50.2, use: 80, notice: false)))
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 215))
        XCTAssertEqual(layout.frame, rect(12, 40, 276, 127))
        XCTAssertEqual(layout.use, rect(186, 175, 102, 28))
        XCTAssertEqual(layout.keep, rect(105, 175, 73, 28))
    }

    func testFoldingMovesOnlyWhatIsUnderTheRows() {
        let folded = StemCellSidebarProposalLayout(width: 400, input: .init(rows: [.init(kind: .section), .init(kind: .separator)], titleWidth: 103.4, footer: .status))
        // 6 + 28 + 2 + 17 + 6.
        XCTAssertEqual(folded.frame, rect(12, 40, 336, 59))
        XCTAssertEqual(folded.status, rect(12, 113, 336, 16))
        XCTAssertEqual(folded.size, CGSize(width: 360, height: 147))
    }

    func testTheMessagePlacesTheCardAtTheColumnsLeft() {
        let input = StemCellSidebarProposalLayout.Input(rows: rows, titleWidth: 103.4, footer: .status)
        let message = StemCellMessageLayout.agent(width: 400, parts: [.proposal(input)])
        guard case .proposal(let layout, let frame) = message.parts.first else { return XCTFail("no proposal") }
        XCTAssertEqual(frame, rect(16, 8, 360, 215))
        XCTAssertEqual(layout.size, frame.size)
        XCTAssertEqual(message.size, CGSize(width: 400, height: 231))
    }

    private func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}
