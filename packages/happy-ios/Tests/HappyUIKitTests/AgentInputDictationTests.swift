#if canImport(UIKit)
@testable import HappyUI
import UIKit
import XCTest

/// Dictation's words written into the composer as they are recognized
/// (`AgentInputCardView.setDictatedText`): only the changed end is
/// replaced, the revisable tail dimmed, the caret kept where it belongs.
@MainActor
final class AgentInputDictationTests: XCTestCase {
    private func card() -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Message"))
        card.frame = CGRect(x: 0, y: 0, width: 390, height: 120)
        card.layoutIfNeeded()
        return card
    }

    private func alpha(_ card: AgentInputCardView, at index: Int) -> CGFloat {
        let color = card.textView.textStorage.attribute(.foregroundColor, at: index, effectiveRange: nil) as? UIColor
        var alpha: CGFloat = 0
        color?.getRed(nil, green: nil, blue: nil, alpha: &alpha)
        return alpha
    }

    /// Every character edit the storage processed, as (location, length) of
    /// the edited range.
    private func edits(of card: AgentInputCardView, during body: () -> Void) -> [NSRange] {
        var ranges: [NSRange] = []
        let storage = card.textView.textStorage
        let observer = NotificationCenter.default.addObserver(forName: NSTextStorage.didProcessEditingNotification, object: storage, queue: nil) { _ in
            MainActor.assumeIsolated {
                if storage.editedMask.contains(.editedCharacters) { ranges.append(storage.editedRange) }
            }
        }
        body()
        NotificationCenter.default.removeObserver(observer)
        return ranges
    }

    func testARevisionReplacesOnlyWhatChanged() {
        let card = card()
        card.text = "Notes: "
        card.setDictatedText("Notes: write a high", volatileLength: 12)
        let ranges = edits(of: card) {
            card.setDictatedText("Notes: write a haiku", volatileLength: 13)
        }
        XCTAssertEqual(card.text, "Notes: write a haiku")
        // "Notes: write a h" stayed; only "igh" became "aiku".
        XCTAssertEqual(ranges, [NSRange(location: 16, length: 4)])
        XCTAssertEqual(card.textMirrorResets, 0)
    }

    func testTheTailIsDimmedUntilItSettles() {
        let card = card()
        card.setDictatedText("write a haiku", volatileLength: 5)
        XCTAssertEqual(alpha(card, at: 0), 1, accuracy: 0.01)
        XCTAssertEqual(alpha(card, at: 7), 1, accuracy: 0.01)
        XCTAssertEqual(alpha(card, at: 8), AgentInputCardView.dictatedTailAlpha, accuracy: 0.01)
        XCTAssertEqual(alpha(card, at: 12), AgentInputCardView.dictatedTailAlpha, accuracy: 0.01)
        // The same words settled: nothing edited, the tail drawn as typed.
        let ranges = edits(of: card) { card.setDictatedText("write a haiku", volatileLength: 0) }
        XCTAssertEqual(ranges, [])
        XCTAssertEqual(alpha(card, at: 12), 1, accuracy: 0.01)
        // Typing after it types in the text's own colour.
        let typed = card.textView.typingAttributes[.foregroundColor] as? UIColor
        var typedAlpha: CGFloat = 0
        typed?.getRed(nil, green: nil, blue: nil, alpha: &typedAlpha)
        XCTAssertEqual(typedAlpha, 1, accuracy: 0.01)
    }

    func testACaretAtTheEndFollowsTheWords() {
        let card = card()
        card.setDictatedText("write", volatileLength: 5)
        card.setDictatedText("write a", volatileLength: 7)
        card.setDictatedText("write a haiku about", volatileLength: 19)
        XCTAssertEqual(card.selectedRange, NSRange(location: 19, length: 0))
        // Backtracking shortens the text: the caret comes back with it.
        card.setDictatedText("write a haiku", volatileLength: 6)
        XCTAssertEqual(card.selectedRange, NSRange(location: 13, length: 0))
    }

    func testACaretElsewhereStaysPut() async {
        let card = card()
        card.text = "Original draft: a long misrecognition"
        card.textView.selectedRange = NSRange(location: 3, length: 2)
        card.setDictatedText("Original draft: a", volatileLength: 1)
        XCTAssertEqual(card.selectedRange, NSRange(location: 3, length: 2))
        let snapshot = await card.textSnapshot.text()
        XCTAssertEqual(snapshot, "Original draft: a")
    }

    func testAnEmojiIsNeverSplit() {
        let card = card()
        // 👩🏽‍💻 and 👩🏽‍🔬 share their first UTF-16 units.
        card.setDictatedText("hi 👩🏽‍💻", volatileLength: 8)
        let ranges = edits(of: card) { card.setDictatedText("hi 👩🏽‍🔬", volatileLength: 8) }
        XCTAssertEqual(card.text, "hi 👩🏽‍🔬")
        XCTAssertEqual(ranges, [NSRange(location: 3, length: ("👩🏽‍🔬" as NSString).length)])
    }

    func testASetTextAfterDictationDrawsNothingDimmed() {
        let card = card()
        card.setDictatedText("write a haiku", volatileLength: 13)
        card.setText("", selection: NSRange(location: 0, length: 0))
        card.setDictatedText("sea", volatileLength: 0)
        XCTAssertEqual(alpha(card, at: 0), 1, accuracy: 0.01)
    }
}
#endif
