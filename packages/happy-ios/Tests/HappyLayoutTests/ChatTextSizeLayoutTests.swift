import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The chat's rows at the person's text size, as React Native lays them
/// out: every row's text and its line grow by one multiplier, uncapped;
/// the icons, paddings, minimum heights and fixed lines (the status line,
/// OlderEnd's slot) do not, and taller text grows a row past its minimum.
/// Text here is the stand-in `text(_:advance:lineHeight:)`, its line the
/// style's scaled line up to a 3x screen's next pixel, as `ChatTextLayout`
/// ceils it (`PixelGrid.ceil`).
final class ChatTextSizeLayoutTests: XCTestCase {
    private let scales: [TextScale] = [
        TextScale(.extraSmall), .standard, TextScale(.extraExtraExtraLarge),
        TextScale(.accessibilityMedium), TextScale(.accessibilityExtraExtraExtraLarge),
    ]
    private let largest = TextScale(.accessibilityExtraExtraExtraLarge)

    /// Up to a 3x screen's next pixel.
    private func pixels(_ value: CGFloat) -> CGFloat {
        PixelGrid.ceil(value, scale: 3)
    }

    /// One line of `style` at `scale`, as the rows measure it.
    private func line(_ style: ChatTextStyle, _ scale: TextScale) -> CGFloat {
        pixels(style.scaled(scale).lineHeight ?? 0)
    }

    /// `string` in `style` at `scale`: 8 a character at the designed size.
    private func words(_ string: String, _ style: ChatTextStyle, _ scale: TextScale, maxLines: Int = 0) -> Measurable {
        text(string, advance: 8 * scale.multiplier, lineHeight: line(style, scale), maxLines: maxLines)
    }

    /// A text box ends on the screen's next pixel, as RN's does, not the
    /// next point; float noise over a pixel stays on it.
    func testATextBoxRoundsUpToTheScreensPixels() {
        XCTAssertEqual(PixelGrid.ceil(89.275, scale: 3), 268.0 / 3)
        XCTAssertEqual(PixelGrid.ceil(89.275, scale: 2), 89.5)
        XCTAssertEqual(PixelGrid.ceil(89.275, scale: 0), 90)
        XCTAssertEqual(PixelGrid.ceil(236.0 / 3, scale: 3), 236.0 / 3)
        XCTAssertEqual(PixelGrid.ceil(236.0 / 3 + 1e-9, scale: 3), 236.0 / 3)
        XCTAssertEqual(PixelGrid.ceil(20, scale: 3), 20)
        XCTAssertEqual(PixelGrid.ceil(0, scale: 3), 0)
        // A 22 line at AX-XXXL, 78.56, is 236 pixels where whole points
        // would be 79.
        XCTAssertEqual(PixelGrid.ceil(22 * largest.multiplier, scale: 3), 236.0 / 3)
    }

    func testEveryRowStyleScalesByOneFactorUncapped() {
        let styles: [ChatTextStyle] = [
            ChatTextStyles.markdownText, ChatTextStyles.markdownCode, ChatTextStyles.codeBlock, ChatTextStyles.codeLanguage,
            ChatTextStyles.tableHeader, ChatTextStyles.tableCell, ChatTextStyles.option, ChatTextStyles.imageCaption,
            ChatTextStyles.userAuthor, ChatTextStyles.pendingStatus, ChatTextStyles.agentEvent, ChatTextStyles.goalSent,
            ChatTextStyles.commandChip, ChatTextStyles.unsupported, ChatTextStyles.toolName, ChatTextStyles.toolStatus,
            ChatTextStyles.toolDescription, ChatTextStyles.toolElapsed, ChatTextStyles.compactActivity, ChatTextStyles.todo,
            ChatTextStyles.taskItem, ChatTextStyles.taskMore, ChatTextStyles.toolSectionTitle, ChatTextStyles.toolError,
            ChatTextStyles.codeView, ChatTextStyles.terminal, ChatTextStyles.terminalPrompt, ChatTextStyles.terminalCommand,
            ChatTextStyles.toolOperation, ChatTextStyles.toolOperationCommand, ChatTextStyles.executeCwd,
            ChatTextStyles.executeDescription, ChatTextStyles.attachmentName, ChatTextStyles.permissionButton,
            ChatTextStyles.permissionButtonSettled, ChatTextStyles.workGroup, ChatTextStyles.chatFooterWarning,
            ChatTextStyles.emptyHost, ChatTextStyles.emptyPath, ChatTextStyles.emptyTitle, ChatTextStyles.emptyCreated,
            ChatTextStyles.patchMovePath, ChatTextStyles.pendingQueued, ChatTextStyles.inlineQuestionHeader,
            ChatTextStyles.inlineQuestionText, ChatTextStyles.inlineOptionLabel, ChatTextStyles.inlineOptionDescription,
            ChatTextStyles.inlineSubmit, ChatTextStyles.inlineSubmittedHeader, ChatTextStyles.inlineSubmittedValue,
            ChatTextStyles.fullSectionTitle, ChatTextStyles.fullDescription, ChatTextStyles.fullError,
            ChatTextStyles.fullEmptyTitle, ChatTextStyles.fullEmptySubtitle, ChatTextStyles.multiEditNumber,
            ChatTextStyles.multiEditBadge, ChatTextStyles.terminalEmptyOutput, ChatTextStyles.detailMessage,
        ] + (1...6).map(ChatTextStyles.markdownHeader)
        for style in styles {
            // happy-app caps no text in the chat (only onboarding's titles).
            XCTAssertNil(style.maxScale)
            XCTAssertEqual(style.scaled(.standard), style)
            for scale in scales {
                let scaled = style.scaled(scale)
                XCTAssertEqual(scaled.size, style.size * scale.multiplier, accuracy: 0.0001)
                XCTAssertEqual(scaled.lineHeight ?? -1, style.lineHeight.map { $0 * scale.multiplier } ?? -1, accuracy: 0.0001)
                XCTAssertEqual(scaled.letterSpacing, style.letterSpacing)
                XCTAssertEqual(scaled.face, style.face)
            }
        }
    }

