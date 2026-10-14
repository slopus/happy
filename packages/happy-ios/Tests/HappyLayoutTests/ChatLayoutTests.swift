import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class ChatListLayoutTests: XCTestCase {
    private let layout = ChatListLayout(width: 393, heights: [50, 30, 20], newerEndHeight: 6, olderEndHeight: 32)

    func testRowsStackFromTheNewestEdge() {
        assertFrame(layout.newerEndFrame, rect(0, 0, 393, 6))
        assertFrame(layout.frame(ofRow: 0), rect(0, 6, 393, 50))
        assertFrame(layout.frame(ofRow: 1), rect(0, 56, 393, 30))
        assertFrame(layout.frame(ofRow: 2), rect(0, 86, 393, 20))
        assertFrame(layout.olderEndFrame, rect(0, 106, 393, 32))
        assertSize(layout.contentSize, CGSize(width: 393, height: 138))
    }

    func testVisibleRowsByBinarySearch() {
        XCTAssertEqual(layout.rows(from: 60, to: 90), 1..<3)
        XCTAssertEqual(layout.rows(from: 0, to: 5), 0..<0, "only the footer shows")
        XCTAssertEqual(layout.rows(from: 0, to: 1000), 0..<3)
        XCTAssertEqual(layout.firstRow(endingAfter: 56), 1, "a row ending exactly at y is not past it")
        XCTAssertEqual(layout.firstRow(endingAfter: 200), 3)
    }

    func testReplacingAHeightMovesEverythingOlder() {
        let grown = layout.replacingHeight(at: 0, with: 70)
        assertFrame(grown.frame(ofRow: 1), rect(0, 76, 393, 30))
        XCTAssertEqual(grown.contentHeight, 158)
    }

    func testAnEmptyList() {
        let empty = ChatListLayout(width: 393, heights: [], newerEndHeight: 6, olderEndHeight: 32)
        XCTAssertEqual(empty.contentHeight, 38)
        XCTAssertEqual(empty.rows(from: 0, to: 100), 0..<0)
    }
}

final class ChatScrollAnchorTests: XCTestCase {
    private let ids = (0..<10).map { "r\($0)" }
    private var layout: ChatListLayout { ChatListLayout(width: 393, heights: Array(repeating: 100, count: 10)) }

    func testAReaderNearTheNewestMessageFollowsIt() {
        let anchor = ChatScrollAnchor.capture(layout: layout, ids: ids, visibleMinY: 200)
        XCTAssertEqual(anchor.kind, .newest)
        XCTAssertEqual(anchor.visibleMinY(in: layout, ids: ids, current: 200, maxVisibleMinY: 900), 0)
    }

    func testAReaderDraggingNearTheNewestMessageKeepsTheirRow() {
        let anchor = ChatScrollAnchor.capture(layout: layout, ids: ids, visibleMinY: 150, follow: false)
        XCTAssertEqual(anchor.kind, .row(id: "r1", distance: -50))
        let grown = layout.replacingHeight(at: 0, with: 130)
        XCTAssertEqual(anchor.visibleMinY(in: grown, ids: ids, current: 150, maxVisibleMinY: 1000), 180)
    }

    func testAReaderInHistoryKeepsTheirRowWhenNewerRowsArrive() {
        let anchor = ChatScrollAnchor.capture(layout: layout, ids: ids, visibleMinY: 450)
        XCTAssertEqual(anchor.kind, .row(id: "r4", distance: -50))
        let newIds = ["n1", "n0"] + ids
        let grown = ChatListLayout(width: 393, heights: Array(repeating: 100, count: 12))
        XCTAssertEqual(anchor.visibleMinY(in: grown, ids: newIds, current: 450, maxVisibleMinY: 1100), 650)
    }

    func testStreamingGrowthBelowTheReaderIsAbsorbed() {
        let anchor = ChatScrollAnchor.capture(layout: layout, ids: ids, visibleMinY: 450)
        let grown = layout.replacingHeight(at: 0, with: 160)
        XCTAssertEqual(anchor.visibleMinY(in: grown, ids: ids, current: 450, maxVisibleMinY: 1000), 510)
    }

    func testAnOpenedRowGrowsTowardsTheNewestUnderTheReader() {
        // Row 4 spans 400..<500; its top on screen is 500, 50 above the
        // visible min y of 450 … and stays there when it grows by 120.
        let anchor = ChatScrollAnchor.pinning("r4", layout: layout, ids: ids, visibleMinY: 450)
        XCTAssertEqual(anchor?.kind, .rowEnd(id: "r4", distance: 50))
        let opened = layout.replacingHeight(at: 4, with: 220)
        XCTAssertEqual(anchor?.visibleMinY(in: opened, ids: ids, current: 450, maxVisibleMinY: 1200), 570)
        // A reader at the newest edge stays there; the row grows upwards.
        let newest = ChatScrollAnchor.pinning("r0", layout: layout, ids: ids, visibleMinY: 0)
        XCTAssertEqual(newest?.kind, .newest)
        XCTAssertEqual(newest?.visibleMinY(in: layout.replacingHeight(at: 0, with: 220), ids: ids, current: 0, maxVisibleMinY: 1200), 0)
        XCTAssertNil(ChatScrollAnchor.pinning("gone", layout: layout, ids: ids, visibleMinY: 0))
    }

    func testAMissingAnchorRowKeepsTheOffsetAndNothingOverscrolls() {
        let anchor = ChatScrollAnchor(kind: .row(id: "gone", distance: 0))
        XCTAssertEqual(anchor.visibleMinY(in: layout, ids: ids, current: 450, maxVisibleMinY: 300), 300)
        let deep = ChatScrollAnchor(kind: .row(id: "r9", distance: -50))
        XCTAssertEqual(deep.visibleMinY(in: layout, ids: ids, current: 0, maxVisibleMinY: 600), 600)
    }
}

final class MarkdownLayoutTests: XCTestCase {
    func testAnImageIsDecodedNoLargerThanItsBoxAt3x() {
        // Contained in 520 x 240: a wide picture by its width, a tall one
        // by its height.
        assertSize(MarkdownLayout.decodedImageSize(CGSize(width: 4000, height: 1000)), CGSize(width: 1560, height: 390))
        assertSize(MarkdownLayout.decodedImageSize(CGSize(width: 1000, height: 3000)), CGSize(width: 240, height: 720))
        assertSize(MarkdownLayout.decodedImageSize(CGSize(width: 64, height: 64)), CGSize(width: 64, height: 64))
        assertSize(MarkdownLayout.decodedImageSize(.zero), .zero)
    }

    func testBlocksStackWithTheirOwnMargins() {
        let layout = MarkdownLayout(width: 300, blocks: [
            .text(text("hello world", lineHeight: 25)),
            .header(level: 2, text("Title", lineHeight: 24)),
            .rule,
            .list([
                .init(depth: 0, marker: fixed(6, 25), text: text("one", lineHeight: 25)),
                .init(depth: 1, marker: fixed(6, 25), text: text("two", lineHeight: 25)),
            ]),
            .code(language: text("swift", lineHeight: 16), code: CGSize(width: 400, height: 40)),
            .options([text("Yes", lineHeight: 24), text("No", lineHeight: 24)]),
            .image(caption: text("cap", lineHeight: 20)),
        ])
        assertFrame(layout.blocks[0].frame, rect(0, 8, 300, 25))
        assertFrame(layout.blocks[1].frame, rect(0, 59, 300, 24))
        assertFrame(layout.blocks[2].frame, rect(0, 99, 300, 1))

        guard case .list(let listFrame, let items) = layout.blocks[3] else { return XCTFail() }
        assertFrame(listFrame, rect(0, 108, 300, 58))
        assertFrame(items[0].marker, rect(0, 109, 6, 25))
        assertFrame(items[0].text, rect(14, 108, 286, 25))
        assertFrame(items[1].marker, rect(16, 141, 6, 25))
        assertFrame(items[1].text, rect(30, 140, 270, 25))

        guard case .code(let code) = layout.blocks[4] else { return XCTFail() }
        assertFrame(code.frame, rect(0, 182, 300, 96))
        assertFrame(code.language, rect(16, 8, 268, 16))
        assertFrame(code.scroll, rect(0, 24, 300, 72))
        assertSize(code.contentSize, CGSize(width: 432, height: 72))
        assertFrame(code.text, rect(16, 16, 400, 40))

        guard case .options(let optionsFrame, let buttons, let labels) = layout.blocks[5] else { return XCTFail() }
        assertFrame(optionsFrame, rect(0, 294, 300, 88))
        assertFrame(buttons[0], rect(0, 294, 300, 40))
        assertFrame(labels[0], rect(12, 302, 276, 24))
        assertFrame(buttons[1], rect(0, 342, 300, 40))
        assertFrame(labels[1], rect(12, 350, 276, 24))

        guard case .image(let imageFrame, let picture, let caption) = layout.blocks[6] else { return XCTFail() }
        assertFrame(imageFrame, rect(0, 398, 300, 268))
        assertFrame(picture, rect(0, 0, 300, 240))
        assertFrame(caption, rect(0, 248, 300, 20))

        assertSize(layout.size, CGSize(width: 300, height: 674))
    }

