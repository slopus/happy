import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// The chat's rows when the person's text size or the screens' language
/// changes, through the production window, grouping and planner. In the
/// app each row's input carries the list's `TextEnvironment` and the
/// screen's `ChatWords` (`ChatRowText`, in `ChatRowStyle`); here the size
/// is its multiplier, which is all a row's plan reads of it.
final class ApplyPerfChatTextSizeTests: XCTestCase {
    struct Row: Equatable, Sendable {
        var item: ChatListItem
        var textSize: CGFloat
        var words: ChatWords
        var id: String { item.id }
    }

    final class Pass {
        /// A row's "height" grows with the size, as a measured row's does.
        let planner = RowPlanner<Row, Int> { row, width in Int(width * row.textSize) + row.id.count }
        var window = ChatWindowState()
        var applied = PlannedRows<Row, Int>()
        var width: CGFloat = 390
        var textSize: CGFloat = 1
        var words = ChatWords.english

        func derive(_ messages: [ChatMessage], thinking: Bool = false) -> ChatRowsDerivation.Result<Row, Int> {
            let textSize = self.textSize
            let words = self.words
            let result = ChatRowsDerivation.derive(
                messages: messages, window: window, requests: ChatWindowRequests(), groupToolCalls: true,
                currentTurnComplete: !thinking, inForeground: true, width: width,
                planner: planner, applied: applied,
                makeRows: { items, _ in items.map { Row(item: $0, textSize: textSize, words: words) } },
                id: \.id
            )
            window = result.window.state
            applied = result.rows
            return result
        }
    }

    /// One off-main pass measures every row once and reconfigures them
    /// all in one apply, moving nothing: ids and order are kept, so the
    /// list holds the reader's row (`ChatScrollAnchor`).
    func testANewTextSizeMeasuresEveryRowOnceInOneChangeset() {
        let messages = ApplyPerfChatRowsTests.conversation(turns: 500)
        let pass = Pass()
        let first = pass.derive(messages, thinking: true)
        let rows = first.rows.ids.count
        for size in [CGFloat(3.571), 0.823, 1.353] {
            pass.textSize = size
            let clock = ContinuousClock()
            var resized: ChatRowsDerivation.Result<Row, Int>!
            let time = clock.measure { resized = pass.derive(messages, thinking: true) }
            XCTAssertEqual(resized.measured, rows, "size \(size)")
            XCTAssertEqual(resized.changeset.reconfigures, Array(0..<rows))
            XCTAssertEqual(resized.changeset.inserts, [])
            XCTAssertEqual(resized.changeset.deletes, [])
            XCTAssertEqual(resized.changeset.moves, [])
            XCTAssertFalse(resized.changeset.isStructural)
            XCTAssertEqual(resized.rows.ids, first.rows.ids)
            XCTAssertEqual(resized.rows.plans, first.rows.ids.map { Int(390 * size) + $0.count })
            print("APPLY_PERF chat text size \(size): \(rows) rows measured once, derive \(String(format: "%.2f", time.milliseconds)) ms off main (Linux debug, counting planner)")
        }
        // The same size again measures nothing.
        let again = pass.derive(messages, thinking: true)
        XCTAssertEqual(again.measured, 0)
        XCTAssertTrue(again.changeset.isEmpty)
        XCTAssertEqual(pass.planner.measured, 4 * rows)
    }

    /// After a new size, a streamed token measures only the bubble it
    /// lands in again, at the new size.
    func testAfterANewSizeATokenMeasuresOnlyTheLastBubble() {
        let messages = ApplyPerfChatRowsTests.conversation(turns: 500)
        let pass = Pass()
        _ = pass.derive(messages, thinking: true)
        pass.textSize = 2.143
        let resized = pass.derive(messages, thinking: true)
        for step in 1...20 {
            let streamed = pass.derive(ApplyPerfChatRowsTests.streamed(messages, step), thinking: true)
            XCTAssertEqual(streamed.measured, 1, "step \(step)")
            XCTAssertEqual(streamed.changeset, RowChangeset(reconfigures: [0]), "step \(step)")
            XCTAssertEqual(streamed.rows.inputs[0].textSize, 2.143)
        }
        XCTAssertEqual(pass.planner.measured, 2 * resized.rows.ids.count + 20)
    }

    /// A new size and a new width together are still one pass.
    func testANewSizeAndWidthTogetherAreOnePass() {
        let messages = ApplyPerfChatRowsTests.conversation(turns: 500)
        let pass = Pass()
        let first = pass.derive(messages)
        pass.textSize = 1.786
        pass.width = 744
        let both = pass.derive(messages)
        XCTAssertEqual(both.measured, first.rows.ids.count)
        XCTAssertEqual(both.changeset.reconfigures, Array(0..<first.rows.ids.count))
        XCTAssertFalse(both.changeset.isStructural)
    }

    /// Rows built in another language are planned again, as for a new size;
    /// the same language again is the same input.
    func testAnotherLanguagePlansEveryRowAgain() async {
        _ = await TranslationCatalog.load("ja")
        let messages = ApplyPerfChatRowsTests.conversation(turns: 100)
        let pass = Pass()
        let first = pass.derive(messages)
        pass.words = ChatWords(language: "ja")
        let japanese = pass.derive(messages)
        XCTAssertEqual(japanese.measured, first.rows.ids.count)
        XCTAssertEqual(japanese.changeset.reconfigures, Array(0..<first.rows.ids.count))
        pass.words = ChatWords(catalog: TranslationCatalog.catalog(for: "ja"))
        XCTAssertEqual(pass.derive(messages).measured, 0)
    }
}
