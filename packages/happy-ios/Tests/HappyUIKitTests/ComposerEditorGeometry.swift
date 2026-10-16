#if canImport(UIKit)
import UIKit
import XCTest

/// A composer's TextKit 2 text view checked in its frame against a TextKit 1
/// twin, the TextKit Fabric measures a TextInput with (`RCTTextLayoutManager`):
/// the frame is the measured height between one line and the cap, the twin
/// needs exactly the measured height, the view's own text needs no more
/// than its frame, both break the text into the same lines, and every
/// line's caret is inside the view's bounds, or within reach where it
/// scrolls.
///
/// Only a TextKit 1 twin is asked for its `layoutManager`; asking a TextKit 2
/// view would turn it into TextKit 1.
@MainActor
enum ComposerEditorGeometry {
    /// A TextKit 1 view of the editor's text, attributes and insets, with no
    /// line fragment padding, not scrolling.
    static func textKit1Twin(of editor: UITextView) -> UITextView {
        let twin = UITextView(usingTextLayoutManager: false)
        twin.textContainerInset = editor.textContainerInset
        twin.textContainer.lineFragmentPadding = 0
        twin.isScrollEnabled = false
        twin.attributedText = editor.attributedText
        return twin
    }

    /// The view's own height at `width`, as it sizes itself, to the point.
    static func ownHeight(_ view: UITextView, width: CGFloat) -> CGFloat {
        ceil(view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }

    /// The twin laid out at `width`, as tall as its text.
    @discardableResult
    static func layOut(_ twin: UITextView, width: CGFloat) -> UITextView {
        twin.frame = CGRect(x: 0, y: 0, width: width, height: ownHeight(twin, width: width))
        twin.layoutIfNeeded()
        return twin
    }

    /// The lines holding text in a view laid out at its width: a TextKit 2
    /// view's from its text layout manager, a TextKit 1 view's from its
    /// layout manager.
    static func lines(_ view: UITextView) -> Int {
        if let manager = view.textLayoutManager {
            var count = 0
            _ = manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
                count += fragment.textLineFragments.filter { $0.characterRange.length > 0 }.count
                return true
            }
            return count
        }
        let manager = view.layoutManager
        manager.ensureLayout(for: view.textContainer)
        var count = 0
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: view.textContainer)) { _, _, _, _, _ in
            count += 1
        }
        return count
    }

    /// Where each of a TextKit 1 twin's lines starts, and the text's end.
    static func caretOffsets(_ twin: UITextView) -> [Int] {
        precondition(twin.textLayoutManager == nil, "a TextKit 1 twin")
        let manager = twin.layoutManager
        manager.ensureLayout(for: twin.textContainer)
        var offsets: [Int] = []
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: twin.textContainer)) { _, _, _, glyphs, _ in
            offsets.append(manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil).location)
        }
        offsets.append(twin.textStorage.length)
        return offsets
    }

    private static func describe(_ rect: CGRect) -> String {
        String(format: "%.3f…%.3f", rect.minY, rect.maxY)
    }

    /// The caret at each of `offsets` in the view's coordinates, which are
    /// its content's (its bounds' origin is its content offset).
    static func carets(_ view: UITextView, offsets: [Int]) -> [Int: CGRect] {
        var carets: [Int: CGRect] = [:]
        for offset in offsets {
            if let position = view.position(from: view.beginningOfDocument, offset: offset) {
                carets[offset] = view.caretRect(for: position)
            }
        }
        return carets
    }

    /// What is wrong with the view's carets at `offsets`. Not scrolling:
    /// every caret inside its bounds, at offset 0. Scrolling: a TextKit 1
    /// view's content at least as tall as its bounds (it scrolls from the
    /// cap, `MultiTextInputLayout`; TextKit 2 lays the same lines out a
    /// little shorter, which the fit and the lines hold), the first caret
    /// inside the bounds at offset 0, and every caret within reach: inside
    /// the content and no taller than the bounds, the last within the
    /// content, and `scrollRangeToVisible` to each never past the content.
    /// Whether scrolling to a caret brings it inside the bounds is not
    /// checked: in the test bundle the content offset stays 0 (run
    /// 38523578708), in a window with a scene, shown or not.
    ///
    /// `reference`, a TextKit 1 twin's carets at the same offsets, lets a
    /// caret reach where the twin's does past the bounds, or past the
    /// content when it scrolls: with no insets the first caret starts above
    /// the view and the last ends below it in TextKit 1 and 2 alike.
    static func caretProblems(_ view: UITextView, offsets: [Int], reference: [Int: CGRect]? = nil) -> [String] {
        var problems: [String] = []
        func caret(_ offset: Int) -> CGRect? {
            guard let position = view.position(from: view.beginningOfDocument, offset: offset) else {
                problems.append("no position at \(offset)")
                return nil
            }
            return view.caretRect(for: position)
        }
        func check(_ offset: Int, _ when: String) {
            guard let caret = caret(offset) else { return }
            var low = view.bounds.minY
            var high = view.bounds.maxY
            if let twin = reference?[offset] {
                low = min(low, twin.minY)
                high = max(high, twin.maxY)
            }
            if caret.minY < low || caret.maxY > high {
                problems.append("\(when) caret \(offset) \(describe(caret)) outside \(describe(view.bounds))")
            }
        }
        if view.isScrollEnabled {
            if view.textLayoutManager == nil, view.contentSize.height.rounded(.up) < view.bounds.height {
                problems.append("scrolls with content \(view.contentSize.height) in \(view.bounds.height)")
            }
            view.setContentOffset(.zero, animated: false)
            view.layoutIfNeeded()
            if let first = offsets.first { check(first, "at the top") }
            // The content, or as far as the twin's caret reaches past it.
            func reach(_ offset: Int) -> (low: CGFloat, high: CGFloat) {
                let twin = reference?[offset]
                return (min(0, twin?.minY ?? 0), max(view.contentSize.height, twin?.maxY ?? 0))
            }
            for offset in offsets {
                view.scrollRangeToVisible(NSRange(location: offset, length: 0))
                view.layoutIfNeeded()
                guard let caret = caret(offset) else { continue }
                let reach = reach(offset)
                if caret.minY < reach.low || caret.maxY > reach.high || caret.height > view.bounds.height {
                    problems.append("caret \(offset) \(describe(caret)) out of reach in content \(view.contentSize.height) through \(view.bounds.height)")
                }
            }
            if let last = offsets.last, let caret = caret(last), caret.maxY > reach(last).high {
                problems.append("end caret \(describe(caret)) past content \(view.contentSize.height)")
            }
            if view.contentOffset.y > max(0, view.contentSize.height - view.bounds.height) {
                problems.append("offset \(view.contentOffset.y) past content \(view.contentSize.height) in \(view.bounds.height)")
            }
        } else {
            if view.contentOffset.y != 0 {
                problems.append("offset \(view.contentOffset.y) while not scrolling")
            }
            for offset in offsets { check(offset, "unscrolled") }
        }
        return problems
    }

    /// A TextKit 2 view's layout fragments and their lines, in its
    /// coordinates, from its text layout manager.
    static func textFrames(_ view: UITextView) -> [CGRect] {
        guard let manager = view.textLayoutManager else { return [] }
        let top = view.textContainerInset.top
        var frames: [CGRect] = []
        _ = manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame.offsetBy(dx: 0, dy: top)
            frames.append(frame)
            for line in fragment.textLineFragments {
                frames.append(line.typographicBounds.offsetBy(dx: frame.minX, dy: frame.minY))
            }
            return true
        }
        return frames
    }

    /// `editor`, laid out by its owner, in a frame `frame` tall, for a text
    /// measured `measured` tall (its padding included; nil to take the
    /// twin's height, which an uncapped measure is) with `minimum` for one
    /// line and the `cap`, scrolling or not as its layout says. `host` holds
    /// the twin meanwhile, as a control: its carets are checked as the
    /// editor's are, and both are printed where either fails.
    static func assertFits(
        _ editor: UITextView,
        measured: CGFloat?,
        frame: CGFloat,
        minimum: CGFloat,
        cap: CGFloat,
        scrolls: Bool,
        host: UIView,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertNotNil(editor.textLayoutManager, "\(label): TextKit 2", file: file, line: line)
        let width = editor.bounds.width
        let twin = layOut(textKit1Twin(of: editor), width: width)
        let needed = ownHeight(twin, width: width)
        let measured = measured ?? needed

        // The frame is the measured height, between one line and the cap.
        XCTAssertEqual(frame, min(cap, max(minimum, measured)), "\(label): frame", file: file, line: line)
        XCTAssertEqual(editor.bounds.height, frame, "\(label): the view's height", file: file, line: line)
        XCTAssertEqual(editor.isScrollEnabled, scrolls, "\(label): scrolling", file: file, line: line)
        if scrolls {
            XCTAssertGreaterThanOrEqual(needed, cap, "\(label): TextKit 1 needs the cap", file: file, line: line)
            XCTAssertGreaterThanOrEqual(measured, cap, "\(label): measured to the cap", file: file, line: line)
        } else {
            // Fabric's height for the text, exactly, and the view's own
            // text inside it.
            XCTAssertEqual(measured, needed, "\(label): measured as TextKit 1 lays it out", file: file, line: line)
            XCTAssertLessThanOrEqual(ownHeight(editor, width: width), frame, "\(label): TextKit 2 fits", file: file, line: line)
        }
        XCTAssertEqual(lines(editor), lines(twin), "\(label): lines, TextKit 2 against TextKit 1", file: file, line: line)

        let offsets = caretOffsets(twin)
        twin.frame = CGRect(x: 0, y: 0, width: width, height: frame)
        twin.isScrollEnabled = scrolls
        host.addSubview(twin)
        twin.layoutIfNeeded()
        // With no insets (New session's prompt) the carets are held to the
        // twin's, and the text itself to the view: its fragments and lines
        // inside, the bounds' height or, scrolling, the content's.
        let insets = editor.textContainerInset
        let reference = insets.top == 0 && insets.bottom == 0 ? carets(twin, offsets: offsets) : nil
        if reference != nil {
            let limit = scrolls ? editor.contentSize.height : editor.bounds.height
            let outside = textFrames(editor).filter { $0.minY < 0 || $0.maxY > limit }.map(describe)
            XCTAssertEqual(outside, [], "\(label): TextKit 2's text inside 0…\(limit)", file: file, line: line)
        }
        let textKit2 = caretProblems(editor, offsets: offsets, reference: reference)
        let textKit1 = caretProblems(twin, offsets: offsets, reference: reference)
        twin.removeFromSuperview()
        let both = "TextKit 2 \(textKit2), TextKit 1 \(textKit1)"
        XCTAssertEqual(textKit2, [], "\(label): carets, \(both)", file: file, line: line)
        XCTAssertEqual(textKit1, [], "\(label): the twin's carets, \(both)", file: file, line: line)
        XCTAssertNotNil(editor.textLayoutManager, "\(label): still TextKit 2", file: file, line: line)
    }
}
#endif
