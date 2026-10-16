#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Session info's raw JSON blocks: megabytes of code laid out off the main
/// thread in pieces, each kept while its text is.
@MainActor
final class SessionInfoCodeBlockTests: XCTestCase {
    private let text = TextEnvironment(scale: .standard, displayScale: 3)

    /// `lines` short lines of JSON.
    private func json(lines: Int, changing line: Int? = nil) -> String {
        (0..<lines).map { index in "  \"key\(index)\": \(index == line ? "\"changed\"" : String(index))," }.joined(separator: "\n")
    }

    func testThePiecesStackToTheWholeText() {
        let plan = CodeBlockPlan(CodeBlockInput(code: json(lines: 100), width: 393, text: text), reusing: nil)
        // 40 lines a piece: 40, 40, 20.
        XCTAssertEqual(plan.pieces.count, 3)
        for (piece, lines) in zip(plan.layout.pieces, [40, 40, 20]) {
            XCTAssertEqual(piece.height, CGFloat(lines) * 18, accuracy: 0.5)
        }
        XCTAssertEqual(plan.layout.text.height, 100 * 18, accuracy: 1.5)
        XCTAssertEqual(plan.layout.size.height, plan.layout.text.height + 24 + 12)
    }

    func testOnlyAChangedPieceIsLaidOutAgain() {
        let input = CodeBlockInput(code: json(lines: 200), width: 393, text: text)
        let first = CodeBlockPlan(input, reusing: nil)
        var changed = input
        changed.code = json(lines: 200, changing: 90)
        let second = CodeBlockPlan(changed, reusing: first)
        XCTAssertEqual(second.pieces.count, 5)
        for index in 0..<5 {
            // Line 90 is in the third piece.
            XCTAssertEqual(second.pieces[index].layout === first.pieces[index].layout, index != 2, "piece \(index)")
        }
        // At a new width or text size, every piece is laid out again.
        var wider = changed
        wider.width = 600
        XCTAssertFalse(CodeBlockPlan(wider, reusing: second).pieces.contains { piece in second.pieces.contains { $0.layout === piece.layout } })
        var larger = changed
        larger.text.scale = TextScale(.accessibilityExtraExtraExtraLarge)
        XCTAssertFalse(CodeBlockPlan(larger, reusing: second).pieces.contains { piece in second.pieces.contains { $0.layout === piece.layout } })
    }

    func testAMegabyteIsNotLaidOutOnTheMainThread() async {
        let code = json(lines: 40_000)
        XCTAssertGreaterThan(code.utf8.count, 600_000)
        let view = CodeBlockView(code: code)
        let started = CACurrentMediaTime()
        let empty = view.layout(width: 393)
        XCTAssertLessThan(CACurrentMediaTime() - started, 0.05)
        // An empty box until its layout is in.
        XCTAssertEqual(empty.size.height, 36)
        await view.measured()
        let layout = view.layout(width: 393)
        XCTAssertEqual(layout.pieces.count, 1000)
        XCTAssertEqual(layout.text.height, 40_000 * 18, accuracy: 500)
    }

    func testNothingIsDrawnOutOfAWindow() async {
        let view = CodeBlockView(code: json(lines: 400))
        view.frame = CGRect(origin: .zero, size: view.sizeThatFits(CGSize(width: 393, height: 0)))
        await view.measured()
        view.frame = CGRect(origin: .zero, size: view.sizeThatFits(CGSize(width: 393, height: 0)))
        view.layoutIfNeeded()
        XCTAssertEqual(view.drawnPieces, [])
    }

    func testOnlyThePiecesNearTheScreenAreDrawn() async {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let scroll = UIScrollView(frame: window.bounds)
        window.addSubview(scroll)
        window.isHidden = false
        defer { window.isHidden = true }
        // 400 lines in 10 pieces of 720.
        let view = CodeBlockView(code: json(lines: 400))
        scroll.addSubview(view)
        _ = view.sizeThatFits(CGSize(width: 393, height: 0))
        await view.measured()
        view.frame = CGRect(origin: .zero, size: view.sizeThatFits(CGSize(width: 393, height: 0)))
        scroll.contentSize = view.frame.size
        view.layoutIfNeeded()
        // 0...852 on screen, a screen more below: pieces from 12 to 1704.
        XCTAssertEqual(view.drawnPieces, [0, 1, 2])
        scroll.contentOffset = CGPoint(x: 0, y: 3600)
        // 2748...5304 near: pieces at 2172, 2892, 3612, 4332, 5052.
        XCTAssertEqual(view.drawnPieces, [3, 4, 5, 6, 7])
    }
}
#endif