    func testAMermaidDiagramIs200TallUntilItsPageSaysMoreAndScrollsPast600() {
        let layout = MarkdownLayout(width: 300, blocks: [
            .mermaid(reported: nil),
            .mermaid(reported: 120),
            .mermaid(reported: 345.5),
            .mermaid(reported: 1800),
        ])
        assertFrame(layout.blocks[0].frame, rect(0, 8, 300, 200))
        assertFrame(layout.blocks[1].frame, rect(0, 224, 300, 200))
        assertFrame(layout.blocks[2].frame, rect(0, 440, 300, 345.5))
        assertFrame(layout.blocks[3].frame, rect(0, 801.5, 300, 600))
        assertSize(layout.size, CGSize(width: 300, height: 1409.5))
    }

    func testOnlyAMermaidHeightThatGrowsTheBoxIsKept() {
        XCTAssertNil(MarkdownLayout.mermaidHeightToKeep(reported: 180, kept: nil, scale: 3), "200 is shown anyway")
        XCTAssertNil(MarkdownLayout.mermaidHeightToKeep(reported: 200, kept: nil, scale: 3))
        XCTAssertEqual(MarkdownLayout.mermaidHeightToKeep(reported: 345.1, kept: nil, scale: 3)!, 1036.0 / 3, accuracy: 0.0001)
        XCTAssertNil(MarkdownLayout.mermaidHeightToKeep(reported: 345.1, kept: 1036.0 / 3, scale: 3), "the same pixel again")
        XCTAssertNil(MarkdownLayout.mermaidHeightToKeep(reported: 300, kept: 345, scale: 3), "never shrinks")
        XCTAssertEqual(MarkdownLayout.mermaidHeightToKeep(reported: 5000, kept: 345, scale: 2), 600)
        XCTAssertNil(MarkdownLayout.mermaidHeightToKeep(reported: 5100, kept: 600, scale: 2), "past the cap the page scrolls")
        XCTAssertNil(MarkdownLayout.mermaidHeightToKeep(reported: .nan, kept: nil, scale: 2))
    }

    func testAMermaidDiagramTakesTheWholeWidth() {
        XCTAssertEqual(MarkdownLayout.naturalWidth(of: [.text(text("hi", lineHeight: 25)), .mermaid(reported: nil)], available: 280), 280)
    }

    func testShortCodeKeepsTheBlockFullWidth() {
        let layout = MarkdownLayout(width: 300, blocks: [.code(language: nil, code: CGSize(width: 50, height: 20))])
        guard case .code(let code) = layout.blocks[0] else { return XCTFail() }
        assertFrame(code.frame, rect(0, 8, 300, 52))
        XCTAssertNil(code.language)
        assertSize(code.contentSize, CGSize(width: 300, height: 52))
    }

    func testAVeryLongLineOfCodeIsCutOff() {
        let layout = MarkdownLayout(width: 300, blocks: [.code(language: nil, code: CGSize(width: 90_000, height: 20))])
        guard case .code(let code) = layout.blocks[0] else { return XCTFail() }
        assertSize(code.contentSize, CGSize(width: 4128, height: 52))
        assertFrame(code.text, rect(16, 16, 4096, 20))
    }

    func testTableGrid() {
        let layout = MarkdownLayout(width: 300, blocks: [.table(.init(
            columnWidths: [80, 120],
            rows: [
                [text("A", lineHeight: 24), text("B", lineHeight: 24)],
                [text("1", lineHeight: 24), text("2", lineHeight: 24)],
            ]
        ))])
        guard case .table(let table) = layout.blocks[0] else { return XCTFail() }
        assertFrame(table.frame, rect(0, 8, 202, 83))
        assertFrame(table.scroll, rect(1, 1, 200, 81))
        assertSize(table.contentSize, CGSize(width: 200, height: 81))
        assertFrame(table.cells[0][0], rect(12, 8, 55, 24))
        assertFrame(table.cells[0][1], rect(92, 8, 96, 24))
        assertFrame(table.cells[1][0], rect(12, 49, 55, 24))
        assertFrame(table.rows[0], rect(0, 0, 200, 41))
        assertFrame(table.rows[1], rect(0, 41, 200, 40))
        XCTAssertEqual(table.separators, [
            rect(79, 0, 1, 41), rect(0, 40, 200, 1),
            rect(79, 41, 1, 40),
        ])
        XCTAssertEqual(layout.size.height, 99)
    }

    func testAWideTableScrollsInsideTheColumn() {
        let layout = MarkdownLayout(width: 300, blocks: [.table(.init(columnWidths: [200, 200], rows: [[fixed(10, 24), fixed(10, 24)]]))])
        guard case .table(let table) = layout.blocks[0] else { return XCTFail() }
        assertFrame(table.frame, rect(0, 8, 300, 43))
        assertFrame(table.scroll, rect(1, 1, 298, 41))
        assertSize(table.contentSize, CGSize(width: 400, height: 41))
    }

    func testColumnWidthsFromCharacterCounts() {
        XCTAssertEqual(MarkdownLayout.columnWidths(lengths: [[1, 6], [3, 40]]), [80, 360])
        XCTAssertEqual(MarkdownLayout.columnWidths(lengths: [[10]]), [109])
        XCTAssertEqual(MarkdownLayout.columnWidths(lengths: []), [])
    }

    func testNaturalWidthIsTheWidestBlock() {
        let blocks: [MarkdownLayout.Block] = [
            .text(text("hello", lineHeight: 25)),
            .list([.init(depth: 1, marker: fixed(6, 25), text: text("abc", lineHeight: 25))]),
            .code(language: nil, code: CGSize(width: 100, height: 20)),
        ]
        XCTAssertEqual(MarkdownLayout.naturalWidth(of: blocks, available: 300), 132)
        XCTAssertEqual(MarkdownLayout.naturalWidth(of: blocks, available: 100), 100)
        XCTAssertEqual(MarkdownLayout.naturalWidth(of: [.rule], available: 300), 0)
    }
}

final class MessageRowLayoutTests: XCTestCase {
    func testAUserBubbleHugsItsTextOnTheRight() {
        let layout = UserMessageLayout(.init(width: 393, content: .text([.text(text("Hi there", lineHeight: 25))])))
        XCTAssertNil(layout.author)
        assertFrame(layout.bubble, rect(289, 6, 88, 51))
        XCTAssertEqual(layout.markdownOrigin, CGPoint(x: 301, y: 10))
        assertSize(layout.markdown!.size, CGSize(width: 64, height: 43))
        assertFrame(layout.status, rect(16, 63, 361, 14))
        assertSize(layout.size, CGSize(width: 393, height: 81))
        XCTAssertFalse(layout.alignsLeft)
    }

    func testAnotherParticipantsMessageSitsLeftUnderTheirName() {
        let layout = UserMessageLayout(.init(width: 393, author: text("Ann", lineHeight: 20), content: .text([.text(text("Hi there", lineHeight: 25))])))
        assertFrame(layout.author, rect(28, 6, 24, 20))
        assertFrame(layout.bubble, rect(16, 30, 88, 51))
        assertFrame(layout.status, rect(16, 87, 361, 14))
        XCTAssertEqual(layout.size.height, 105)
        XCTAssertTrue(layout.alignsLeft)
    }

    func testALongMessageFillsTheColumn() {
        let layout = UserMessageLayout(.init(width: 393, content: .text([.text(text(String(repeating: "a", count: 60), lineHeight: 25))])))
        // 337 available → 42 characters a line, two lines.
        assertFrame(layout.bubble, rect(17, 6, 360, 76))
    }

