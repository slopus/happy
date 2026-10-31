import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Rich tasks against the proposal's redlines (task_174 mock v3, corner B),
/// measured in Chrome with Happy's stylesheet and Figtree at 304 wide.
final class TaskListLayoutTests: XCTestCase {
    typealias L = TaskListLayout
    let text = L.Text.figtree

    /// The proposal's list: Priorities, its six cards and their sub-rows, Small bugs, then two folded sections.
    func mockList() -> [L.Item] {
        let card = L.Item.card(.init(timeWidth: 20, signal: .dot))
        let sub = L.Item.subRow(metaWidth: 0, working: false)
        return [.header(collapsed: false), card, sub, sub, sub, card, sub, sub, sub, .more, card, sub, sub, .more, card, card, card,
                .header(collapsed: false), card, sub, card, card, .header(collapsed: true), .header(collapsed: true)]
    }

    func testRowsStandWhereTheMocksDo() {
        let result = L.layout(mockList(), width: 304)
        XCTAssertEqual(result.frames.map(\.box.minY), [12, 40, 108, 138, 168, 198, 266, 296, 326, 356, 380, 448, 478, 508, 532, 600, 668, 744, 772, 840, 870, 938, 1008, 1038])
        XCTAssertEqual(result.height, 1076)
        // Cards and sub-rows 3 in from the list; headers across it.
        XCTAssertEqual(result.frames[1].box, CGRect(x: 3, y: 40, width: 298, height: 68))
        XCTAssertEqual(result.frames[2].box, CGRect(x: 3, y: 108, width: 298, height: 30))
        XCTAssertEqual(result.frames[0].box, CGRect(x: 0, y: 12, width: 304, height: 28))
        // A header's title 14 in, its baseline 18 down; "+N more" where the text starts, 16 down.
        XCTAssertEqual(result.frames[0].label.minX, 14)
        XCTAssertEqual(result.frames[0].baseline, 12 + 18)
        XCTAssertEqual(result.frames[9].label.minX, 70)
        XCTAssertEqual(result.frames[9].baseline, 356 + 16)
    }

    func testTheCardsCapTopStandsAsFarInAsItsLastBaseline() {
        let frame = L.layout([.card(.init(timeWidth: 23.86, signal: .braille))], width: 304).frames[0]
        let hl = frame.highlight
        XCTAssertEqual(hl, CGRect(x: 3, y: 6, width: 298, height: 64))
        XCTAssertEqual(frame.disc, CGRect(x: 10, y: 13, width: 50, height: 50))
        XCTAssertEqual(frame.icon, CGRect(x: 15, y: 18, width: 40, height: 40))
        XCTAssertEqual(frame.label.minX, 70)
        // A story's ring on the disc's edge, its fill 2 clear inside it.
        let story = L.layout([.card(.init(story: true))], width: 304).frames[0]
        XCTAssertEqual([story.ring, story.disc, story.icon], [frame.disc, CGRect(x: 14, y: 17, width: 42, height: 42), CGRect(x: 18, y: 21, width: 34, height: 34)])
        let last = try! XCTUnwrap(frame.lastBaseline)
        let capTop = frame.baseline - text.title.capHeight
        // The equality the proposal is built on, and its measured value (10.81 there, its H a hair taller).
        XCTAssertEqual(capTop - hl.minY, hl.maxY - last, accuracy: 1e-9)
        XCTAssertEqual(text.edge, 10.81, accuracy: 0.02)
        XCTAssertEqual(frame.baseline - hl.minY, 21.67, accuracy: 0.02)
        XCTAssertEqual(last - hl.minY, 53.17, accuracy: 0.02)
        // The time ends `e` in, its cap top on the title's.
        let time = try! XCTUnwrap(frame.time)
        XCTAssertEqual(time.maxX, hl.maxX - text.edge, accuracy: 1e-9)
        XCTAssertEqual(time.minY + text.time.ascender - text.time.capHeight, capTop, accuracy: 1e-9)
        XCTAssertEqual(frame.label.maxX, time.minX - 8, accuracy: 1e-9)
        // Two status lines: the second's baseline the last, the first running to 12 in.
        let status = try! XCTUnwrap(frame.status)
        XCTAssertEqual(status.minY + text.statusBaseline + 16, last, accuracy: 1e-9)
        XCTAssertEqual(status.maxX, hl.maxX - 12, accuracy: 1e-9)
    }

