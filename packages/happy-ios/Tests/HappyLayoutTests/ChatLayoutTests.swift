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

    func testAMissingAnchorRowKeepsTheOffsetAndNothingOverscrolls() {
        let anchor = ChatScrollAnchor(kind: .row(id: "gone", distance: 0))
        XCTAssertEqual(anchor.visibleMinY(in: layout, ids: ids, current: 450, maxVisibleMinY: 300), 300)
        let deep = ChatScrollAnchor(kind: .row(id: "r9", distance: -50))
        XCTAssertEqual(deep.visibleMinY(in: layout, ids: ids, current: 0, maxVisibleMinY: 600), 600)
    }
}

final class MarkdownLayoutTests: XCTestCase {
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

    func testShortCodeKeepsTheBlockFullWidth() {
        let layout = MarkdownLayout(width: 300, blocks: [.code(language: nil, code: CGSize(width: 50, height: 20))])
        guard case .code(let code) = layout.blocks[0] else { return XCTFail() }
        assertFrame(code.frame, rect(0, 8, 300, 52))
        XCTAssertNil(code.language)
        assertSize(code.contentSize, CGSize(width: 300, height: 52))
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

    func testAClippedBox() {
        let layout = ChatStackLayout(width: 300, items: [
            .init(block(height: 200), padding: LayoutInsets(top: 12, left: 12, bottom: 12, right: 12), maxHeight: 115),
        ])
        assertFrame(layout.boxes[0], rect(0, 0, 300, 115))
        assertFrame(layout.contents[0], rect(12, 12, 276, 91))
    }

    func testADiffBlock() {
        let layout = ToolDiffLayout(width: 300, lineCount: 3, lineWidth: 500)
        assertFrame(layout.gutter, rect(0, 0, 20, 62))
        assertFrame(layout.scroll, rect(20, 0, 280, 62))
        assertSize(layout.contentSize, CGSize(width: 516, height: 62))
        assertFrame(layout.lines[1], rect(0, 22, 516, 18))
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
    }
}

final class ChatScreenLayoutTests: XCTestCase {
    private func screen(keyboardTop: CGFloat?) -> ChatScreenLayout {
        ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: keyboardTop, accessories: [block(height: 60)], composerHeight: 70))
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

    func testTheScrollButtonSitsAboveTheComposerCard() {
        let layout = ChatScreenLayout(.init(size: phone, safeArea: phoneUnderBar, keyboardTop: nil, composerHeight: 70, composerCardOffset: 20))
        assertFrame(layout.dock, rect(0, 748, 393, 70))
        assertFrame(layout.scrollButton, rect(180.5, 720, 32, 32))
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

final class ComposerPlaceholderLayoutTests: XCTestCase {
    func testOneLine() {
        let layout = ComposerPlaceholderLayout(width: 393, textHeight: 20, lineHeight: 20)
        assertFrame(layout.card, rect(8, 4, 377, 44))
        assertFrame(layout.text, rect(22, 16, 319, 20))
        assertFrame(layout.sendButton, rect(347, 10, 32, 32))
        XCTAssertEqual(layout.size.height, 56)
        XCTAssertFalse(layout.textScrolls)
        XCTAssertEqual(ComposerPlaceholderLayout.textWidth(for: 393), 319)
    }

    func testGrowsToFiveLinesThenScrolls() {
        let layout = ComposerPlaceholderLayout(width: 393, textHeight: 140, lineHeight: 20)
        assertFrame(layout.card, rect(8, 4, 377, 116))
        assertFrame(layout.text, rect(22, 12, 319, 100))
        assertFrame(layout.sendButton, rect(347, 82, 32, 32))
        XCTAssertEqual(layout.size.height, 128)
        XCTAssertTrue(layout.textScrolls)
    }
}