    func testACommandIsAChip() {
        let layout = UserMessageLayout(.init(width: 393, content: .command(chip: text("/clear", lineHeight: 16), arguments: nil)))
        XCTAssertNil(layout.bubble)
        assertFrame(layout.chip, rect(307, 6, 70, 22))
        assertFrame(layout.chipLabel, rect(318, 9, 48, 16))
        assertFrame(layout.status, rect(16, 34, 361, 14))
        XCTAssertEqual(layout.size.height, 52)
    }

    func testACommandsArgumentsSitAboveItsChip() {
        let layout = UserMessageLayout(.init(width: 393, content: .command(chip: text("/review", lineHeight: 16), arguments: [.text(text("the diff", lineHeight: 25))])))
        assertFrame(layout.bubble, rect(289, 6, 88, 51))
        assertFrame(layout.chip, rect(299, 63, 78, 22))
    }

    func testAGoalSaysItWasSentAsOne() {
        let layout = UserMessageLayout(.init(width: 393, content: .goal([.text(text("ship it", lineHeight: 25))], sentLabel: text("Sent as a goal", lineHeight: 17))))
        assertFrame(layout.bubble, rect(297, 6, 80, 51))
        assertFrame(layout.goalIcon, rect(241, 63.5, 16, 16))
        assertFrame(layout.goalLabel, rect(265, 63, 112, 17))
        assertFrame(layout.status, rect(16, 86, 361, 14))
        XCTAssertEqual(layout.size.height, 104)
    }

    func testAgentText() {
        let layout = AgentTextLayout(width: 393, blocks: [.text(text("Done.", lineHeight: 25))])
        XCTAssertEqual(layout.markdownOrigin, CGPoint(x: 16, y: 10))
        assertSize(layout.markdown.size, CGSize(width: 361, height: 43))
        assertFrame(layout.copyButton, rect(16, 53, 16, 20))
        assertFrame(layout.copyIcon, rect(16, 55, 16, 16))
        XCTAssertEqual(layout.size.height, 83)
    }

    func testRowsCentreInAWideWindow() {
        let column = ChatColumn(rowWidth: 1000, maxContentWidth: 800)
        XCTAssertEqual(column, ChatColumn(rowWidth: 1000, maxContentWidth: 800))
        XCTAssertEqual(column.x, 100)
        XCTAssertEqual(column.width, 800)
        let layout = AgentTextLayout(width: 1000, maxContentWidth: 800, blocks: [])
        XCTAssertEqual(layout.markdownOrigin.x, 116)
    }

    func testAnEventLineIsCentred() {
        let layout = ChatEventLayout(width: 393, label: text("Switched to plan", lineHeight: 17))
        assertFrame(layout.label, rect(132.5, 8, 128, 17))
        XCTAssertEqual(layout.size.height, 33)
    }

    func testWorkGroupHeaderIsAlways44() {
        let layout = WorkGroupHeaderLayout(width: 393, label: text("Worked for 3s", lineHeight: 20))
        assertFrame(layout.header, rect(16, 8, 361, 28))
        assertFrame(layout.label, rect(16, 12, 104, 20))
        assertFrame(layout.chevron, rect(126, 15.5, 13, 13))
        XCTAssertEqual(layout.size.height, 44)
    }

    func testChatFooter() {
        XCTAssertEqual(ChatFooterLayout(width: 393, warning: nil).size.height, 6)
        let layout = ChatFooterLayout(width: 393, warning: text("Warn", lineHeight: 15))
        assertFrame(layout.warning, rect(157.5, 8, 78, 24))
        assertFrame(layout.icon, rect(169.5, 12, 16, 16))
        assertFrame(layout.label, rect(191.5, 12.5, 32, 15))
        XCTAssertEqual(layout.size.height, 34)
    }

    func testOlderEndSlot() {
        let layout = ChatOlderEndLayout(width: 393, control: CGSize(width: 20, height: 20))
        assertFrame(layout.control, rect(186.5, 6, 20, 20))
        XCTAssertEqual(layout.size.height, 32)
    }
}

final class FileViewLayoutTests: XCTestCase {
    func testThePictureKeepsItsShapeInsideTheBox() {
        assertSize(FileViewLayout.imageSize(width: 1000, height: 500), CGSize(width: 280, height: 140))
        assertSize(FileViewLayout.imageSize(width: 300, height: 1200), CGSize(width: 90, height: 360))
        assertSize(FileViewLayout.imageSize(width: 100, height: 50), CGSize(width: 100, height: 50))
        assertSize(FileViewLayout.imageSize(width: nil, height: nil), CGSize(width: 280, height: 210))
        // A width without a height keeps its width at 4:3.
        assertSize(FileViewLayout.imageSize(width: 200, height: 0), CGSize(width: 200, height: 150))
    }

    func testTheNameSitsUnderThePicture() {
        let layout = FileViewLayout(width: 361, imageWidth: 1000, imageHeight: 500, name: text("photo.png", lineHeight: 16, maxLines: 1))
        assertFrame(layout.image, rect(12, 8, 280, 140))
        assertFrame(layout.name, rect(12, 152, 337, 16))
        assertSize(layout.size, CGSize(width: 361, height: 176))
        assertFrame(FileViewLayout.badge(in: layout.image.size), rect(252, 4, 24, 24))

        let narrow = FileViewLayout(width: 164, imageWidth: nil, imageHeight: nil, name: text("a", lineHeight: 16))
        // Never wider than the row.
        assertFrame(narrow.image, rect(12, 8, 140, 105))
    }

    func testAPictureIsDecodedNoLargerThanItIsDrawn() {
        // A 12 MP photo: 840 x 1080 is the most it is drawn at 3x.
        assertSize(FileViewLayout.decodedSize(CGSize(width: 4032, height: 3024)), CGSize(width: 840, height: 630))
        assertSize(FileViewLayout.decodedSize(CGSize(width: 1170, height: 2532)), CGSize(width: 499, height: 1080))
        assertSize(FileViewLayout.decodedSize(CGSize(width: 300, height: 200)), CGSize(width: 300, height: 200))
        assertSize(FileViewLayout.decodedSize(.zero), .zero)
    }
}

final class ToolRowLayoutTests: XCTestCase {
    func testAToolCard() {
        let layout = ToolCardLayout(.init(
            width: 393,
            header: .init(
                title: text("Bash", lineHeight: 17),
                description: text("run tests", lineHeight: 16),
                elapsed: text("1.2s", lineHeight: 16),
                statusIcon: CGSize(width: 20, height: 20)
            ),
            body: block(height: 50),
            footer: block(height: 40)
        ))
        assertFrame(layout.header, rect(0, 0, 377, 59))
        assertFrame(layout.icon, rect(12, 17.5, 24, 24))
        assertFrame(layout.title, rect(44, 12, 245, 17))
        assertFrame(layout.description, rect(44, 31, 245, 16))
        assertFrame(layout.elapsed, rect(305, 21.5, 32, 16))
        assertFrame(layout.statusIcon, rect(345, 19.5, 20, 20))
        assertFrame(layout.body, rect(12, 67, 353, 50))
        assertFrame(layout.footer, rect(0, 117, 377, 40))
        assertFrame(layout.card, rect(8, 8, 377, 157))
        XCTAssertEqual(layout.size.height, 173)
    }

    func testAnAttachmentHasNoCard() {
        let layout = ToolCardLayout(.init(width: 393, header: nil, body: block(height: 50), footer: nil, inline: true))
        XCTAssertNil(layout.header)
        assertFrame(layout.body, rect(0, 0, 377, 50))
        assertFrame(layout.card, rect(8, 1, 377, 50))
        XCTAssertEqual(layout.size.height, 52)
    }

    func testACompactActivityRow() {
        let layout = CompactToolRowLayout(width: 393, label: text("npm test", lineHeight: 20), elapsed: text("2.0s", lineHeight: 16), statusIcon: CGSize(width: 20, height: 20), footer: nil)
        assertFrame(layout.header, rect(8, 2, 377, 28))
        assertFrame(layout.icon, rect(16, 6, 20, 20))
        assertFrame(layout.label, rect(46, 6, 251, 20))
        assertFrame(layout.elapsed, rect(315, 8, 32, 16))
        assertFrame(layout.statusIcon, rect(357, 6, 20, 20))
        XCTAssertNil(layout.footer)
        XCTAssertEqual(layout.size.height, 32)
    }

