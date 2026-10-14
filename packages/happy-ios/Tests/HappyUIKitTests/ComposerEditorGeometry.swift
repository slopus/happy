#if canImport(UIKit)
import UIKit
import XCTest

/// A composer's TextKit 2 text view checked in its frame against a TextKit 1
/// twin, the TextKit Fabric measures a TextInput with (`RCTTextLayoutManager`):
/// the frame is the measured height between one line and the cap, the twin
/// needs exactly the measured height, the view's own text needs no more
/// than its frame, both break the text into the same lines, and every
/// line's caret is inside the view's bounds, scrolled to where it scrolls.
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

    /// What is wrong with the view's carets at `offsets` in its bounds
    /// (whose origin is its content offset). Not scrolling: every caret
    /// inside, at offset 0. Scrolling: the content taller than the bounds,
    /// the first caret inside at offset 0, then each inside once scrolled to
    /// (`scrollRangeToVisible`), and the last within the content, which is
    /// not scrolled past.
    static func caretProblems(_ view: UITextView, offsets: [Int]) -> [String] {
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
            if caret.minY < view.bounds.minY || caret.maxY > view.bounds.maxY {
                problems.append("\(when) caret \(offset) \(describe(caret)) outside \(describe(view.bounds))")
            }
        }
        if view.isScrollEnabled {
            if !(view.contentSize.height > view.bounds.height) {
                problems.append("scrolls with content \(view.contentSize.height) in \(view.bounds.height)")
            }
            view.setContentOffset(.zero, animated: false)
            view.layoutIfNeeded()
            if let first = offsets.first { check(first, "at the top") }
            for offset in offsets {
                view.scrollRangeToVisible(NSRange(location: offset, length: 0))
                view.layoutIfNeeded()
                check(offset, "scrolled to")
            }
            if let last = offsets.last, let caret = caret(last), caret.maxY > view.contentSize.height {
                problems.append("end caret \(describe(caret)) past content \(view.contentSize.height)")
            }
            if view.contentOffset.y > view.contentSize.height - view.bounds.height {
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
        let textKit2 = caretProblems(editor, offsets: offsets)
        let textKit1 = caretProblems(twin, offsets: offsets)
        twin.removeFromSuperview()
        let both = "TextKit 2 \(textKit2), TextKit 1 \(textKit1)"
        XCTAssertEqual(textKit2, [], "\(label): carets, \(both)", file: file, line: line)
        XCTAssertEqual(textKit1, [], "\(label): the twin's carets, \(both)", file: file, line: line)
        XCTAssertNotNil(editor.textLayoutManager, "\(label): still TextKit 2", file: file, line: line)
    }
}
#endif
