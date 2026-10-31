import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Rich tasks against the iPhone sizing spec (task_174 `design/ios-sizing.md`),
/// in a 361 grouped card (a 393 screen), Figtree at Large.
final class TaskListLayoutTests: XCTestCase {
    typealias L = TaskListLayout
    typealias M = TaskListMetrics
    let text = L.Text.figtree, width: CGFloat = 361

    /// The proposal's Priorities: its six cards and their sub-rows.
    func mockList() -> [L.Item] {
        let card = L.Item.card(.init(timeWidth: 20, signal: .dot))
        let sub = L.Item.subRow(metaWidth: 0, working: false)
        return [card, sub, sub, sub, card, sub, sub, sub, .more, card, sub, sub, .more, card, card, card]
    }

    func testRowsStandWhereTheSpecDoes() {
        let result = L.layout(mockList(), width: width)
        // Cards 72 apart (Telegram's 68 row lit), sub-rows 44, "+N more" 40.
        let heights: [CGFloat] = mockList().map { if case .card = $0 { 72 } else if case .more = $0 { 40 } else { 44 } }
        XCTAssertEqual(result.frames.map(\.box.height), heights)
        XCTAssertEqual(result.frames.map(\.box.minY), heights.indices.map { L.room + heights[..<$0].reduce(0, +) })
        XCTAssertEqual(result.height, L.room * 2 + heights.reduce(0, +), accuracy: 1e-9)
        // The highlights 16 − e in from the grouped card's every side.
        XCTAssertEqual(result.frames[0].highlight.minX, 16 - M.edge, accuracy: 1e-9)
        XCTAssertEqual(result.frames[0].highlight.minY, 16 - M.edge, accuracy: 1e-9)
        XCTAssertEqual(result.frames[0].highlight.maxX, width - 16 + M.edge, accuracy: 1e-9)
        // Text at 86; "+N more"'s x-height on its row's middle.
        let more = result.frames[8]
        XCTAssertEqual(more.label.minX, 86, accuracy: 1e-9)
        XCTAssertEqual(more.baseline - text.more.xHeight / 2, more.box.midY, accuracy: 1e-9)
    }

    func testTheCardsInsetIsEOnEverySide() {
        let frame = L.layout([.card(.init(timeWidth: 23.86, signal: .braille))], width: width).frames[0]
        let hl = frame.highlight, e = M.edge
        XCTAssertEqual(hl.height, 68, accuracy: 1e-9)
        // The 60 disc 16 from the grouped card, centred; the text 10 past it.
        XCTAssertEqual(frame.disc, CGRect(x: 16, y: hl.midY - 30, width: 60, height: 60))
        XCTAssertEqual(frame.icon, CGRect(x: 22, y: hl.midY - 24, width: 48, height: 48))
        XCTAssertEqual(frame.label.minX, 86, accuracy: 1e-9)
        // A story's ring on the disc's edge, its fill 4 inside it, its art 42.
        let story = L.layout([.card(.init(story: true))], width: width).frames[0]
        XCTAssertEqual(story.ring, frame.disc)
        XCTAssertEqual(story.disc, frame.disc?.insetBy(dx: 4, dy: 4))
        XCTAssertEqual(story.icon?.width ?? 0, 42, accuracy: 1e-9)
        // The cap top `e` under the top, the last baseline `e` over the bottom, the time and the status `e` in.
        let last = try! XCTUnwrap(frame.lastBaseline)
        XCTAssertEqual(frame.baseline - text.title.capHeight - hl.minY, e, accuracy: 1e-9)
        XCTAssertEqual(hl.maxY - last, e, accuracy: 1e-9)
        let time = try! XCTUnwrap(frame.time), status = try! XCTUnwrap(frame.status)
        XCTAssertEqual(time.maxX, hl.maxX - e, accuracy: 1e-9)
        XCTAssertEqual(time.minY + text.time.ascender - text.time.capHeight, frame.baseline - text.title.capHeight, accuracy: 1e-9)
        XCTAssertEqual(frame.label.maxX, time.minX - M.timeGap, accuracy: 1e-9)
        // Two status lines: 18 under the title, then 20 apart, the first running to `e` in.
        XCTAssertEqual(status.minY + text.statusBaseline, frame.baseline + M.titleToStatus, accuracy: 1e-9)
        XCTAssertEqual(status.minY + text.statusBaseline + M.statusLine, last, accuracy: 1e-9)
        XCTAssertEqual(status.maxX, hl.maxX - e, accuracy: 1e-9)
    }

    func testTheCornerItemsAreCentredOnTheLastLinesXHeight() {
        let frame = L.layout([.card(.init(timeWidth: 20, moreWidth: 60, faces: 2, signal: .dot))], width: width).frames[0]
        let hl = frame.highlight, last = try! XCTUnwrap(frame.lastBaseline), middle = last - text.status.xHeight / 2
        let chips = [try! XCTUnwrap(frame.signal)] + frame.faces
        for chip in chips {
            XCTAssertEqual(chip.midY, middle, accuracy: 1e-9)
            XCTAssertEqual(chip.height, M.chip)
        }
        // Right to left from `e` in, 6 apart: the dot, the faces (each over the last by 30%), the words.
        let dot = chips[0], faces = frame.faces
        XCTAssertEqual(dot.maxX, hl.maxX - M.edge, accuracy: 1e-9)
        XCTAssertEqual(dot.width, M.chip)
        XCTAssertEqual(faces[1].maxX, dot.minX - M.cornerGap, accuracy: 1e-9)
        XCTAssertEqual(faces[1].minX - faces[0].minX, M.chip * M.faceStep, accuracy: 1e-9)
        let more = try! XCTUnwrap(frame.more)
        XCTAssertEqual(more.minY + text.more.ascender, last, accuracy: 1e-9)
        XCTAssertEqual(more.maxX, faces[0].minX - M.cornerGap, accuracy: 1e-9)
        // Only the second status line makes room for the corner, 6 before it.
        XCTAssertEqual(try! XCTUnwrap(frame.statusEnd), more.minX - M.cornerGap, accuracy: 1e-9)
        let busy = L.layout([.card(.init(signal: .braille))], width: width).frames[0]
        XCTAssertEqual(busy.signal, CGRect(x: hl.maxX - M.edge - 7.5, y: middle - 9, width: 7.5, height: 18))
    }