    func testACompactRowKeepsItsPermissionFooter() {
        let layout = CompactToolRowLayout(width: 393, label: text("x", lineHeight: 20), elapsed: nil, statusIcon: nil, footer: block(height: 46))
        assertFrame(layout.footer, rect(8, 30, 377, 46))
        XCTAssertEqual(layout.size.height, 78)
    }

    func testAnOpenedCompactRowShowsItsBodyInABox() {
        let layout = CompactToolRowLayout(width: 393, label: text("x", lineHeight: 20), elapsed: nil, statusIcon: nil, body: block(height: 60), footer: block(height: 46))
        assertFrame(layout.header, rect(8, 2, 377, 28))
        assertFrame(layout.bodyBox, rect(8, 32, 377, 68))
        assertFrame(layout.body, rect(20, 40, 353, 60))
        assertFrame(layout.footer, rect(8, 100, 377, 46))
        XCTAssertEqual(layout.size.height, 148)
    }

    func testAStackOfBoxes() {
        let layout = ChatStackLayout(width: 300, items: [
            .init(block(height: 20), marginBottom: 12),
            .init(fixed(100, 30), padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12), placement: .leading),
            .init(fixed(50, 10), marginTop: 8, placement: .center),
        ])
        XCTAssertEqual(layout.boxes, [rect(0, 0, 300, 20), rect(0, 32, 124, 54), rect(125, 94, 50, 10)])
        XCTAssertEqual(layout.contents, [rect(0, 0, 300, 20), rect(12, 44, 100, 30), rect(125, 94, 50, 10)])
        assertSize(layout.size, CGSize(width: 300, height: 104))
    }

    func testAFullWidthSectionRunsToTheCardsEdgesUnderItsHeader() {
        // ToolSectionView fullWidth: -12 either side, -8 on top, 12 below,
        // inside a card body that is 12 in and 8 down.
        let layout = ChatStackLayout(width: 329, items: [
            .init(block(height: 120), marginTop: -8, marginBottom: 12, padding: LayoutInsets(top: 0, left: -12, bottom: 0, right: -12)),
        ])
        assertFrame(layout.contents[0], rect(-12, -8, 353, 120))
        assertSize(layout.size, CGSize(width: 329, height: 124))
    }

    func testAClippedBox() {
        let layout = ChatStackLayout(width: 300, items: [
            .init(block(height: 200), padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12), maxHeight: 115),
        ])
        assertFrame(layout.boxes[0], rect(0, 0, 300, 115))
        assertFrame(layout.contents[0], rect(12, 12, 276, 91))
    }

    func testAnErrorLineHangsItsGlyphAtTheTop() {
        let layout = ChatAccessoryRowLayout(width: 300, leading: CGSize(width: 16, height: 16), text: .fixed(width: 200, height: 36), alignment: .top)
        XCTAssertEqual(layout.leading, rect(0, 0, 16, 16))
        // The text takes the rest of the line (flex: 1).
        XCTAssertEqual(layout.text, rect(24, 0, 276, 36))
        XCTAssertNil(layout.trailing)
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 36))
    }

    func testATaskLineCentresItsStatusAtTheEnd() {
        let layout = ChatAccessoryRowLayout(width: 300, text: Measurable { CGSize(width: $0, height: 17) }, trailing: CGSize(width: 20, height: 20))
        XCTAssertEqual(layout.text, rect(0, 1.5, 272, 17))
        XCTAssertEqual(layout.trailing, rect(280, 0, 20, 20))
        XCTAssertEqual(layout.size.height, 20)
    }

    func testPermissionButtonsStretchAndGrowForTwoLines() {
        let layout = PermissionFooterLayout(width: 377, labels: [
            text("Yes", lineHeight: 18),
            text(String(repeating: "x", count: 50), lineHeight: 18, maxLines: 2),
        ])
        assertFrame(layout.buttons[0], rect(6, 4, 365, 34))
        assertFrame(layout.labels[0], rect(176.5, 12, 24, 18))
        assertFrame(layout.buttons[1], rect(6, 45, 365, 52))
        assertFrame(layout.labels[1], rect(20.5, 53, 336, 36))
        XCTAssertEqual(layout.size.height, 105)
        assertFrame(layout.list, rect(6, 4, 365, 93))
        XCTAssertFalse(layout.scrolls)
    }

    func testTheListIsAtMost260OrAThirdAndABitOfTheWindow() {
        XCTAssertEqual(PermissionFooterLayout.maxListHeight(windowHeight: 852), 260)
        // An iPhone SE in landscape: round(375 * 0.35) = 131.
        XCTAssertEqual(PermissionFooterLayout.maxListHeight(windowHeight: 375), 131)
        XCTAssertEqual(PermissionFooterLayout.maxListHeight(windowHeight: 667), 233)
    }

    func testALongPermissionListScrollsInsideTheCap() {
        // Five 34-tall buttons, 7 apart: 198 of list.
        let labels = Array(repeating: text("Yes", lineHeight: 18), count: 5)
        let layout = PermissionFooterLayout(width: 377, labels: labels, maxListHeight: 131)
        XCTAssertEqual(layout.listContentHeight, 198)
        assertFrame(layout.list, rect(6, 4, 365, 131))
        XCTAssertTrue(layout.scrolls)
        XCTAssertEqual(layout.size.height, 143)
        // The buttons keep their places in the list, scrolled to its top.
        assertFrame(layout.buttons[4], rect(6, 168, 365, 34))

        let roomy = PermissionFooterLayout(width: 377, labels: labels, maxListHeight: 260)
        XCTAssertFalse(roomy.scrolls)
        XCTAssertEqual(roomy.size.height, 210)
    }
}