    func testTheCornerItemsAreCentredOnTheLastLinesXHeight() {
        let frame = L.layout([.card(.init(timeWidth: 20, moreWidth: 47.53, faces: 2, signal: .dot))], width: 304).frames[0]
        let hl = frame.highlight, last = try! XCTUnwrap(frame.lastBaseline)
        let middle = last - text.status.xHeight / 2
        XCTAssertEqual(middle - hl.minY, 49.67, accuracy: 0.02)
        let chips = [try! XCTUnwrap(frame.signal)] + frame.faces
        for chip in chips {
            XCTAssertEqual(chip.midY, middle, accuracy: 1e-9)
            XCTAssertEqual(chip.height, 14)
        }
        // Right to left from `e` in, 6 apart: the dot, the faces (each over the last by 30%), the text button.
        let dot = chips[0], faces = frame.faces
        XCTAssertEqual(dot.maxX, hl.maxX - text.edge, accuracy: 1e-9)
        XCTAssertEqual(dot.width, 14)
        XCTAssertEqual(faces[1].maxX, dot.minX - 6, accuracy: 1e-9)
        XCTAssertEqual(faces[1].minX - faces[0].minX, 9.8, accuracy: 1e-9)
        // "+N more" is words on the last line: its baseline is the line's.
        let more = try! XCTUnwrap(frame.more)
        XCTAssertEqual(more.minY + text.more.ascender, last, accuracy: 1e-9)
        XCTAssertEqual(more.maxX, faces[0].minX - 6, accuracy: 1e-9)
        // Only the second status line makes room for the corner, 6 before it.
        XCTAssertEqual(try! XCTUnwrap(frame.statusEnd), more.minX - 6, accuracy: 1e-9)
        // The braille: 6 wide, on the same middle and edge.
        let busy = L.layout([.card(.init(signal: .braille))], width: 304).frames[0]
        XCTAssertEqual(busy.signal, CGRect(x: hl.maxX - text.edge - 6, y: middle - 7, width: 6, height: 14))
    }

    func testASubRowEndsOnTheCardsRightEdge() {
        let frames = L.layout([.card(.init(signal: .dot)), .subRow(metaWidth: 66.31, working: false), .subRow(metaWidth: 30, working: true), .more], width: 304).frames
        let card = frames[0], meta = frames[1], busy = frames[2]
        for row in [meta, busy] {
            XCTAssertEqual(row.highlight.maxX, card.highlight.maxX)
            XCTAssertEqual(row.highlight.minX, 3 + 35)
            XCTAssertEqual(row.label.minX, card.label.minX)
            // The 18 mark ends where the disc does; the text's baseline 19 down its 30 row.
            XCTAssertEqual(row.mark, CGRect(x: 42, y: row.box.minY + 6, width: 18, height: 18))
            XCTAssertEqual(row.baseline, row.box.minY + 19)
        }
        // The trail ends where the card's corner does.
        XCTAssertEqual(try! XCTUnwrap(meta.meta).maxX, try! XCTUnwrap(card.signal).maxX, accuracy: 1e-9)
        XCTAssertEqual(try! XCTUnwrap(busy.signal).maxX, try! XCTUnwrap(card.signal).maxX, accuracy: 1e-9)
        XCTAssertEqual(try! XCTUnwrap(busy.meta).maxX, try! XCTUnwrap(busy.signal).minX - 6, accuracy: 1e-9)
        XCTAssertEqual(busy.label.maxX, try! XCTUnwrap(busy.meta).minX - 8, accuracy: 1e-9)
        XCTAssertEqual(meta.meta!.minY + text.time.ascender, meta.baseline, accuracy: 1e-9)
    }

    func testHighlightsStandFourApart() {
        let card = L.Item.card(.init())
        let frames = L.layout([card, .subRow(metaWidth: 0, working: false), .subRow(metaWidth: 0, working: true), card, card], width: 390).frames
        for (upper, lower) in zip(frames, frames.dropFirst()) {
            XCTAssertEqual(lower.highlight.minY - upper.highlight.maxY, 4)
        }
        XCTAssertEqual(frames.map(\.radius), [14, 8, 8, 14, 14])
        XCTAssertEqual(frames[0].highlight.maxX, 387)
    }
}
