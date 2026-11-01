#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A lifted message's selection lies on the glyphs the row drew: its
/// rects come from the very layouts in the plan, and here they are held
/// against the ink those layouts put down, drawn into a bitmap.
@MainActor
final class MessageTextSelectionTests: XCTestCase {
    private let scale: CGFloat = 3
    private let style = ChatRowStyle(render: .isolated())

    private func agent(_ text: String, width: CGFloat = 393) -> ChatRowPlan {
        ChatRowRenderer.plan(ChatRowInput(item: .message(.agentText(AgentTextMessage(id: "a1", createdAt: 0, text: text))), style: style), width: width)
    }

    private func user(_ text: String) -> ChatRowPlan {
        ChatRowRenderer.plan(ChatRowInput(item: .message(.userText(UserTextMessage(id: "u1", createdAt: 0, text: text))), style: style), width: 393)
    }

    /// The ink of `range`'s characters alone, drawn by layouts laid out as
    /// the plan's are, with every other character clear: per pixel row,
    /// the leftmost and rightmost inked column, in points.
    private func ink(_ range: Range<Int>, in selection: ChatSelectable, size: CGSize) -> [Int: (minX: CGFloat, maxX: CGFloat)] {
        let run = selection.run
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            for (index, text) in selection.texts.enumerated() {
                let start = run.starts[index]
                let copy = NSMutableAttributedString(attributedString: text.layout.string)
                copy.addAttribute(.foregroundColor, value: UIColor.clear, range: NSRange(location: 0, length: copy.length))
                let lower = max(range.lowerBound, start) - start
                let upper = min(range.upperBound, start + copy.length) - start
                if lower < upper {
                    copy.addAttribute(.foregroundColor, value: UIColor.black, range: NSRange(location: lower, length: upper - lower))
                }
                ChatTextLayout(copy, width: text.layout.width, maxLines: text.layout.maxLines).draw(at: text.frame.origin)
            }
        }.cgImage!
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var rows: [Int: (minX: CGFloat, maxX: CGFloat)] = [:]
        for y in 0..<height {
            var minX: Int?, maxX: Int?
            for x in 0..<width where pixels[(y * width + x) * 4 + 3] > 96 {
                if minX == nil { minX = x }
                maxX = x
            }
            if let minX, let maxX { rows[y] = (CGFloat(minX) / scale, CGFloat(maxX + 1) / scale) }
        }
        return rows
    }

    /// Every inked pixel row of `range` lies in one of `rects`, inside it
    /// sideways; and each rect's ends sit on its line's first and last
    /// glyph, give or take the glyphs' side bearings.
    private func assertOnGlyphs(_ rects: [CGRect], _ range: Range<Int>, in selection: ChatSelectable, size: CGSize, bearing: CGFloat = 2.5, file: StaticString = #filePath, line: UInt = #line) {
        let rows = ink(range, in: selection, size: size)
        XCTAssertFalse(rows.isEmpty, "nothing inked", file: file, line: line)
        for (y, ink) in rows {
            let midY = (CGFloat(y) + 0.5) / scale
            guard let rect = rects.first(where: { midY >= $0.minY && midY < $0.maxY }) else {
                XCTFail("ink at y \(midY) outside every rect \(rects)", file: file, line: line)
                return
            }
            XCTAssertGreaterThanOrEqual(ink.minX, rect.minX - 1, "ink starts left of its rect at y \(midY)", file: file, line: line)
            XCTAssertLessThanOrEqual(ink.maxX, rect.maxX + 1, "ink ends right of its rect at y \(midY)", file: file, line: line)
        }
        for rect in rects {
            let inked = rows.filter { y, _ in let midY = (CGFloat(y) + 0.5) / scale; return midY >= rect.minY && midY < rect.maxY }.values
            guard let left = inked.map(\.minX).min(), let right = inked.map(\.maxX).max() else {
                XCTFail("rect \(rect) covers no ink", file: file, line: line)
                continue
            }
            XCTAssertEqual(rect.minX, left, accuracy: bearing, "rect \(rect) starts off its first glyph", file: file, line: line)
            XCTAssertEqual(rect.maxX, right, accuracy: bearing, "rect \(rect) ends off its last glyph", file: file, line: line)
        }
    }

    private func range(of word: String, in selection: ChatSelectable) -> Range<Int> {
        let found = (selection.run.pieces.map(\.text).joined() as NSString).range(of: word)
        return found.location..<(found.location + found.length)
    }

    // MARK: A word

    func testAWordsRectIsItsGlyphs() throws {
        let plan = agent("The quick brown fox jumps over the lazy dog.")
        let selection = try XCTUnwrap(plan.selection)
        let brown = range(of: "brown", in: selection)
        let rects = MessageTextSelectionView.rects(for: brown, in: selection, run: selection.run)
        XCTAssertEqual(rects.count, 1)
        assertOnGlyphs(rects, brown, in: selection, size: plan.size)
        // The rect is the layout's own line fragment: its full line height.
        let text = selection.texts[0]
        let line = text.layout.selectionRects(for: NSRange(location: brown.lowerBound, length: brown.count))[0]
        XCTAssertEqual(rects[0], line.offsetBy(dx: text.frame.minX, dy: text.frame.minY))
    }

    func testAPressOnAWordSelectsThatWord() throws {
        let plan = agent("The quick brown fox jumps over the lazy dog.")
        let selection = try XCTUnwrap(plan.selection)
        let view = MessageTextSelectionView(selectable: selection, size: plan.size)
        let brown = range(of: "brown", in: selection)
        let rect = try XCTUnwrap(MessageTextSelectionView.rects(for: brown, in: selection, run: selection.run).first)
        XCTAssertEqual(view.word(at: CGPoint(x: rect.midX, y: rect.midY)), brown)
        view.setSelection(brown, animateIn: false)
        XCTAssertEqual(view.selectedText, "brown")
        // The handles stand on its ends.
        XCTAssertEqual(view.startKnob.frame, SelectionGeometry.startKnob(edge: CGRect(x: rect.minX, y: rect.minY, width: 0, height: rect.height)))
        XCTAssertEqual(view.endKnob.frame, SelectionGeometry.endKnob(edge: CGRect(x: rect.maxX, y: rect.minY, width: 0, height: rect.height)))
    }

    // MARK: Across lines

    func testARangeAcrossLinesIsOneRectALineOnTheGlyphs() throws {
        let words = "Caches keep what they read and drop it when the file changes, so a test that writes the file and reads it back sees the new bytes every time it runs."
        let plan = agent(words, width: 300)
        let selection = try XCTUnwrap(plan.selection)
        let range = 12..<119
        let rects = MessageTextSelectionView.rects(for: range, in: selection, run: selection.run)
        XCTAssertGreaterThanOrEqual(rects.count, 3)
        assertOnGlyphs(rects, range, in: selection, size: plan.size)
        // One line after the other, no seams.
        for (a, b) in zip(rects, rects.dropFirst()) { XCTAssertEqual(a.maxY, b.minY, accuracy: 0.01) }
        XCTAssertEqual(selection.run.copy(range), (words as NSString).substring(with: NSRange(location: 12, length: 107)))
    }

    func testADraggedHandleExtendsTheSelectionToTheLineUnderIt() throws {
        let words = "Caches keep what they read and drop it when the file changes, so a test that writes the file and reads it back sees the new bytes."
        let plan = agent(words, width: 300)
        let selection = try XCTUnwrap(plan.selection)
        let view = MessageTextSelectionView(selectable: selection, size: plan.size)
        let keep = range(of: "keep", in: selection)
        view.setSelection(keep, animateIn: false)
        let text = selection.texts[0]
        // Past the last line's end: all the way.
        XCTAssertEqual(view.caret(nearest: CGPoint(x: text.frame.maxX + 40, y: text.frame.maxY + 40)), selection.run.length)
        let lines = text.layout.selectionRects(for: NSRange(location: 0, length: selection.run.length)).map { $0.offsetBy(dx: text.frame.minX, dy: text.frame.minY) }
        let second = try XCTUnwrap(lines.dropFirst().first)
        let at = try XCTUnwrap(view.caret(nearest: CGPoint(x: second.maxX - 1, y: second.midY)))
        view.setSelection(keep.lowerBound..<at, animateIn: false)
        XCTAssertEqual(view.rects.count, 2)
        XCTAssertTrue(view.selectedText?.hasPrefix("keep what they read") ?? false)
    }

    // MARK: Markdown

    private let markdown = """
        Run `swift test` **first**.

        - one item
        - two items

        1. numbered

        ```swift
        let x = 1
        print(x)
        ```
        """

    func testMarkdownSelectsParagraphsListsAndCodeAndCopiesItsSourceShape() throws {
        let plan = agent(markdown)
        let selection = try XCTUnwrap(plan.selection)
        XCTAssertEqual(selection.texts.count, 5)
        XCTAssertEqual(selection.run.copy(0..<selection.run.length), "Run swift test first.\n\n- one item\n- two items\n\n1. numbered\n\nlet x = 1\nprint(x)")
        // From inside the first item to inside the code.
        let from = range(of: "item", in: selection).lowerBound
        let to = range(of: "x = 1", in: selection).upperBound
        XCTAssertEqual(selection.run.copy(from..<to), "item\n- two items\n\n1. numbered\n\nlet x = 1")
        XCTAssertEqual(selection.whole, markdown)
    }

    func testMarkdownRectsLieOnTheirGlyphsInEveryBlock() throws {
        let plan = agent(markdown)
        let selection = try XCTUnwrap(plan.selection)
        for word in ["swift test", "first", "two items", "numbered", "print(x)"] {
            let range = range(of: word, in: selection)
            let rects = MessageTextSelectionView.rects(for: range, in: selection, run: selection.run)
            XCTAssertEqual(rects.count, 1, word)
            // A monospaced glyph sits in the middle of its cell: a `)` has
            // a wide bearing on either side.
            assertOnGlyphs(rects, range, in: selection, size: plan.size, bearing: word == "print(x)" ? 4 : 2.5)
        }
        // A code block's text is in its strip, which its highlight keeps to.
        let code = try XCTUnwrap(selection.texts.last)
        let clip = try XCTUnwrap(code.clip)
        for rect in MessageTextSelectionView.rects(for: range(of: "let x", in: selection), in: selection, run: selection.run) {
            XCTAssertTrue(clip.contains(rect), "\(rect) past \(clip)")
        }
        // The list markers are drawn, not selected.
        XCTAssertNil(selection.texts.first { $0.layout.string.string == MarkdownPiece.bullet(depth: 0) })
    }

    // MARK: What lifts

    func testAPersonsMessageLiftsAsItsBubble() throws {
        let plan = user("Run the tests")
        let selection = try XCTUnwrap(plan.selection)
        XCTAssertFalse(selection.card)
        let bubble = try XCTUnwrap(plan.items.compactMap { item -> CGRect? in
            if case .box(let box) = item, box.fill != nil { return box.frame }
            return nil
        }.first)
        XCTAssertEqual(selection.frame, bubble)
        XCTAssertEqual(selection.whole, "Run the tests")
        let range = 0..<selection.run.length
        assertOnGlyphs(MessageTextSelectionView.rects(for: range, in: selection, run: selection.run), range, in: selection, size: plan.size)
    }

    func testAnAgentsWordsLiftOnACardOverWhatTheyCover() throws {
        let plan = agent("Done.")
        let selection = try XCTUnwrap(plan.selection)
        XCTAssertTrue(selection.card)
        XCTAssertTrue(selection.frame.contains(selection.texts[0].frame))
    }

    func testTheLayoutFindsWordsAsTelegramDoes() {
        let layout = ChatTextLayout(NSAttributedString(string: "Hello, wide world!", attributes: [.font: UIFont.systemFont(ofSize: 17)]), width: 300)
        XCTAssertEqual(layout.wordRange(at: 8), NSRange(location: 7, length: 4))
        // Not a word: the one character.
        XCTAssertEqual(layout.wordRange(at: 5), NSRange(location: 5, length: 1))
        XCTAssertEqual(layout.caretIndex(nearest: CGPoint(x: -10, y: -10)), 0)
        XCTAssertEqual(layout.caretIndex(nearest: CGPoint(x: 400, y: 400)), 18)
    }
}
#endif