final class ChatScreenLayoutTests: XCTestCase {
    private func screen(keyboardTop: CGFloat?) -> ChatScreenLayout {
        ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: keyboardTop, accessories: [.inset(block(height: 60))], composerHeight: 70))
    }

    func testTheDockRestsOnTheSafeArea() {
        let layout = screen(keyboardTop: nil)
        assertFrame(layout.list, rect(0, 0, 393, 852))
        assertFrame(layout.accessories[0], rect(8, 0, 377, 60))
        assertFrame(layout.composer, rect(0, 60, 393, 70))
        assertFrame(layout.dock, rect(0, 688, 393, 130))
        XCTAssertEqual(layout.newestEdgeInset, 172)
        XCTAssertEqual(layout.oldestEdgeInset, 115)
        // 16 above the composer, over the accessories' band.
        assertFrame(layout.scrollButton, rect(180.5, 700, 32, 32))
        assertFrame(layout.scrim, rect(0, 660, 393, 192))
    }

    func testTheRigActivityBarRunsFullWidthUnderTheInsetBars() {
        let layout = ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: nil, accessories: [.inset(block(height: 57)), .fullWidth(block(height: 23))], composerHeight: 70))
        XCTAssertEqual(layout.accessories, [rect(8, 0, 377, 57), rect(0, 57, 393, 23)])
        assertFrame(layout.composer, rect(0, 80, 393, 70))
        assertFrame(layout.dock, rect(0, 668, 393, 150))
    }

    func testTheScrollButtonSitsAboveTheComposerCard() {
        let layout = ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: nil, composerHeight: 70, composerCardOffset: 20))
        assertFrame(layout.dock, rect(0, 748, 393, 70))
        assertFrame(layout.scrollButton, rect(180.5, 720, 32, 32))
    }

    func testOnATabletTheListStopsAtTheDock() {
        // An iPad's chat: 1024 by 768, status bar 24 and a 50 bar.
        let layout = ChatScreenLayout(.init(
            size: CGSize(width: 664, height: 768), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0), keyboardTop: nil,
            accessories: [.inset(block(height: 60))], composerHeight: 70, composerCardOffset: 20, docked: true, accessoryPaddingH: 12
        ))
        assertFrame(layout.accessories[0], rect(12, 0, 640, 60))
        assertFrame(layout.dock, rect(0, 618, 664, 130))
        assertFrame(layout.list, rect(0, 74, 664, 544))
        XCTAssertEqual(layout.newestEdgeInset, 8)
        XCTAssertEqual(layout.oldestEdgeInset, 106)
        // 4 above the list's bottom.
        assertFrame(layout.scrollButton, rect(316, 582, 32, 32))
        XCTAssertEqual(layout.scrim.height, 0)
        XCTAssertEqual(layout.headerScrim.height, 0)
        assertFrame(layout.placeholder, rect(0, 74, 664, 544))
        XCTAssertNil(layout.backButton)
        XCTAssertNil(layout.statusBarShadow)
    }

    func testAPhoneOnItsSideHasNoHeader() {
        // An iPhone SE held sideways: below the tablet width, no status bar.
        let layout = ChatScreenLayout(.init(
            size: CGSize(width: 667, height: 375), safeArea: LayoutInsets(top: 0, left: 0, bottom: 0, right: 0), keyboardTop: nil,
            accessories: [.inset(block(height: 60))], composerHeight: 70, composerCardOffset: 20, hidesHeader: true
        ))
        assertFrame(layout.dock, rect(0, 245, 667, 130))
        assertFrame(layout.list, rect(0, 0, 667, 245))
        XCTAssertEqual(layout.newestEdgeInset, 8)
        // chatListTopContentInset's 12, with nothing above it.
        XCTAssertEqual(layout.oldestEdgeInset, 12)
        assertFrame(layout.scrollButton, rect(317.5, 209, 32, 32))
        XCTAssertEqual(layout.scrim.height, 0)
        XCTAssertEqual(layout.headerScrim.height, 0)
        assertFrame(layout.placeholder, rect(0, 0, 667, 245))
        XCTAssertEqual(layout.backButton, rect(16, 8, 44, 44))
        XCTAssertEqual(layout.statusBarShadow, rect(0, 0, 667, 0))
    }

    func testWithoutTheHeaderTheListStartsUnderTheStatusBar() {
        // A short, wide window with a status bar (Stage Manager).
        let layout = ChatScreenLayout(.init(
            size: CGSize(width: 700, height: 500), safeArea: LayoutInsets(top: 24, left: 0, bottom: 20, right: 0), keyboardTop: nil,
            composerHeight: 70, hidesHeader: true
        ))
        assertFrame(layout.dock, rect(0, 410, 700, 70))
        assertFrame(layout.list, rect(0, 24, 700, 386))
        XCTAssertEqual(layout.oldestEdgeInset, 12)
        XCTAssertEqual(layout.backButton, rect(16, 32, 44, 44))
        XCTAssertEqual(layout.statusBarShadow, rect(0, 0, 700, 24))
        // The keyboard still carries the dock.
        let typing = ChatScreenLayout(.init(
            size: CGSize(width: 700, height: 500), safeArea: LayoutInsets(top: 24, left: 0, bottom: 20, right: 0), keyboardTop: 300,
            composerHeight: 70, hidesHeader: true
        ))
        assertFrame(typing.dock, rect(0, 230, 700, 70))
        assertFrame(typing.list, rect(0, 24, 700, 206))
    }

    func testTheTabStripHangsUnderTheHeader() {
        let layout = ChatScreenLayout(.init(
            size: phone, safeArea: phoneUnderBar, keyboardTop: nil, accessories: [.inset(block(height: 60))], composerHeight: 70,
            headerAccessory: WorktreeTabStripLayout.Metrics.height
        ))
        assertFrame(layout.headerAccessory, rect(0, 103, 393, 56))
        XCTAssertEqual(layout.headerBottom, 159)
        // chatListTopContentInset's headerAccessoryHeight: the oldest end
        // clears the strip too.
        XCTAssertEqual(layout.oldestEdgeInset, 171)
        assertFrame(layout.list, rect(0, 0, 393, 852))
        assertFrame(layout.placeholder, rect(0, 159, 393, 529))
        // The scrim stays the header's own.
        assertFrame(layout.headerScrim, rect(0, 0, 393, 111))
    }

    func testOnATabletTheListStartsUnderTheStrip() {
        let layout = ChatScreenLayout(.init(
            size: CGSize(width: 664, height: 768), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0), keyboardTop: nil,
            composerHeight: 70, docked: true, accessoryPaddingH: 12, headerAccessory: 56
        ))
        assertFrame(layout.headerAccessory, rect(0, 74, 664, 56))
        assertFrame(layout.list, rect(0, 130, 664, 548))
        // OlderEnd's fallback spacer doesn't count the strip.
        XCTAssertEqual(layout.oldestEdgeInset, 106)
    }

    func testWithoutTheHeaderNothingHangsUnderIt() {
        let layout = ChatScreenLayout(.init(
            size: CGSize(width: 667, height: 375), safeArea: LayoutInsets(), keyboardTop: nil,
            composerHeight: 70, hidesHeader: true, headerAccessory: 56
        ))
        XCTAssertNil(layout.headerAccessory)
        XCTAssertEqual(layout.headerBottom, 0)
        assertFrame(layout.list, rect(0, 0, 667, 305))
        XCTAssertEqual(layout.oldestEdgeInset, 12)
    }

    func testTheDockRidesTheKeyboard() {
        let layout = screen(keyboardTop: 500)
        assertFrame(layout.dock, rect(0, 370, 393, 130))
        XCTAssertEqual(layout.newestEdgeInset, 490)
        // Dragged nearly closed: never below the safe area.
        assertFrame(screen(keyboardTop: 830).dock, rect(0, 688, 393, 130))
    }

    func testDockDetailsHysteresis() {
        XCTAssertTrue(ChatScreenLayout.dockDetailsVisible(distanceFromNewest: 30, currentlyVisible: true))
        XCTAssertFalse(ChatScreenLayout.dockDetailsVisible(distanceFromNewest: 60, currentlyVisible: true))
        XCTAssertFalse(ChatScreenLayout.dockDetailsVisible(distanceFromNewest: 30, currentlyVisible: false))
        XCTAssertTrue(ChatScreenLayout.dockDetailsVisible(distanceFromNewest: 10, currentlyVisible: false))
        XCTAssertFalse(ChatScreenLayout.showsScrollButton(distanceFromNewest: 300))
        XCTAssertTrue(ChatScreenLayout.showsScrollButton(distanceFromNewest: 301))
    }

    func testQuestionBanner() {
        let layout = QuestionBannerLayout(width: 377, title: text("Pick one", lineHeight: 18), subtitle: text("Which db?", lineHeight: 17), trailing: fixed(18, 18))
        assertFrame(layout.card, rect(12, 0, 353, 57))
        assertFrame(layout.icon, rect(27, 18.5, 20, 20))
        assertFrame(layout.title, rect(59, 11, 265, 18))
        assertFrame(layout.subtitle, rect(59, 29, 265, 17))
        assertFrame(layout.trailing, rect(334, 19.5, 18, 18))
        XCTAssertEqual(layout.size.height, 65)
    }

    func testGoalBar() {
        let layout = GoalBarLayout(width: 377, label: text("Current goal", lineHeight: 16), text: text("Ship", lineHeight: 19), actionCount: 2)
        assertFrame(layout.card, rect(0, 0, 377, 57))
        assertFrame(layout.icon, rect(13, 19.5, 18, 18))
        assertFrame(layout.label, rect(41, 11, 249, 16))
        assertFrame(layout.text, rect(41, 27, 249, 19))
        XCTAssertEqual(layout.actions, [rect(300, 13.5, 30, 30), rect(334, 13.5, 30, 30)])
        XCTAssertEqual(layout.size.height, 65)
    }

    func testRigActivityWraps() {
        let layout = RigActivityLayout(width: 200, labels: [
            text("2 agents", lineHeight: 13),
            text("1 processes", lineHeight: 13),
            text("3 tasks", lineHeight: 13),
        ])
        XCTAssertEqual(layout.icons, [rect(16, 5.5, 12, 12), rect(16, 28.5, 12, 12), rect(16, 51.5, 12, 12)])
        XCTAssertEqual(layout.labels, [rect(32, 5, 64, 13), rect(32, 28, 88, 13), rect(32, 51, 56, 13)])
        XCTAssertEqual(layout.size.height, 69)
        XCTAssertEqual(RigActivityLayout(width: 200, labels: []).size.height, 0)
    }
}

final class ChatTokenTests: XCTestCase {
    func testChatColoursParse() {
        let invalid = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in Palette.chat {
            XCTAssertNotEqual(token.light, invalid)
            XCTAssertNotEqual(token.dark, invalid)
        }
    }
}

