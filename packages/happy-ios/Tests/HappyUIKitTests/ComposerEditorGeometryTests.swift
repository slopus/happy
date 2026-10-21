#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The composers' TextKit 2 text views in their frames, at every text size
/// they are drawn at, for hard lines, wrapped text at the point it wraps
/// and one character past, Japanese, emoji, Arabic, Thai, Devanagari and
/// Korean: the frame is the measured TextKit 1 height between one line and
/// the cap, the view's own text fits it in TextKit 1's lines, and every
/// line's caret is inside it, or within reach past the cap
/// (`ComposerEditorGeometry`).
@MainActor
final class ComposerEditorGeometryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
        .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
        .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
    ]

    static let texts: [(name: String, text: String)] = [
        ("one line", "hello"),
        ("two lines", "one\ntwo"),
        ("three lines", "one\ntwo\nthree"),
        ("five lines", "one\ntwo\nthree\nfour\nfive"),
        ("wrapped", "A paragraph long enough to wrap onto a second and a third line at the width of the composer on a phone."),
        ("Japanese", "日本語の文章は単語の間に空白がなくても行の終わりで折り返され、次の行へと続いていきます。"),
        ("emoji", "Shipped 🚀 the fix 👩‍💻 with tests ✅ and docs 📚, waved 👋🏽 at the team 🇯🇵🇫🇷 and went home 🏠"),
        ("Arabic", "مرحبا، هذه رسالة طويلة بما يكفي لتلتف إلى سطر ثان على عرض الهاتف في المحادثة."),
        ("Thai", "ภาษาไทยไม่เว้นวรรคระหว่างคำ ข้อความนี้จึงยาวพอที่จะขึ้นบรรทัดใหม่เมื่อแสดงบนหน้าจอโทรศัพท์ในการสนทนา"),
        ("Devanagari", "यह संदेश इतना लंबा है कि फ़ोन की चौड़ाई पर बातचीत में दूसरी पंक्ति तक पहुँच जाए और आगे भी चलता रहे।"),
        ("Korean", "이 메시지는 휴대폰 화면의 너비에서 다음 줄로 넘어갈 만큼 충분히 긴 문장으로 작성되었습니다."),
    ]

    /// Long enough to wrap at every width and text size.
    static let sentence = "The quick brown fox jumps over the lazy dog, then keeps running along the line until it wraps"

    /// The longest prefix of `sentence` a TextKit 1 view with `attributes`
    /// and `insets` keeps on one line at `width`: the text at its wrap
    /// point, and with one character more, past it.
    static func onLine(attributes: [NSAttributedString.Key: Any], insets: UIEdgeInsets, width: CGFloat) -> [(name: String, text: String)] {
        let view = UITextView(usingTextLayoutManager: false)
        view.textContainerInset = insets
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        func height(_ count: Int) -> CGFloat {
            view.attributedText = NSAttributedString(string: String(sentence.prefix(count)), attributes: attributes)
            return ComposerEditorGeometry.ownHeight(view, width: width)
        }
        let line = height(1)
        var low = 1
        var high = sentence.count
        while low < high {
            let middle = (low + high + 1) / 2
            if height(middle) <= line { low = middle } else { high = middle - 1 }
        }
        return [("at the wrap", String(sentence.prefix(low))), ("past the wrap", String(sentence.prefix(min(low + 1, sentence.count))))]
    }

    private func host(_ category: UIContentSizeCategory) -> (UIWindow, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = category
        host.traitOverrides.followsTextSize = true
        window.addSubview(host)
        return (window, host)
    }

    private let send = AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false)

    /// A card in `host` `width` wide with `text` measured, laid out at its
    /// height: the phone's card, or the flat panel.
    private func card(in host: UIView, desktop: Bool, width: CGFloat, text: String) async -> AgentInputCardView {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
            placeholder: "Type a message ...",
            showsAdd: true,
            desktop: desktop ? AgentInputDesktopConfiguration(send: send) : nil
        ))
        host.addSubview(card)
        card.updateTraitsIfNeeded()
        card.text = text
        _ = card.height(fitting: width)
        await card.textMeasured()
        card.frame = CGRect(x: 0, y: 0, width: width, height: card.height(fitting: width))
        card.layoutIfNeeded()
        card.textView.layoutIfNeeded()
        return card
    }

    private func checkCard(in host: UIView, desktop: Bool, text: String, _ label: String) async throws {
        let width: CGFloat = desktop ? 800 : 377
        let card = await card(in: host, desktop: desktop, width: width, text: text)
        defer { card.removeFromSuperview() }
        if desktop {
            typealias M = AgentInputDesktopLayout.Metrics
            let input = try XCTUnwrap(card.desktopLayoutInput(width: width))
            let layout = try XCTUnwrap(card.desktopLayout(width: width))
            ComposerEditorGeometry.assertFits(
                card.textView,
                measured: input.textContentHeight,
                frame: layout.text.height,
                minimum: input.lineHeight + M.textPaddingTop + M.textPaddingBottom,
                cap: M.inputMaxHeight,
                scrolls: layout.textScrolls,
                host: host,
                label
            )
        } else {
            let input = card.layoutInput(width: width)
            let layout = card.layout(width: width)
            let metrics = card.metrics
            ComposerEditorGeometry.assertFits(
                card.textView,
                measured: input.textContentHeight,
                frame: layout.text.height,
                minimum: (input.lineHeight ?? metrics.inputLineHeight) + metrics.inputPaddingTop + metrics.inputPaddingBottom,
                cap: metrics.inputMaxHeight,
                scrolls: layout.textScrolls,
                host: host,
                label
            )
        }
    }

    private func checkEveryTextSize(desktop: Bool) async throws {
        for category in categories {
            let (window, host) = host(category)
            // Where this size's text wraps, in the card's own text view.
            let probe = await card(in: host, desktop: desktop, width: desktop ? 800 : 377, text: "hello")
            let wraps = Self.onLine(
                attributes: probe.textView.typingAttributes,
                insets: probe.textView.textContainerInset,
                width: probe.textView.bounds.width
            )
            probe.removeFromSuperview()
            for (name, text) in Self.texts + wraps {
                try await checkCard(in: host, desktop: desktop, text: text, "\(desktop ? "panel" : "card") \(category.rawValue) \(name)")
            }
            withExtendedLifetime(window) {}
        }
    }

    func testTheCardAtEveryTextSize() async throws {
        try await checkEveryTextSize(desktop: false)
    }

    func testTheFlatPanelAtEveryTextSize() async throws {
        try await checkEveryTextSize(desktop: true)
    }

    /// New Session's prompt, at its own width and its one text size.
    func testTheNewSessionPrompt() async throws {
        typealias M = NewSessionComposerLayout.Metrics
        let width: CGFloat = 369
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        func prompt(_ text: String) async -> NewSessionComposerView {
            let composer = NewSessionComposerView(frame: CGRect(x: 0, y: 0, width: width, height: 98))
            window.addSubview(composer)
            composer.setText(text)
            _ = composer.layout(width: width)
            await composer.textMeasured()
            composer.frame.size.height = composer.layout(width: width).size.height
            composer.layoutIfNeeded()
            return composer
        }
        let probe = await prompt("hello")
        let wraps = Self.onLine(
            attributes: probe.textView.typingAttributes,
            insets: probe.textView.textContainerInset,
            width: probe.textView.bounds.width
        )
        probe.removeFromSuperview()
        for (name, text) in Self.texts + wraps {
            let composer = await prompt(text)
            let layout = composer.layout(width: width)
            ComposerEditorGeometry.assertFits(
                composer.textView,
                measured: nil,
                frame: layout.input.height,
                minimum: M.lineHeight,
                cap: M.inputMaxHeight,
                scrolls: layout.textScrolls,
                host: window,
                "new session \(name)"
            )
            composer.removeFromSuperview()
        }
    }
}
#endif