    func testASubRowEndsOnTheCardsRightEdge() {
        let frames = L.layout([.card(.init(signal: .dot)), .subRow(metaWidth: 66.31, working: false), .subRow(metaWidth: 30, working: true), .more], width: width).frames
        let card = frames[0], meta = frames[1], busy = frames[2]
        for row in [meta, busy] {
            // The 24 mark ends where the disc does, its highlight from 4 left of it; the text's x-height on the middle.
            XCTAssertEqual(row.mark, CGRect(x: 52, y: row.box.minY + 10, width: 24, height: 24))
            XCTAssertEqual(row.highlight, CGRect(x: 48, y: row.box.minY + 2, width: card.highlight.maxX - 48, height: 40))
            XCTAssertEqual(row.label.minX, card.label.minX)
            XCTAssertEqual(row.baseline, row.box.minY + 22 + text.row.xHeight / 2, accuracy: 1e-9)
        }
        XCTAssertEqual(try! XCTUnwrap(meta.meta).maxX, try! XCTUnwrap(card.signal).maxX, accuracy: 1e-9)
        XCTAssertEqual(try! XCTUnwrap(busy.signal).maxX, try! XCTUnwrap(card.signal).maxX, accuracy: 1e-9)
        XCTAssertEqual(try! XCTUnwrap(busy.meta).maxX, try! XCTUnwrap(busy.signal).minX - M.cornerGap, accuracy: 1e-9)
        XCTAssertEqual(busy.label.maxX, try! XCTUnwrap(busy.meta).minX - M.trailGap, accuracy: 1e-9)
        XCTAssertEqual(meta.meta!.minY + text.time.ascender, meta.baseline, accuracy: 1e-9)
    }

    func testHighlightsStandFourApartAndCardsAfterTheFirstWearAHairline() {
        let card = L.Item.card(.init())
        let frames = L.layout([card, .subRow(metaWidth: 0, working: false), .subRow(metaWidth: 0, working: true), card, card], width: width, hairline: 1 / 3).frames
        for (upper, lower) in zip(frames, frames.dropFirst()) {
            XCTAssertEqual(lower.highlight.minY - upper.highlight.maxY, 4, accuracy: 1e-9)
        }
        XCTAssertEqual(frames.map(\.radius), [14, 10, 10, 14, 14])
        XCTAssertEqual(frames.map { $0.separator != nil }, [false, false, false, true, true])
        XCTAssertEqual(frames[3].separator, CGRect(x: 86, y: frames[3].box.minY, width: width - 86, height: 1 / 3))
    }

    /// xxxLarge (Callout 22, Subheadline 21): the spec's 87.4 highlight, 52 sub-rows and 48 "+N more".
    func testTheRowsGrowWithTheTextSize() {
        let big = L.Text(title: .figtree(22), time: .figtree(21), status: .figtree(21), row: .figtree(21), more: .figtree(21), scale: 1.4, disc: 60, statusBaseline: 28 - 0.25 * 21)
        let frames = L.layout([.card(.init()), .subRow(metaWidth: 0, working: true), .more], width: width, text: big).frames
        XCTAssertEqual(frames[0].highlight.height, 87.4, accuracy: 1e-9)
        XCTAssertEqual(frames[1].box.height, 52, accuracy: 1e-9)
        XCTAssertEqual(frames[2].box.height, 48, accuracy: 1e-9)
        XCTAssertEqual(frames[1].signal?.size.height ?? 0, 25.2, accuracy: 1e-9)
        XCTAssertEqual(frames[0].highlight.maxY - frames[0].lastBaseline!, M.edge, accuracy: 1e-9)
    }
}

/// Figtree's own metrics, so the layout is tested without UIKit.
extension TaskListLayout.Face {
    static func figtree(_ size: CGFloat) -> Self { .init(ascender: 0.95 * size, capHeight: 0.7 * size, xHeight: 0.5 * size, lineHeight: 1.2 * size) }
}

extension TaskListLayout.Text {
    /// At Large: Callout 16 and Subheadline 15 on 20 lines.
    static let figtree = Self(title: .figtree(TaskListMetrics.titleSize), time: .figtree(15), status: .figtree(15), row: .figtree(15), more: .figtree(15),
                              scale: 1, disc: TaskListMetrics.disc, statusBaseline: TaskListMetrics.statusLine - 0.25 * 15)
}

extension TaskListLayout {
    static func layout(_ items: [Item], width: CGFloat, hairline: CGFloat = 1) -> Result { layout(items, width: width, text: .figtree, hairline: hairline) }
}