final class QuestionSheetLayoutTests: XCTestCase {
    private func sheet(keyboardTop: CGFloat? = nil) -> QuestionSheetLayout {
        QuestionSheetLayout(.init(
            size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 59, bottom: 34), keyboardTop: keyboardTop, hairline: 0.5,
            cancel: text("Cancel", lineHeight: 20), title: text("Question", lineHeight: 20), submit: text("Send answer", lineHeight: 20),
            questions: [
                .init(
                    chip: text("SCOPE", lineHeight: 16), showsDot: true, text: text("Which part?", lineHeight: 22),
                    options: [
                        .init(label: text("List", lineHeight: 20)),
                        .init(label: text("Composer", lineHeight: 20), description: text("The input", lineHeight: 18)),
                    ],
                    custom: (label: text("Your own answer", lineHeight: 18), text: text("", lineHeight: 20))
                ),
                .init(chip: text("NAME", lineHeight: 16), showsDot: false, text: text("What?", lineHeight: 22), hint: text("Choose as many as apply", lineHeight: 18), options: []),
            ],
            error: text("Could not send", lineHeight: 20)
        ))
    }

    func testTheHeaderAndFooterFrameTheQuestions() {
        let layout = sheet()
        assertFrame(layout.cancel, rect(16, 73, 48, 20))
        assertFrame(layout.title, rect(158.5, 73, 64, 20))
        assertFrame(layout.header, rect(0, 59, 393, 48.5))
        assertFrame(layout.headerDivider, rect(0, 107, 393, 0.5))
        assertFrame(layout.footer, rect(0, 743.5, 393, 108.5))
        assertFrame(layout.footerDivider, rect(0, 743.5, 393, 0.5))
        assertFrame(layout.submit, rect(16, 756, 361, 50))
        assertFrame(layout.submitLabel, rect(152.5, 771, 88, 20))
        assertFrame(layout.scroll, rect(0, 107.5, 393, 636))
    }

    func testQuestionsStackWithTheirOptionsAndOwnAnswer() {
        let layout = sheet()
        let first = layout.questions[0]
        assertFrame(first.chip, rect(16, 16, 56, 24))
        assertFrame(first.chipText, rect(24, 20, 40, 16))
        assertFrame(first.dot, rect(80, 25, 6, 6))
        assertFrame(first.text, rect(16, 48, 361, 22))
        XCTAssertNil(first.hint)
        assertFrame(first.options[0].box, rect(16, 78, 361, 51))
        assertFrame(first.options[0].checkbox, rect(30, 93, 22, 22))
        assertFrame(first.options[0].label, rect(64, 92, 299, 20))
        XCTAssertNil(first.options[0].description)
        assertFrame(first.options[1].box, rect(16, 137, 361, 68))
        assertFrame(first.options[1].description, rect(64, 173, 299, 18))
        assertFrame(first.customLabel, rect(16, 217, 361, 18))
        assertFrame(first.input, rect(16, 241, 361, 48))
        let second = layout.questions[1]
        assertFrame(second.chip, rect(16, 317, 48, 24))
        XCTAssertNil(second.dot)
        assertFrame(second.hint, rect(16, 379, 361, 18))
        XCTAssertNil(second.input)
        assertFrame(layout.error, rect(16, 425, 361, 20))
        XCTAssertEqual(layout.contentSize, CGSize(width: 393, height: 575))
    }

    func testTheFooterRidesTheKeyboard() {
        let layout = sheet(keyboardTop: 500)
        assertFrame(layout.footer, rect(0, 425.5, 393, 74.5))
        assertFrame(layout.submit, rect(16, 438, 361, 50))
        assertFrame(layout.scroll, rect(0, 107.5, 393, 318))
    }
}

final class ChatHeaderLayoutTests: XCTestCase {
    func testTheCapsuleHugsATitleAlone() {
        let layout = ChatHeaderTitleLayout(maxWidth: 245, title: text("Fix the login", lineHeight: 20, maxLines: 1), subtitle: nil, changes: nil)
        assertSize(layout.size, CGSize(width: 132, height: 44))
        assertFrame(layout.title, rect(14, 12, 104, 20))
        XCTAssertNil(layout.subtitle)
        XCTAssertNil(layout.changes)
    }

    func testTheBranchAndLineChangesShareARowUnderTheTitle() {
        let layout = ChatHeaderTitleLayout(maxWidth: 245, title: text("Chat", lineHeight: 20, maxLines: 1), subtitle: text("main", lineHeight: 14, maxLines: 1), changes: CGSize(width: 40, height: 13))
        assertSize(layout.size, CGSize(width: 104, height: 44))
        assertFrame(layout.title, rect(36, 5, 32, 20))
        assertFrame(layout.subtitle!, rect(14, 25, 32, 14))
        assertFrame(layout.changes!, rect(50, 25.5, 40, 13))
    }

    func testALongTitleStopsAtTheInsetAndTheBranchGivesWayToTheCounts() {
        XCTAssertEqual(ChatHeaderTitleLayout.maxWidth(headerWidth: 393), 245)
        let layout = ChatHeaderTitleLayout(
            maxWidth: ChatHeaderTitleLayout.maxWidth(headerWidth: 393),
            title: text(String(repeating: "t", count: 40), lineHeight: 20, maxLines: 1),
            subtitle: text(String(repeating: "b", count: 30), lineHeight: 14, maxLines: 1),
            changes: CGSize(width: 40, height: 13)
        )
        assertSize(layout.size, CGSize(width: 245, height: 44))
        assertFrame(layout.title, rect(14, 5, 217, 20))
        assertFrame(layout.subtitle!, rect(14, 25, 173, 14))
        assertFrame(layout.changes!, rect(191, 25.5, 40, 13))
    }

    func testTheHeaderScrimAndTheEmptyChatsPlace() {
        let layout = ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: nil, accessories: [.inset(block(height: 60))], composerHeight: 70))
        // The bar and 8 past it; the placeholder between the bar and the dock.
        assertFrame(layout.headerScrim, rect(0, 0, 393, 111))
        assertFrame(layout.placeholder, rect(0, 103, 393, 585))
        let typing = ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: 500, composerHeight: 70))
        assertFrame(typing.placeholder, rect(0, 103, 393, 327))
    }

    func testTheBackdropStrengthensOnceContentIsUnderTheHeader() {
        XCTAssertFalse(ChatScreenLayout.headerBackdropVisible(distanceFromOldest: 0))
        XCTAssertFalse(ChatScreenLayout.headerBackdropVisible(distanceFromOldest: 0.4))
        XCTAssertTrue(ChatScreenLayout.headerBackdropVisible(distanceFromOldest: 1))
    }
}

final class MessageDetailLayoutTests: XCTestCase {
    func testAToolSitsInAReadableColumn() {
        let phone = MessageDetailLayout(width: 393, kind: .tool, content: block(height: 300))
        assertFrame(phone.content, rect(16, 12, 361, 300))
        assertSize(phone.contentSize, CGSize(width: 393, height: 344))
        let pad = MessageDetailLayout(width: 1024, kind: .tool, content: block(height: 300))
        assertFrame(pad.content, rect(128, 12, 768, 300))
    }

    func testAnEditsDiffsRunEdgeToEdgeOnAPhone() {
        let phone = MessageDetailLayout(width: 393, kind: .wideTool, content: block(height: 300))
        assertFrame(phone.content, rect(0, 12, 393, 300))
        let pad = MessageDetailLayout(width: 1024, kind: .wideTool, content: block(height: 300), maxContentWidth: 800)
        assertFrame(pad.content, rect(128, 12, 768, 300))
    }

    func testATextMessageIsPaddedAllRound() {
        let layout = MessageDetailLayout(width: 393, kind: .text, content: block(height: 48))
        assertFrame(layout.content, rect(16, 16, 361, 48))
        assertSize(layout.contentSize, CGSize(width: 393, height: 80))
    }