    func testAUserBubbleGrowsWithItsTextAndTheStatusLineKeeps14() {
        typealias M = UserMessageLayout.Metrics
        for scale in scales {
            let paragraph = line(ChatTextStyles.markdownText, scale)
            let layout = UserMessageLayout(.init(width: 393, content: .text([.text(words("Hello", ChatTextStyles.markdownText, scale))])))
            let bubble = try! XCTUnwrap(layout.bubble)
            let width = 5 * 8 * scale.multiplier + 2 * M.bubblePaddingH
            // The paragraph's 8 and 10, the bubble's 4 and 4: fixed.
            assertFrame(bubble, rect(393 - 16 - width, 6, width, 8 + paragraph + 10 + 8))
            assertFrame(layout.status, rect(16, bubble.maxY + 4 + 2, 361, 14))
            XCTAssertEqual(layout.size.height, 6 + bubble.height + 4 + 2 + 14 + 4, accuracy: 0.001)
        }
        // At the largest size the 25 line is 89.275, measured 268 pixels.
        let largest = UserMessageLayout(.init(width: 393, content: .text([.text(words("Hello", ChatTextStyles.markdownText, largest))])))
        assertFrame(largest.bubble, rect(210.16, 6, 166.84, 346.0 / 3))
        assertFrame(largest.status, rect(16, 382.0 / 3, 361, 14))
        XCTAssertEqual(largest.size.height, 436.0 / 3, accuracy: 0.001)
    }

    func testAGoalKeepsItsGlyphAndCentresItOnTheGrownLabel() {
        let scale = largest
        let sent = text("Sent as goal", advance: 7 * scale.multiplier, lineHeight: 60)
        let layout = UserMessageLayout(.init(width: 393, content: .goal([.text(words("Ship it", ChatTextStyles.markdownText, scale))], sentLabel: sent)))
        let icon = try! XCTUnwrap(layout.goalIcon)
        let label = try! XCTUnwrap(layout.goalLabel)
        XCTAssertEqual(icon.size, CGSize(width: 16, height: 16))
        XCTAssertEqual(label.height, 60)
        XCTAssertEqual(icon.midY, label.midY, accuracy: 0.001)
        XCTAssertEqual(label.minX - icon.maxX, 8)
    }

    func testAWorkHeaderGrowsPastItsMinimumWithItsChevronKept() {
        typealias M = WorkGroupHeaderLayout.Metrics
        for scale in scales {
            let label = line(ChatTextStyles.workGroup, scale)
            let layout = WorkGroupHeaderLayout(width: 393, label: words("Worked 2m3s", ChatTextStyles.workGroup, scale, maxLines: 1))
            let height = max(28, label + 8)
            assertFrame(layout.header, rect(16, 8, 361, height))
            XCTAssertEqual(layout.label.height, label)
            XCTAssertEqual(layout.label.midY, layout.header.midY, accuracy: 0.001)
            XCTAssertEqual(layout.chevron.size, CGSize(width: M.chevronSize, height: M.chevronSize))
            XCTAssertEqual(layout.chevron.midY, layout.header.midY, accuracy: 0.001)
            XCTAssertEqual(layout.size.height, height + 16, accuracy: 0.001)
        }
        // Designed: the 28 minimum holds a 20 line; at XXXL 27.06 is 82
        // pixels, and 35⅓.
        XCTAssertEqual(WorkGroupHeaderLayout(width: 393, label: words("Hide", ChatTextStyles.workGroup, .standard)).size.height, 44)
        XCTAssertEqual(WorkGroupHeaderLayout(width: 393, label: words("Hide", ChatTextStyles.workGroup, TextScale(.extraExtraExtraLarge))).size.height, 154.0 / 3, accuracy: 0.001)
    }

