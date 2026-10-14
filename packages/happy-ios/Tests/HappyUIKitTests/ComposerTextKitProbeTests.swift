#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A probe, not a contract: prints how the card's text lays out in a
/// TextKit 1 and a TextKit 2 text view next to the height measured off the
/// main thread, line by line and at every text size, and which Writing
/// Tools experience each view resolves to. React Native's composer is a
/// TextKit 2 `RCTUITextView` in a frame Fabric measured with TextKit 1;
/// these numbers say whether the card could be the same.
///
/// Per text size, a `text` line first shows the size reached the card: its
/// trait, scale, font size and line, the drawn line height (minimum/maximum),
/// baseline offset and the layout's line height. A `boundary` line follows:
/// the longest prefix of a sentence each TextKit keeps on one line.
///
/// Then each case prints one `TKPROBE` line:
/// `measure` the card's measured text height (`-` past the 120 cap),
/// `tk1`/`tk2` each view's own height, `carets` the top and height of
/// the caret at each line's start, then at the end, `frame` the card's
/// text frame the views are laid out in (the carets are read there),
/// `scrolls` whether the card scrolls it, `content` each view's content
/// height in it, `lines` the lines each TextKit broke the text into, and
/// `case`: a text, the sentence up to TextKit 1's one-line boundary, or one
/// character past it.
@MainActor
final class ComposerTextKitProbeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
        .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
        .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
    ]

    private let texts = [
        "hello",
        "one\ntwo",
        "one\ntwo\nthree",
        "one\ntwo\nthree\nfour\nfive",
        "A paragraph long enough to wrap onto a second and a third line at the width of the composer on a phone.",
    ]

    /// Long enough to wrap at every text size.
    private let sentence = "The quick brown fox jumps over the lazy dog, then keeps running along the line until it wraps"

    /// A text view laid out like the card's: its text, attributes and
    /// insets.
    private func twin(_ text: NSAttributedString, inset: UIEdgeInsets, textKit2: Bool) -> UITextView {
        let twin = UITextView(usingTextLayoutManager: textKit2)
        twin.textContainerInset = inset
        twin.textContainer.lineFragmentPadding = 0
        twin.isScrollEnabled = false
        twin.attributedText = text
        return twin
    }

    /// The view's own height at `width`, as it sizes itself.
    private func ownHeight(_ view: UITextView, width: CGFloat) -> CGFloat {
        view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    /// The lines the view's TextKit broke its text into. Only a TextKit 1
    /// view is asked for its layout manager.
    private func lineCount(_ view: UITextView) -> Int {
        var count = 0
        if let manager = view.textLayoutManager {
            _ = manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
                count += fragment.textLineFragments.count
                return true
            }
            return count
        }
        let manager = view.layoutManager
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: view.textContainer)) { _, _, _, _, _ in
            count += 1
        }
        return count
    }

    /// The longest prefix of the sentence the view keeps on the line its
    /// first character takes.
    private func oneLinePrefix(_ view: UITextView, attributes: [NSAttributedString.Key: Any], width: CGFloat) -> Int {
        func height(_ count: Int) -> CGFloat {
            view.attributedText = NSAttributedString(string: String(sentence.prefix(count)), attributes: attributes)
            return ownHeight(view, width: width)
        }
        let line = height(1)
        var low = 1
        var high = sentence.count
        while low < high {
            let middle = (low + high + 1) / 2
            if height(middle) <= line {
                low = middle
            } else {
                high = middle - 1
            }
        }
        return low
    }

    private func carets(_ view: UITextView, text: String) -> String {
        var offsets = [0]
        for (offset, character) in text.utf16.enumerated() where character == 0x0A {
            offsets.append(offset + 1)
        }
        offsets.append(text.utf16.count)
        return offsets.map { offset in
            guard let position = view.position(from: view.beginningOfDocument, offset: offset) else { return "?" }
            let caret = view.caretRect(for: position)
            return String(format: "%.3f/%.3f", caret.minY, caret.height)
        }.joined(separator: ",")
    }

    private func number(_ value: CGFloat) -> String {
        String(format: "%.3f", value)
    }

    private func measured(_ card: AgentInputCardView, text: String) async -> AgentInputCardLayout.Input {
        card.text = text
        _ = card.layoutInput(width: 377)
        await card.textMeasured()
        return card.layoutInput(width: 377)
    }

    private func row(_ card: AgentInputCardView, category: UIContentSizeCategory, text: String, name: String) async {
        let input = await measured(card, text: text)
        let layout = card.layout(width: 377)
        let width = layout.text.width
        let attributed = card.textView.attributedText ?? NSAttributedString()
        let tk1 = twin(attributed, inset: card.textView.textContainerInset, textKit2: false)
        let tk2 = twin(attributed, inset: card.textView.textContainerInset, textKit2: true)
        // Read before anything that could turn it into TextKit 1.
        XCTAssertNotNil(tk2.textLayoutManager)
        XCTAssertNil(tk1.textLayoutManager)
        let own1 = ownHeight(tk1, width: width)
        let own2 = ownHeight(tk2, width: width)
        // In the card's own text frame, scrolling where the card does.
        for view in [tk1, tk2] {
            view.isScrollEnabled = layout.textScrolls
            view.frame = CGRect(x: 0, y: 0, width: width, height: layout.text.height)
            view.layoutIfNeeded()
        }
        let measure = layout.textScrolls ? "-" : number(input.textContentHeight)
        print("TKPROBE \(category.rawValue) lines=\(text.split(separator: "\n").count) chars=\(text.count) width=\(number(width)) measure=\(measure) tk1=\(number(own1)) tk2=\(number(own2)) tk1carets=\(carets(tk1, text: text)) tk2carets=\(carets(tk2, text: text)) frame=\(number(layout.text.height)) scrolls=\(layout.textScrolls) tk1content=\(number(tk1.contentSize.height)) tk2content=\(number(tk2.contentSize.height)) tk1lines=\(lineCount(tk1)) tk2lines=\(lineCount(tk2)) case=\(name)")
        XCTAssertNotNil(tk2.textLayoutManager)
    }

    func testTextKit1AndTextKit2AgainstTheMeasure() async throws {
        for category in categories {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            let host = UIView(frame: window.bounds)
            host.traitOverrides.preferredContentSizeCategory = category
            host.traitOverrides.followsTextSize = true
            window.addSubview(host)
            let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
            host.addSubview(card)
            card.updateTraitsIfNeeded()

            // The text size reached the card: the rows are at that size.
            let input = await measured(card, text: "hello")
            let font = try XCTUnwrap(card.textView.font)
            let attributes = card.textView.typingAttributes
            let paragraph = attributes[.paragraphStyle] as? NSParagraphStyle
            let offset = attributes[.baselineOffset] as? CGFloat
            let scale = TextScale(TextSizeCategory(category)).multiplier
            print("TKPROBE \(category.rawValue) text trait=\(card.traitCollection.preferredContentSizeCategory.rawValue) scale=\(number(scale)) font=\(number(font.pointSize)) fontLine=\(number(font.lineHeight)) lineHeight=\(paragraph.map { "\(number($0.minimumLineHeight))/\(number($0.maximumLineHeight))" } ?? "nil") baselineOffset=\(offset.map(number) ?? "nil") inputLineHeight=\(input.lineHeight.map(number) ?? "nil")")
            XCTAssertEqual(card.traitCollection.preferredContentSizeCategory, category)
            XCTAssertEqual(font.pointSize, 16 * scale, accuracy: 0.001, category.rawValue)
            XCTAssertEqual(paragraph?.maximumLineHeight ?? 0, 22 * scale, accuracy: 0.001, category.rawValue)

            for text in texts {
                await row(card, category: category, text: text, name: "text")
            }

            // Where each TextKit wraps the sentence, at the card's width.
            let width = card.layout(width: 377).text.width
            let inset = card.textView.textContainerInset
            let empty = NSAttributedString()
            let boundary1 = oneLinePrefix(twin(empty, inset: inset, textKit2: false), attributes: attributes, width: width)
            let boundary2 = oneLinePrefix(twin(empty, inset: inset, textKit2: true), attributes: attributes, width: width)
            print("TKPROBE \(category.rawValue) boundary width=\(number(width)) tk1=\(boundary1) tk2=\(boundary2)")
            await row(card, category: category, text: String(sentence.prefix(boundary1)), name: "boundary")
            await row(card, category: category, text: String(sentence.prefix(min(boundary1 + 1, sentence.count))), name: "past")
            withExtendedLifetime(window) {}
        }
    }

    func testWhichWritingToolsEachTextKitGets() {
        let tk1 = UITextView(usingTextLayoutManager: false)
        let tk2 = UITextView(usingTextLayoutManager: true)
        XCTAssertNil(tk1.textLayoutManager)
        XCTAssertNotNil(tk2.textLayoutManager)
        if #available(iOS 18.2, *) {
            // Asked for only where the view answers it, through a call that
            // takes a nil: it is declared nonnull, and may not be there on a
            // device without Writing Tools. Otherwise among its interactions.
            func behavior(_ view: UITextView) -> String {
                let selector = NSSelectorFromString("writingToolsCoordinator")
                if view.responds(to: selector), let object = view.perform(selector)?.takeUnretainedValue() {
                    guard let coordinator = object as? UIWritingToolsCoordinator else { return "other" }
                    return "\(coordinator.behavior.rawValue)/property"
                }
                if let coordinator = view.interactions.lazy.compactMap({ $0 as? UIWritingToolsCoordinator }).first {
                    return "\(coordinator.behavior.rawValue)/interaction"
                }
                return "none"
            }
            print("TKPROBE writingTools os=\(UIDevice.current.systemVersion) available=\(UIWritingToolsCoordinator.isWritingToolsAvailable) preferred tk1=\(tk1.writingToolsBehavior.rawValue) tk2=\(tk2.writingToolsBehavior.rawValue) resolved tk1=\(behavior(tk1)) tk2=\(behavior(tk2))")
        } else {
            print("TKPROBE writingTools os=\(UIDevice.current.systemVersion) before 18.2")
        }
        XCTAssertNotNil(tk2.textLayoutManager)
    }
}
#endif