    func testAMultiEditHeaderCarriesItsBadgeBesideTheNumber() {
        // "Edit 2 of 3" at 8 a character beside a 12-high "Replace All".
        let layout = MultiEditHeaderLayout(width: 361, number: text("Edit 2 of 3", lineHeight: 17), badge: text("Replace All", advance: 6, lineHeight: 15))
        assertFrame(layout.number, rect(0, 3, 88, 17))
        assertFrame(layout.badge, rect(96, 0, 82, 23))
        assertFrame(layout.badgeText, rect(104, 4, 66, 15))
        assertSize(layout.size, CGSize(width: 361, height: 23))

        let plain = MultiEditHeaderLayout(width: 361, number: text("Edit 1 of 3", lineHeight: 17), badge: nil)
        assertFrame(plain.number, rect(0, 0, 88, 17))
        XCTAssertNil(plain.badge)
        XCTAssertNil(plain.badgeText)
    }
}

final class TextSelectionLayoutTests: XCTestCase {
    func testTheCardRunsToTheFootOfTheScreenAndTheTextClearsTheHomeIndicator() {
        let layout = TextSelectionLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 103, left: 0, bottom: 34, right: 0))
        assertFrame(layout.card, rect(16, 119, 361, 717))
        XCTAssertEqual(layout.textInsets, LayoutInsets(top: 16, left: 16, bottom: 66, right: 16))
    }
}

final class TextChunksTests: XCTestCase {
    func testShortTextIsOnePiece() {
        XCTAssertEqual(TextChunks.split("one\ntwo\n"), ["one\ntwo\n"])
        XCTAssertEqual(TextChunks.split(""), [""])
    }

    func testLongTextIsCutAfterNewlines() {
        let text = (1...7).map { "line \($0)" }.joined(separator: "\n")
        let chunks = TextChunks.split(text, maxLines: 3, maxLength: 1000)
        XCTAssertEqual(chunks, ["line 1\nline 2\nline 3\n", "line 4\nline 5\nline 6\n", "line 7"])
        XCTAssertEqual(chunks.joined(), text)

        let wide = TextChunks.split("aaaaaa\nbb\ncc", maxLines: 40, maxLength: 5)
        XCTAssertEqual(wide, ["aaaaaa\n", "bb\ncc"], "past maxLength, the next newline ends the piece")
    }

    func testAVeryLongLineIsCutAfterItsLastSpace() {
        let line = "alpha beta gamma delta"
        XCTAssertEqual(TextChunks.split(line, maxLength: 6), ["alpha beta ", "gamma delta"])
        XCTAssertEqual(TextChunks.split("abcdefghij", maxLength: 2), ["abcd", "efgh", "ij"], "no space: cut anywhere")
        let emoji = String(repeating: "👍🏽", count: 5)
        XCTAssertEqual(TextChunks.split(emoji, maxLength: 4).joined(), emoji, "never inside a character")
    }

    func testAPieceDrawsWithoutTheNewlineThatEndsIt() {
        XCTAssertEqual(TextChunks.drawn("a\nb\n"), "a\nb")
        XCTAssertEqual(TextChunks.drawn("a\n\n"), "a\n ", "an empty last line keeps its height")
        XCTAssertEqual(TextChunks.drawn("\n"), " ")
        XCTAssertEqual(TextChunks.drawn("abc"), "abc", "cut inside a line: nothing to drop")
    }

    func testCutsAreWhatEachPieceDrawsInTheWholeText() {
        let text = "ab\n\ncd\r\nef 🙂\ng"
        let chunks = TextChunks.split(text, maxLines: 1, maxLength: 1000)
        XCTAssertEqual(chunks, ["ab\n", "\n", "cd\r\n", "ef 🙂\n", "g"])
        let cuts = TextChunks.cuts(chunks)
        XCTAssertEqual(cuts, [
            TextChunks.Cut(location: 0, length: 2, space: false),
            // An empty line: nothing kept, and a space for its height.
            TextChunks.Cut(location: 3, length: 0, space: true),
            // "\r\n" is one character but two units.
            TextChunks.Cut(location: 4, length: 2, space: false),
            TextChunks.Cut(location: 8, length: 5, space: false),
            // The last piece is drawn whole.
            TextChunks.Cut(location: 14, length: 1, space: false),
        ])
        let units = Array(text.utf16)
        for (chunk, cut) in zip(chunks, cuts) {
            let kept = String(decoding: units[cut.location..<(cut.location + cut.length)], as: UTF16.self)
            XCTAssertEqual(kept + (cut.space ? " " : ""), chunks.last == chunk ? chunk : TextChunks.drawn(chunk))
        }
    }

    func testAPieceCutInsideALineIsDrawnWhole() {
        XCTAssertEqual(TextChunks.cuts(["abcd", "efgh", "ij"]), [
            TextChunks.Cut(location: 0, length: 4, space: false),
            TextChunks.Cut(location: 4, length: 4, space: false),
            TextChunks.Cut(location: 8, length: 2, space: false),
        ])
        XCTAssertEqual(TextChunks.cuts([""]), [TextChunks.Cut(location: 0, length: 0, space: false)])
    }
}

final class CopyMenuLayoutTests: XCTestCase {
    private let window = CGSize(width: 393, height: 852)

    func testTheMenuSitsAboveTheMessageWithItsRightEdgeOnTheMessages() {
        let layout = CopyMenuLayout(anchor: rect(150, 400, 227, 60), window: window, label: text("Copy", lineHeight: 20))
        assertFrame(layout.menu, rect(225, 348, 152, 44))
        assertFrame(layout.icon, rect(14, 13.5, 17, 17))
        assertFrame(layout.label, rect(41, 12, 32, 20))
    }

    func testNearTheTopItDropsBelowAndStaysOnScreen() {
        let below = CopyMenuLayout(anchor: rect(16, 40, 80, 30), window: window, label: text("Copy", lineHeight: 20))
        // 8 below, and 12 in from the left.
        assertFrame(below.menu, rect(12, 78, 152, 44))
        let tall = CopyMenuLayout(anchor: rect(16, 40, 361, 900), window: window, label: text("Copy", lineHeight: 20))
        // Never within 12 of the bottom.
        assertFrame(tall.menu, rect(225, 796, 152, 44))
    }
}

final class CliWarningPillLayoutTests: XCTestCase {
    func testThePillIsCentredUnderTheHeader() {
        let layout = CliWarningPillLayout(width: 393, top: 103, label: fixed(115, 15))
        assertFrame(layout.pill, rect(104, 111, 185, 29))
        assertFrame(layout.icon, rect(118, 118.5, 14, 14))
        assertFrame(layout.label, rect(138, 118, 115, 15))
        assertFrame(layout.close, rect(261, 118.5, 14, 14))
    }
}

final class InactiveHintLayoutTests: XCTestCase {
    func testResumeSitsUnderTheNotice() {
        let layout = InactiveHintLayout(
            width: 361, notice: text("This session is inactive.", advance: 7, lineHeight: 18), terminalNotice: nil,
            action: .resume(label: .fixed(width: 111, height: 20))
        )
        assertFrame(layout.notice, rect(8, 12, 345, 18))
        assertFrame(layout.button, rect(8, 40, 345, 44))
        assertFrame(layout.buttonLabel, rect(125, 52, 111, 20))
        XCTAssertNil(layout.command)
        assertSize(layout.size, CGSize(width: 361, height: 94))
    }

    func testTheCommandBlockRunsEdgeToEdgeWithItsCopyGlyph() {
        let layout = InactiveHintLayout(
            width: 361, notice: text("x", lineHeight: 18), terminalNotice: text("y", lineHeight: 18),
            action: .command(block(height: 36))
        )
        assertFrame(layout.terminalNotice, rect(8, 34, 345, 18))
        assertFrame(layout.command, rect(0, 62, 361, 60))
        assertFrame(layout.commandText, rect(16, 74, 305, 36))
        assertFrame(layout.commandIcon, rect(329, 75, 16, 16))
        assertSize(layout.size, CGSize(width: 361, height: 132))

        let short = InactiveHintLayout(width: 361, notice: text("x", lineHeight: 18), terminalNotice: nil, action: .command(block(height: 18)))
        // At least 48 tall.
        assertFrame(short.command, rect(0, 40, 361, 48))
    }
}

final class ChatPlainHeaderLayoutTests: XCTestCase {
    func testTheTitleSitsAtTheStartOfTheRow() {
        let layout = ChatPlainHeaderLayout(
            bar: rect(0, 0, 664, 50), size: CGSize(width: 664, height: 50), maxWidth: 800,
            title: fixed(120, 20), subtitle: fixed(60, 16), changes: CGSize(width: 40, height: 14)
        )
        assertFrame(layout.column, rect(16, 7, 632, 36))
        // The column's children are in the column.
        assertFrame(layout.title, rect(0, 0, 120, 20))
        assertFrame(layout.subtitle, rect(0, 20, 60, 16))
        assertFrame(layout.changes, rect(64, 21, 40, 14))
    }

