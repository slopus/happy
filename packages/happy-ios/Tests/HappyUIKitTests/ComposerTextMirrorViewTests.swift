#if canImport(UIKit)
import Foundation
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The card's text mirror follows every way the text view's text changes,
/// so the draft and the measurement read the text off the main thread
/// without a copy on main.
@MainActor
final class ComposerTextMirrorViewTests: XCTestCase {
    private func card() -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message..."))
        card.frame = CGRect(x: 0, y: 0, width: 360, height: 120)
        card.layoutIfNeeded()
        return card
    }

    private func assertMirrored(_ card: AgentInputCardView, _ step: String, file: StaticString = #filePath, line: UInt = #line) async {
        let snapshot = card.textSnapshot
        let text = await Task.detached { await snapshot.text() }.value
        XCTAssertEqual(text, card.text, step, file: file, line: line)
        XCTAssertEqual(card.textMirrorResets, 0, "\(step): the mirror never lost track", file: file, line: line)
    }

    func testTheMirrorFollowsEveryKindOfEdit() async {
        let card = card()
        let view = card.textView
        view.insertText("hello")
        await assertMirrored(card, "typed")
        view.insertText(" wörld 😀")
        await assertMirrored(card, "typed more")
        view.deleteBackward()
        await assertMirrored(card, "deleted an emoji")
        // An input method's marked text, replaced as it composes, then
        // committed.
        view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
        await assertMirrored(card, "marked")
        view.setMarkedText("にほ", selectedRange: NSRange(location: 2, length: 0))
        await assertMirrored(card, "marked more")
        view.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0))
        view.unmarkText()
        await assertMirrored(card, "committed")
        // A same-length replacement in the middle, as autocorrect makes.
        if let start = view.position(from: view.beginningOfDocument, offset: 0),
           let end = view.position(from: start, offset: 5),
           let range = view.textRange(from: start, to: end) {
            view.replace(range, withText: "howdy")
        }
        await assertMirrored(card, "replaced in place")
        card.setText("set by the composer", selection: NSRange(location: 3, length: 0))
        await assertMirrored(card, "set")
        view.attributedText = NSAttributedString(string: "set by UIKit")
        await assertMirrored(card, "attributed text")
        view.text = ""
        await assertMirrored(card, "emptied")
        view.insertText(String(repeating: "long line ", count: 10_000))
        await assertMirrored(card, "a long paste")
    }

    func testATextSizeChangeRestylesWithoutLosingTheMirror() async {
        let card = card()
        card.textView.insertText("restyled")
        card.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge
        card.traitOverrides.followsTextSize = true
        card.layoutIfNeeded()
        await assertMirrored(card, "restyled")
    }

    /// A keystroke takes one snapshot, shared by the measurement and the
    /// draft, and hands the mirror only its own units.
    func testAKeystrokeHandsOverOnlyItsUnits() async {
        let card = card()
        card.textView.insertText(String(repeating: "x", count: 100_000))
        let first = card.textSnapshot
        XCTAssertTrue(first === card.textSnapshot, "one per revision")
        let edits = card.editCount
        card.textView.insertText("y")
        XCTAssertGreaterThan(card.editCount, edits)
        XCTAssertFalse(first === card.textSnapshot)
        await assertMirrored(card, "after the keystroke")
    }
}
#endif