    func testAToolCardsHeaderGrowsWithItsTitleAndKeepsItsGlyphs() {
        typealias M = ToolCardLayout.Metrics
        for scale in scales {
            // toolName and toolDescription have no line height of their
            // own: their font's line, here 1.2 em up to the pixel.
            let titleLine = pixels(14 * 1.2 * scale.multiplier)
            let descriptionLine = pixels(13 * 1.2 * scale.multiplier)
            let elapsed = CGSize(width: pixels(6 * 7.8 * scale.multiplier), height: pixels(13 * 1.2 * scale.multiplier))
            let layout = ToolCardLayout(.init(
                width: 393,
                header: .init(
                    title: text("Terminal", advance: 8 * scale.multiplier, lineHeight: titleLine, maxLines: 1),
                    description: text("ls -la", advance: 7 * scale.multiplier, lineHeight: descriptionLine, maxLines: 1),
                    elapsed: .fixed(elapsed), statusIcon: CGSize(width: 20, height: 20)
                ),
                body: nil, footer: nil
            ))
            let column = titleLine + 2 + descriptionLine
            let content = max(24, column, elapsed.height, 20)
            let header = try! XCTUnwrap(layout.header)
            XCTAssertEqual(header.height, content + 24, accuracy: 0.001)
            let icon = try! XCTUnwrap(layout.icon)
            XCTAssertEqual(icon.size, CGSize(width: 24, height: 24))
            XCTAssertEqual(icon.midY, header.midY, accuracy: 0.001)
            let status = try! XCTUnwrap(layout.statusIcon)
            XCTAssertEqual(status.size, CGSize(width: 20, height: 20))
            assertFrame(status, rect(377 - 12 - 20, 12 + (content - 20) / 2, 20, 20))
            // The timer's room is "000.0s" at the size, so the title gives it up.
            let timer = try! XCTUnwrap(layout.elapsed)
            XCTAssertEqual(timer.size, elapsed)
            XCTAssertEqual(timer.maxX, status.minX - M.gap, accuracy: 0.001)
            let title = try! XCTUnwrap(layout.title)
            XCTAssertEqual(title.minX, 12 + 24 + 8)
            XCTAssertEqual(title.maxX, timer.minX - M.elapsedMarginLeft - M.gap, accuracy: 0.001)
            XCTAssertEqual(layout.size.height, content + 24 + 16, accuracy: 0.001)
        }
    }

    func testACompactRowGrowsPastItsMinimum() {
        for scale in scales {
            let label = line(ChatTextStyles.compactActivity, scale)
            let layout = CompactToolRowLayout(
                width: 393, label: words("Ran ls", ChatTextStyles.compactActivity, scale, maxLines: 1), elapsed: nil,
                statusIcon: CGSize(width: 20, height: 20), footer: nil
            )
            let height = max(28, max(20, label) + 6)
            assertFrame(layout.header, rect(8, 2, 377, height))
            XCTAssertEqual(layout.icon.size, CGSize(width: 20, height: 20))
            XCTAssertEqual(layout.icon.midY, layout.header.midY, accuracy: 0.001)
            XCTAssertEqual(layout.label.height, label)
            XCTAssertEqual(layout.size.height, height + 4, accuracy: 0.001)
        }
        // 20 at the designed size sits in the 28; 71.43 at the largest,
        // 215 pixels.
        XCTAssertEqual(
            CompactToolRowLayout(width: 393, label: words("Ran", ChatTextStyles.compactActivity, largest), elapsed: nil, statusIcon: nil, footer: nil).header.height,
            233.0 / 3, accuracy: 0.001
        )
    }