    func testAWideBarHoldsTheRowToTheHeadersMaxWidth() {
        let layout = ChatPlainHeaderLayout(bar: rect(0, 0, 1000, 50), size: CGSize(width: 1000, height: 50), maxWidth: 800, title: fixed(120, 20), subtitle: nil, changes: nil)
        assertFrame(layout.column, rect(116, 15, 768, 20))
        assertFrame(layout.title, rect(0, 0, 120, 20))
        XCTAssertNil(layout.subtitle)
        XCTAssertNil(layout.changes)
    }

    func testAnInsetTitleViewPlacesTheRowFromTheBarsEdges() {
        // UIKit put the title view 80 into a 1000-wide bar, 840 wide and 3
        // down: the row is where it would be in the bar (116), which is 36
        // into the view, and centred in the view's own height.
        let layout = ChatPlainHeaderLayout(
            bar: rect(-80, -3, 1000, 50), size: CGSize(width: 840, height: 44), maxWidth: 800,
            title: fixed(120, 20), subtitle: nil, changes: nil
        )
        assertFrame(layout.column, rect(36, 12, 768, 20))
        assertFrame(layout.title, rect(0, 0, 120, 20))
    }

    func testARowStartingBeforeTheTitleViewIsClippedAndMeasuredToWhatIsLeft() {
        // The row starts 16 into the bar, which is 104 before the view.
        let layout = ChatPlainHeaderLayout(
            bar: rect(-120, 0, 664, 50), size: CGSize(width: 500, height: 50), maxWidth: 800,
            title: fixed(600, 20), subtitle: fixed(480, 16), changes: CGSize(width: 40, height: 14)
        )
        assertFrame(layout.column, rect(0, 7, 500, 36))
        assertFrame(layout.title, rect(0, 0, 500, 20))
        // 500 less the changes and their gap.
        assertFrame(layout.subtitle, rect(0, 20, 456, 16))
        assertFrame(layout.changes, rect(460, 21, 40, 14))
    }

    func testARowEndingPastTheTitleViewIsClipped() {
        let layout = ChatPlainHeaderLayout(
            bar: rect(0, 0, 664, 50), size: CGSize(width: 400, height: 50), maxWidth: 800,
            title: fixed(600, 20), subtitle: nil, changes: nil
        )
        assertFrame(layout.column, rect(16, 15, 384, 20))
        assertFrame(layout.title, rect(0, 0, 384, 20))
    }

    func testATitleViewOutsideTheRowGetsAnEmptyColumn() {
        // The row ends 16 before the view starts.
        let layout = ChatPlainHeaderLayout(
            bar: rect(-900, 0, 1000, 50), size: CGSize(width: 100, height: 50), maxWidth: 800,
            title: fixed(120, 20), subtitle: nil, changes: nil
        )
        assertFrame(layout.column, rect(0, 15, 0, 20))
        assertFrame(layout.title, rect(0, 0, 0, 20))
    }

    func testWithoutABarTheRowIsTheTitleViews() {
        let size = CGSize(width: 664, height: 44)
        let layout = ChatPlainHeaderLayout(
            bar: CGRect(origin: .zero, size: size), size: size, maxWidth: 800,
            title: fixed(120, 20), subtitle: fixed(60, 16), changes: nil
        )
        assertFrame(layout.column, rect(16, 4, 632, 36))
        assertFrame(layout.subtitle, rect(0, 20, 60, 16))
    }
}

final class WorktreeTabStripLayoutTests: XCTestCase {
    func testTabsSitInACapsuleThatEndsInPlus() {
        let layout = WorktreeTabStripLayout(
            width: 393, maxWidth: .greatestFiniteMagnitude, border: 1, hairline: 0.5,
            tabs: [
                .init(label: text("Main", lineHeight: 18, maxLines: 1), dot: false),
                .init(label: text("Fix strip", lineHeight: 18, maxLines: 1), dot: true),
            ],
            showsAdd: true
        )
        XCTAssertEqual(layout.size, CGSize(width: 393, height: 56))
        assertFrame(layout.pill, rect(16, 10, 361, 40))
        assertFrame(layout.inner, rect(1, 1, 359, 38))
        assertFrame(layout.scroller, rect(0, 0, 318.5, 38))
        assertFrame(layout.divider, rect(318.5, 9, 0.5, 20))
        assertFrame(layout.add, rect(319, 0, 40, 38))
        // 32 tall, 10 in, 2 apart, 4 from the capsule's ends.
        assertFrame(layout.tabs[0].frame, rect(4, 3, 52, 32))
        assertFrame(layout.tabs[0].label, rect(10, 7, 32, 18))
        XCTAssertNil(layout.tabs[0].dot)
        assertFrame(layout.tabs[1].frame, rect(58, 3, 105, 32))
        assertFrame(layout.tabs[1].dot, rect(88, 12.5, 7, 7))
        XCTAssertEqual(layout.contentWidth, 167)
    }

    func testATabGrowsToTwoHundred() {
        let layout = WorktreeTabStripLayout(
            width: 393, maxWidth: .greatestFiniteMagnitude, border: 1, hairline: 0.5,
            tabs: [.init(label: text(String(repeating: "a", count: 30), lineHeight: 18, maxLines: 1), dot: false)],
            showsAdd: false
        )
        assertFrame(layout.tabs[0].frame, rect(4, 3, 200, 32))
        assertFrame(layout.tabs[0].label, rect(10, 7, 180, 18))
        // No `+`: the tabs have the whole capsule.
        assertFrame(layout.scroller, rect(0, 0, 359, 38))
        XCTAssertNil(layout.add)
    }

    func testANameAtALargeTextSizeIsCentredOnATabThatKeepsItsHeight() {
        // 14/18 at the largest accessibility size: the names grow, the
        // strip's heights don't, as RN scales text and nothing else.
        let layout = WorktreeTabStripLayout(
            width: 393, maxWidth: .greatestFiniteMagnitude, border: 1, hairline: 0.5,
            tabs: [
                .init(label: .fixed(width: 150, height: 64.5), dot: false),
                .init(label: .fixed(width: 400, height: 64.5), dot: true),
            ],
            showsAdd: true
        )
        XCTAssertEqual(layout.size, CGSize(width: 393, height: 56))
        assertFrame(layout.pill, rect(16, 10, 361, 40))
        assertFrame(layout.tabs[0].frame, rect(4, 3, 170, 32))
        assertFrame(layout.tabs[0].label, rect(10, -16.25, 150, 64.5))
        // Capped at 200, the dot after what is left of the name.
        assertFrame(layout.tabs[1].frame, rect(176, 3, 200, 32))
        assertFrame(layout.tabs[1].label, rect(10, -16.25, 167, 64.5))
        assertFrame(layout.tabs[1].dot, rect(183, 12.5, 7, 7))
        XCTAssertEqual(layout.contentWidth, 380)
    }

    func testTheCapsuleKeepsToTheHeadersWidth() {
        let layout = WorktreeTabStripLayout(width: 1000, maxWidth: 800, border: 0.5, hairline: 0.5, tabs: [], showsAdd: true)
        assertFrame(layout.pill, rect(116, 10, 768, 40))
        assertFrame(layout.inner, rect(0.5, 0.5, 767, 39))
    }

    func testOnlyATabOutOfViewIsScrolledTo() {
        typealias L = WorktreeTabStripLayout
        XCTAssertNil(L.revealOffset(tab: rect(100, 3, 80, 32), offset: 0, viewport: 300, contentWidth: 600))
        // The smallest scroll that shows it, 8 to spare.
        XCTAssertEqual(L.revealOffset(tab: rect(300, 3, 100, 32), offset: 0, viewport: 300, contentWidth: 600), 108)
        XCTAssertEqual(L.revealOffset(tab: rect(10, 3, 100, 32), offset: 50, viewport: 300, contentWidth: 600), 2)
        // Never past the content's end.
        XCTAssertEqual(L.revealOffset(tab: rect(480, 3, 100, 32), offset: 0, viewport: 300, contentWidth: 584), 284)
    }
}
