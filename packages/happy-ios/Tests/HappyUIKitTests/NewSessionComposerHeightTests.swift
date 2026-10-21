#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The new session composer's prompt is measured off the main thread, as
/// the session composer's is: a guess until the height lands, never a
/// measurement on the main thread, and a draft that comes back unchanged
/// to a composer of the same memo opens at its height. The height is the
/// TextKit 1 one Fabric gives a TextInput; the prompt, TextKit 2 as RN's
/// is, fits inside it.
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

    /// The height Fabric gives the prompt's text at the input's width: what a
    /// TextKit 1 twin of its text view (its text, attributes and insets)
    /// sizes it to (`RCTTextLayoutManager`), as `ComposerTextMeasure`
    /// measures it.
    private func textKit1Height(_ composer: NewSessionComposerView) -> CGFloat {
        let twin = ComposerEditorGeometry.textKit1Twin(of: composer.textView)
        return ComposerEditorGeometry.ownHeight(twin, width: composer.layout(width: width).input.width)
    }

    /// The prompt as the screen shows it, in a window at the width with its
    /// text measured: a TextKit 2 view in that frame, its own text inside it
    /// in TextKit 1's lines, every line's caret inside
    /// (`ComposerEditorGeometry`).
    private func assertThePromptFits(_ composer: NewSessionComposerView, file: StaticString = #filePath, line: UInt = #line) async {
        typealias M = NewSessionComposerLayout.Metrics
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.addSubview(composer)
        composer.frame = CGRect(x: 0, y: 0, width: width, height: composer.layout(width: width).size.height)
        await composer.textMeasured()
        composer.frame.size.height = composer.layout(width: width).size.height
        composer.layoutIfNeeded()
        let layout = composer.layout(width: width)
        ComposerEditorGeometry.assertFits(
            composer.textView,
            measured: nil,
            frame: layout.input.height,
            minimum: M.lineHeight,
            cap: M.inputMaxHeight,
            scrolls: layout.textScrolls,
            host: window,
            "the prompt",
            file: file,
            line: line
        )
        composer.removeFromSuperview()
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
        XCTAssertEqual(composer.layout(width: width).input.height, textKit1Height(composer))
        XCTAssertEqual(changes, 1, "the screen lays out again once, when the height lands")
        await assertThePromptFits(composer)
    }

    func testADraftThatComesBackOpensAtItsHeight() async {
        let text = lines(3)
        let memo = MeasuredDraftMemo()
        let first = NewSessionComposerView(frame: .zero)
        first.heights = memo
        first.setText(text)
        _ = first.layout(width: width)
        await first.textMeasured()
        let measured = first.layout(width: width).input.height
        XCTAssertGreaterThan(measured, NewSessionComposerLayout.Metrics.lineHeight)

        // The next screen, set before its first layout, as the screen does.
        let next = NewSessionComposerView(frame: .zero)
        next.heights = memo
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
        let memo = MeasuredDraftMemo()
        let first = NewSessionComposerView(frame: .zero)
        first.heights = memo
        first.setText(text)
        _ = first.layout(width: width)
        await first.textMeasured()

        let edited = text + "\n" + lines(1)
        let next = NewSessionComposerView(frame: .zero)
        next.heights = memo
        next.setText(edited)
        _ = next.layout(width: width)
        await next.textMeasured()
        XCTAssertEqual(next.layout(width: width).input.height, textKit1Height(next))
        await assertThePromptFits(next)
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