    func testPermissionButtonsGrowPast34WithTheirLabels() {
        typealias M = PermissionFooterLayout.Metrics
        for scale in scales {
            let label = line(ChatTextStyles.permissionButton, scale)
            let labels = ["Yes", "Yes, allow all edits during this session", "No, and provide feedback"].map {
                words($0, ChatTextStyles.permissionButton, scale, maxLines: 2)
            }
            let layout = PermissionFooterLayout(width: 377, labels: labels)
            for (index, button) in layout.buttons.enumerated() {
                let text = layout.labels[index]
                XCTAssertEqual(button.height, max(34, text.height + 16), accuracy: 0.001)
                XCTAssertEqual(text.midY, button.midY, accuracy: 0.001)
                XCTAssertEqual(button.width, 377 - 12)
            }
            XCTAssertEqual(layout.labels[0].height, label)
            XCTAssertEqual(layout.buttons[1].minY - layout.buttons[0].maxY, M.gap)
        }
        // The long label wraps to its two lines at the largest size: 2 ×
        // 64.28, each 193 pixels.
        let large = PermissionFooterLayout(width: 377, labels: [words("Yes, allow all edits during this session", ChatTextStyles.permissionButton, largest, maxLines: 2)])
        XCTAssertEqual(large.buttons[0].height, 2 * 193.0 / 3 + 16, accuracy: 0.001)
    }

    func testTheFootersWarningGrowsAroundItsFixedGlyph() {
        for scale in scales {
            let warningLine = pixels(12 * 1.3 * scale.multiplier)
            let layout = ChatFooterLayout(width: 393, warning: text("Permissions shown in terminal only.", advance: 6 * scale.multiplier, lineHeight: warningLine))
            let box = try! XCTUnwrap(layout.warning)
            let icon = try! XCTUnwrap(layout.icon)
            let label = try! XCTUnwrap(layout.label)
            XCTAssertEqual(icon.size, CGSize(width: 16, height: 16))
            XCTAssertEqual(box.minY, 8)
            XCTAssertEqual(box.height, max(16, label.height) + 8, accuracy: 0.001)
            XCTAssertEqual(label.minX - icon.maxX, 6)
            XCTAssertEqual(layout.size.height, box.maxY + 2, accuracy: 0.001)
            XCTAssertLessThanOrEqual(box.width, 393 - 64)
        }
    }

    func testOlderEndsSlotStays32AndItsButtonSpillsCentred() {
        for scale in scales {
            // RoundButton small: its label's line and 17 and 8 around it.
            let button = CGSize(width: 361, height: pixels(16 * 1.3 * scale.multiplier) + 25)
            let layout = ChatOlderEndLayout(width: 393, control: button)
            XCTAssertEqual(layout.size, CGSize(width: 393, height: 32))
            XCTAssertEqual(layout.control.midY, 16, accuracy: 0.001)
            XCTAssertEqual(layout.control.height, button.height)
        }
        XCTAssertEqual(ChatListLayout(width: 393, heights: [10], newerEndHeight: 6, olderEndHeight: ChatOlderEndLayout.height).olderEndFrame.height, 32)
    }

    func testAnEventLineGrowsAndKeepsItsMargins() {
        for scale in scales {
            let eventLine = pixels(14 * 1.2 * scale.multiplier)
            let layout = ChatEventLayout(width: 393, label: text("Switched to plan mode", advance: 7 * scale.multiplier, lineHeight: eventLine))
            XCTAssertEqual(layout.label.minY, 8)
            XCTAssertEqual(layout.size.height, layout.label.height + 16, accuracy: 0.001)
            XCTAssertLessThanOrEqual(layout.label.width, 393 - 16)
        }
    }

    func testMarkdownTextGrowsAndItsBlocksKeepTheirMargins() {
        typealias M = MarkdownLayout.Metrics
        for scale in scales {
            let paragraph = line(ChatTextStyles.markdownText, scale)
            let code = CGSize(width: 30 * 8.4 * scale.multiplier, height: 3 * line(ChatTextStyles.codeBlock, scale))
            let language = words("swift", ChatTextStyles.codeLanguage, scale, maxLines: 1)
            let layout = MarkdownLayout(width: 361, blocks: [
                .text(words("A paragraph", ChatTextStyles.markdownText, scale)),
                .code(language: language, code: code),
            ])
            guard case .text(let text) = layout.blocks[0], case .code(let placed) = layout.blocks[1] else { return XCTFail("blocks") }
            assertFrame(text, rect(0, M.textMarginTop, 361, paragraph))
            // The code's 16 padding and the block's 8 margins keep their size.
            XCTAssertEqual(placed.frame.minY, text.maxY + M.textMarginBottom + M.blockMargin, accuracy: 0.001)
            XCTAssertEqual(placed.text.size, code)
            XCTAssertEqual(placed.text.minX, M.codePadding)
            XCTAssertEqual(layout.size.height, placed.frame.maxY + M.blockMargin, accuracy: 0.001)
        }
    }

