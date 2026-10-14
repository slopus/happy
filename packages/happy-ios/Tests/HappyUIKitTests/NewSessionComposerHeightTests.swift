#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The new session composer's prompt is measured off the main thread, as
/// the session composer's is: a guess until the height lands, never a
/// measurement on the main thread, and a draft that comes back unchanged
/// opens at its height.
@MainActor
final class NewSessionComposerHeightTests: XCTestCase {
    private let width: CGFloat = 369

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// Lines no other test sets, so no screen before measured them.
    private func lines(_ count: Int) -> String {
        let tag = UUID().uuidString.prefix(8)
        return (1...count).map { "\(tag) line \($0)" }.joined(separator: "\n")
    }

    /// What UITextView itself gives the text at the input's width.
    private func viewHeight(_ composer: NewSessionComposerView, _ text: String) -> CGFloat {
        let reference = UITextView()
        reference.textContainerInset = .zero
        reference.textContainer.lineFragmentPadding = 0
        reference.isScrollEnabled = false
        reference.attributedText = TextStyles.composerInput.attributedString(text, color: UIColor(Palette.inputText))
        return ceil(reference.sizeThatFits(CGSize(width: composer.layout(width: width).input.width, height: .greatestFiniteMagnitude)).height)
    }

    func testADraftIsMeasuredOffTheMainThreadAndLandsOnce() async {
        let composer = NewSessionComposerView(frame: .zero)
        var changes = 0
        composer.onHeightChange = { changes += 1 }
        let text = lines(3)
        composer.setText(text)
        // Nothing was measured here: one line stands in.
        XCTAssertEqual(composer.layout(width: width).input.height, NewSessionComposerLayout.Metrics.lineHeight)
        await composer.textMeasured()
        XCTAssertEqual(composer.layout(width: width).input.height, viewHeight(composer, text))
        XCTAssertEqual(changes, 1, "the screen lays out again once, when the height lands")
    }

    func testADraftThatComesBackOpensAtItsHeight() async {
        let text = lines(3)
        let first = NewSessionComposerView(frame: .zero)
        first.setText(text)
        _ = first.layout(width: width)
        await first.textMeasured()
        let measured = first.layout(width: width).input.height
        XCTAssertGreaterThan(measured, NewSessionComposerLayout.Metrics.lineHeight)

        // The next screen, set before its first layout, as the screen does.
        let next = NewSessionComposerView(frame: .zero)
        next.setText(text)
        var changes = 0
        next.onHeightChange = { changes += 1 }
        XCTAssertEqual(next.layout(width: width).input.height, measured, "its first frame")
        await next.textMeasured()
        XCTAssertEqual(next.layout(width: width).input.height, measured)
        XCTAssertEqual(changes, 0, "nothing moves after")
    }

    func testAnEditedDraftIsMeasuredAgain() async {
        let text = lines(3)
        let first = NewSessionComposerView(frame: .zero)
        first.setText(text)
        _ = first.layout(width: width)
        await first.textMeasured()

        let edited = text + "\n" + lines(1)
        let next = NewSessionComposerView(frame: .zero)
        next.setText(edited)
        _ = next.layout(width: width)
        await next.textMeasured()
        XCTAssertEqual(next.layout(width: width).input.height, viewHeight(next, edited))
    }

    func testAReplacedDraftNeverShowsTheOldHeight() async {
        let composer = NewSessionComposerView(frame: CGRect(x: 0, y: 0, width: width, height: 98))
        composer.layoutIfNeeded()
        var heights: [CGFloat] = []
        composer.onHeightChange = { [unowned composer] in heights.append(composer.layout(width: self.width).input.height) }
        let long = lines(4)
        let short = lines(1)
        composer.setText(long)
        // Replaced before the long text's height lands.
        composer.setText(short)
        await composer.textMeasured()
        let line = NewSessionComposerLayout.Metrics.lineHeight
        XCTAssertEqual(composer.layout(width: width).input.height, line)
        XCTAssertFalse(heights.contains { $0 > line }, "the long text's height is dropped: \(heights)")
    }

    func testClearingShrinksAtOnce() async {
        let composer = NewSessionComposerView(frame: CGRect(x: 0, y: 0, width: width, height: 98))
        composer.setText(lines(3))
        composer.layoutIfNeeded()
        await composer.textMeasured()
        XCTAssertGreaterThan(composer.layout(width: width).input.height, NewSessionComposerLayout.Metrics.lineHeight)

        var changes = 0
        composer.onHeightChange = { changes += 1 }
        composer.textView.text = ""
        composer.textViewDidChange(composer.textView)
        XCTAssertEqual(composer.layout(width: width).input.height, NewSessionComposerLayout.Metrics.lineHeight)
        XCTAssertEqual(changes, 1)
    }

    func testALongDraftStopsAtTheCapAndScrolls() async {
        let composer = NewSessionComposerView(frame: .zero)
        composer.setText(lines(12))
        _ = composer.layout(width: width)
        await composer.textMeasured()
        let layout = composer.layout(width: width)
        XCTAssertEqual(layout.input.height, NewSessionComposerLayout.Metrics.inputMaxHeight)
        XCTAssertTrue(layout.textScrolls)
    }
}
#endif