    func testATablesColumnsAreRNsFixedEstimateAtEverySize() {
        // MarkdownView's 8.5 a character, plus padding, 80 to 360: React
        // Native's own numbers, not measured text, so they stay.
        let widths = MarkdownLayout.columnWidths(lengths: [[6, 30], [3, 12]])
        XCTAssertEqual(widths, [80, 279])
        for scale in scales {
            let rows = [["Header", "A much longer header than that"], ["abc", "def ghi jkl"]].enumerated().map { index, row in
                row.map { words($0, index == 0 ? ChatTextStyles.tableHeader : ChatTextStyles.tableCell, scale) }
            }
            let layout = MarkdownLayout(width: 361, blocks: [.table(.init(columnWidths: widths, rows: rows))])
            guard case .table(let table) = layout.blocks[0] else { return XCTFail("table") }
            // The cells keep their width; their text wraps in it, and the
            // rows grow with its lines.
            assertFrame(table.cells[0][0], rect(12, 8, 80 - 24 - 1, table.cells[0][0].height))
            XCTAssertEqual(table.contentSize.width, 359)
            let header = line(ChatTextStyles.tableHeader, scale)
            XCTAssertEqual(table.cells[0][1].height.truncatingRemainder(dividingBy: header), 0, accuracy: 0.001)
            XCTAssertEqual(table.rows[0].height, max(table.cells[0][0].height, table.cells[0][1].height) + 16 + 1, accuracy: 0.001)
        }
    }

    /// A new size re-heights every row; the reader's row stays where it is
    /// on screen, as for a new width (`ChatListView.apply`).
    func testANewSizeKeepsTheReadersRow() {
        let ids = (0..<10).map { "r\($0)" }
        let designed = ChatListLayout(width: 393, heights: Array(repeating: 63, count: 10), newerEndHeight: 6, olderEndHeight: 32)
        let anchor = ChatScrollAnchor.capture(layout: designed, ids: ids, visibleMinY: 300)
        guard case .row(let id, _) = anchor.kind else { return XCTFail("a reader in history keeps a row") }
        let grown = ChatListLayout(width: 393, heights: Array(repeating: 146, count: 10), newerEndHeight: 6, olderEndHeight: 32)
        let target = anchor.visibleMinY(in: grown, ids: ids, current: 300, maxVisibleMinY: grown.contentHeight)
        let index = try! XCTUnwrap(ids.firstIndex(of: id))
        XCTAssertEqual(designed.frame(ofRow: index).minY - 300, grown.frame(ofRow: index).minY - target, accuracy: 0.001)
        XCTAssertEqual(target - 300, CGFloat(index) * (146 - 63), accuracy: 0.001)
    }

    /// The message screen keeps the piece of text at the top of the screen
    /// there, as far down it, when a new size moves every piece; the gaps
    /// between pieces are padding and keep their size.
    func testTheMessageScreenKeepsItsReadingPlace() throws {
        func pieces(_ scale: TextScale) -> [CGRect] {
            let line = pixels(24 * scale.multiplier)
            var y: CGFloat = 16
            return (0..<4).map { _ in
                defer { y += 10 * line + 12 }
                return CGRect(x: 16, y: y, width: 361, height: 10 * line)
            }
        }
        let designed = pieces(.standard)
        // A third of the way down the second piece.
        let place = try XCTUnwrap(MessageDetailReadingPlace(top: designed[1].minY + 80, pieces: designed))
        XCTAssertEqual(place, MessageDetailReadingPlace(piece: 1, fraction: 1.0 / 3, above: 0))
        for scale in scales {
            let moved = pieces(scale)
            let top = try XCTUnwrap(place.top(in: moved))
            XCTAssertEqual(top, moved[1].minY + moved[1].height / 3, accuracy: 0.001)
        }
        // In the gap above a piece: the gap keeps its points.
        let gap = try XCTUnwrap(MessageDetailReadingPlace(top: designed[2].minY - 5, pieces: designed))
        XCTAssertEqual(gap, MessageDetailReadingPlace(piece: 2, fraction: 0, above: 5))
        XCTAssertEqual(gap.top(in: pieces(largest)), pieces(largest)[2].minY - 5)
        // The start stays the start, and past the last piece is nowhere.
        XCTAssertNil(MessageDetailReadingPlace(top: 0, pieces: designed))
        XCTAssertNil(MessageDetailReadingPlace(top: 10_000, pieces: designed))
        XCTAssertNil(MessageDetailReadingPlace(piece: 9, fraction: 0, above: 0).top(in: designed))
    }
}
