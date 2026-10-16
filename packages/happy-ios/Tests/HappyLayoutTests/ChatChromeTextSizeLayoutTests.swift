import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The chat's header, the CLI warning and the bars over the composer at the
/// person's text size, as React Native lays them out: their text grows by
/// one multiplier, uncapped; the glyphs, paddings, the capsule's 44, the
/// goal's 30 pt buttons, Resume's 44 and the commands' 48 minimum do not.
/// Text here is the stand-in `text(_:advance:lineHeight:)`, 8 a character
/// at the designed size, its line the style's scaled line (a style with no
/// line of its own takes 1.2 its size) up to a 3x screen's next pixel.
final class ChatChromeTextSizeLayoutTests: XCTestCase {
    private let scales: [TextScale] = [
        TextScale(.extraSmall), .standard, TextScale(.extraExtraExtraLarge),
        TextScale(.accessibilityMedium), TextScale(.accessibilityExtraExtraExtraLarge),
    ]
    private let largest = TextScale(.accessibilityExtraExtraExtraLarge)

    private func pixels(_ value: CGFloat) -> CGFloat {
        PixelGrid.ceil(value, scale: 3)
    }

    /// One line of `style` at `scale`.
    private func line(_ style: ChatTextStyle, _ scale: TextScale) -> CGFloat {
        let scaled = style.scaled(scale)
        return pixels(scaled.lineHeight ?? scaled.size * 1.2)
    }

    private func words(_ string: String, _ style: ChatTextStyle, _ scale: TextScale, maxLines: Int = 0) -> Measurable {
        text(string, advance: 8 * scale.multiplier, lineHeight: line(style, scale), maxLines: maxLines)
    }

    // MARK: ChatHeaderView

    /// The line changes as the header measures them: "+12 -3" at 13/18.
    private func changes(_ scale: TextScale) -> CGSize {
        CGSize(width: 40 * scale.multiplier, height: pixels(18 * scale.multiplier))
    }

    /// `mobileTitlePill` is MOBILE_GLASS_CONTROL_SIZE at every size: the
    /// title and its row grow and stay centred on the capsule's middle,
    /// running past its top and bottom once taller than 44, where the
    /// glass's `overflow: 'hidden'` cuts them.
    func testTheCapsuleStays44AndCentresItsGrowingText() throws {
        for scale in scales {
            let size = changes(scale)
            let layout = ChatHeaderTitleLayout(
                maxWidth: 245,
                title: words("Fix the login", ChatTextStyles.headerTitle, scale, maxLines: 1),
                subtitle: words("main", ChatTextStyles.headerSubtitle, scale, maxLines: 1),
                changes: size
            )
            let subtitle = try XCTUnwrap(layout.subtitle)
            let counts = try XCTUnwrap(layout.changes)
            XCTAssertEqual(layout.size.height, 44)
            XCTAssertLessThanOrEqual(layout.size.width, 245)
            XCTAssertEqual(layout.title.height, line(ChatTextStyles.headerTitle, scale), accuracy: 0.001)
            XCTAssertEqual(subtitle.height, line(ChatTextStyles.headerSubtitle, scale), accuracy: 0.001)
            // The counts never shrink; the branch gives way to them.
            assertSize(counts.size, size)
            XCTAssertEqual(counts.minX - subtitle.maxX, 4, accuracy: 0.001)
            XCTAssertLessThanOrEqual(counts.maxX, layout.size.width - 14 + 0.001)
            let bottom = layout.title.maxY + max(subtitle.height, counts.height)
            XCTAssertEqual((layout.title.minY + bottom) / 2, 22, accuracy: 0.001)
            XCTAssertEqual(layout.title.midX, layout.size.width / 2, accuracy: 0.001)
        }
        // At AX-XXXL the title's 20 is 71.42, up to 215 pixels; under it the
        // counts' 64.28, up to 193: 136 in all, so 46 spill out above and
        // below.
        let layout = ChatHeaderTitleLayout(
            maxWidth: 245,
            title: words("Fix the login", ChatTextStyles.headerTitle, largest, maxLines: 1),
            subtitle: words("main", ChatTextStyles.headerSubtitle, largest, maxLines: 1),
            changes: changes(largest)
        )
        assertSize(layout.size, CGSize(width: 245, height: 44))
        assertFrame(layout.title, rect(14, -46, 217, 215.0 / 3))
        assertFrame(layout.changes, rect(14 + 217 - 40 * largest.multiplier, -46 + 215.0 / 3, 40 * largest.multiplier, 193.0 / 3))
        XCTAssertEqual(layout.subtitle?.width ?? 0, 217 - 4 - 40 * largest.multiplier, accuracy: 0.001)
        XCTAssertEqual(layout.subtitle?.height ?? 0, 50, accuracy: 0.001)
    }

    /// The plain header (a tablet) measures its text to the row the bar
    /// gives it, at every size; the column grows and stays centred top to
    /// bottom in the title view, spilling past it as RN's unclipped header
    /// content does.
    func testThePlainHeadersColumnGrowsInTheSameRow() {
        let bar = rect(-100, 0, 1000, 50)
        let size = CGSize(width: 800, height: 50)
        XCTAssertEqual(ChatPlainHeaderLayout.textWidth(bar: bar, size: size, maxWidth: 800), 768)
        XCTAssertEqual(ChatPlainHeaderLayout.subtitleWidth(textWidth: 768, changes: CGSize(width: 40, height: 18)), 724)
        XCTAssertEqual(ChatPlainHeaderLayout.subtitleWidth(textWidth: 768, changes: nil), 768)
        XCTAssertEqual(ChatPlainHeaderLayout.subtitleWidth(textWidth: 20, changes: CGSize(width: 40, height: 18)), 0)
        for scale in scales {
            let title = line(ChatTextStyles.headerTitle, scale)
            let subtitle = line(ChatTextStyles.headerPlainSubtitle, scale)
            let counts = changes(scale)
            let layout = ChatPlainHeaderLayout(
                bar: bar, size: size, maxWidth: 800,
                title: words("Fix the login", ChatTextStyles.headerTitle, scale, maxLines: 1),
                subtitle: words("main", ChatTextStyles.headerPlainSubtitle, scale, maxLines: 1),
                changes: counts
            )
            let height = title + max(subtitle, counts.height)
            assertFrame(layout.column, rect(16, (50 - height) / 2, 768, height))
            assertFrame(layout.title, rect(0, 0, 13 * 8 * scale.multiplier, title))
            assertFrame(layout.changes, rect(4 * 8 * scale.multiplier + 4, title + (max(subtitle, counts.height) - counts.height) / 2, counts.width, counts.height))
        }
    }

    // MARK: The CLI warning

    /// The pill grows with its label, 7 above and below it; its glyphs
    /// keep their 14 and sit on the label's middle.
    func testTheCliWarningGrowsWithItsLabelAndKeepsItsGlyphs() {
        let designed = CliWarningPillLayout(width: 393, top: 103, label: words("CLI Update Required", ChatTextStyles.cliWarning, .standard, maxLines: 1))
        // 12 × 1.2 is 14.4, up to 44 pixels.
        assertFrame(designed.pill, rect(85.5, 111, 222, 44.0 / 3 + 14))
        assertFrame(designed.label, rect(119.5, 118, 152, 44.0 / 3))
        for scale in scales {
            let label = line(ChatTextStyles.cliWarning, scale)
            let layout = CliWarningPillLayout(width: 393, top: 103, label: words("CLI Update Required", ChatTextStyles.cliWarning, scale, maxLines: 1))
            XCTAssertEqual(layout.pill.minY, 111)
            XCTAssertEqual(layout.pill.height, max(14, label) + 14, accuracy: 0.001)
            XCTAssertEqual(layout.label.height, label, accuracy: 0.001)
            XCTAssertLessThanOrEqual(layout.pill.width, 393)
            XCTAssertEqual(layout.pill.midX, 393 / 2, accuracy: 0.001)
            for glyph in [layout.icon, layout.close] {
                assertSize(glyph.size, CGSize(width: 14, height: 14))
                XCTAssertEqual(glyph.midY, layout.label.midY, accuracy: 0.001)
            }
        }
        // At AX-XXXL the label is cut at what the screen leaves it.
        let largestPill = CliWarningPillLayout(width: 393, top: 103, label: words("CLI Update Required", ChatTextStyles.cliWarning, largest, maxLines: 1))
        assertFrame(largestPill.pill, rect(0, 111, 393, line(ChatTextStyles.cliWarning, largest) + 14))
        XCTAssertEqual(largestPill.label.width, 393 - 70, accuracy: 0.001)
    }

    // MARK: The bars over the composer

    /// AgentQuestionBanner: the card grows around its title and two lines
    /// of subtitle, 10 above and below; the glyph keeps its 20 and the
    /// chevron its 18, both on the card's middle.
    func testTheQuestionBannerGrowsAroundItsGlyphs() {
        for scale in scales {
            let title = line(ChatTextStyles.bannerTitle, scale)
            let subtitle = line(ChatTextStyles.bannerSubtitle, scale)
            let layout = QuestionBannerLayout(
                width: 377,
                title: words("Pick one", ChatTextStyles.bannerTitle, scale, maxLines: 1),
                subtitle: words("Which database should the agent use?", ChatTextStyles.bannerSubtitle, scale, maxLines: 2),
                trailing: fixed(18, 18)
            )
            XCTAssertEqual(layout.title.height, title, accuracy: 0.001)
            let subtitleLines = layout.subtitle.height / subtitle
            XCTAssertTrue(subtitleLines.rounded() == subtitleLines && (1...2).contains(subtitleLines), "\(subtitleLines) lines")
            let content = max(20, title + layout.subtitle.height)
            XCTAssertEqual(layout.card.height, content + 22, accuracy: 0.001)
            XCTAssertEqual(layout.size.height, layout.card.height + 8, accuracy: 0.001)
            assertSize(layout.icon.size, CGSize(width: 20, height: 20))
            assertSize(layout.trailing.size, CGSize(width: 18, height: 18))
            XCTAssertEqual(layout.icon.midY, layout.card.midY, accuracy: 0.001)
            XCTAssertEqual(layout.trailing.midY, layout.card.midY, accuracy: 0.001)
            XCTAssertEqual(layout.title.minX, 59)
        }
        // A request it can't answer: Dismiss grows with the rest, and the
        // text gives way to it.
        let dismiss = words("Dismiss", ChatTextStyles.bannerDismiss, largest, maxLines: 1)
        let layout = QuestionBannerLayout(
            width: 377, title: words("Unknown", ChatTextStyles.bannerTitle, largest, maxLines: 1),
            subtitle: words("Not supported", ChatTextStyles.bannerSubtitle, largest, maxLines: 2), trailing: dismiss
        )
        XCTAssertEqual(layout.trailing.width, 7 * 8 * largest.multiplier, accuracy: 0.001)
        XCTAssertEqual(layout.trailing.maxX, 365 - 13, accuracy: 0.001)
        XCTAssertEqual(layout.title.maxX, layout.trailing.minX - 10, accuracy: 0.001)
    }

    /// AgentGoalBar: "Current goal" over the goal, each one line, grow;
    /// the 18 glyph and the 30 pt buttons don't, and stay on the middle.
    func testTheGoalBarGrowsPastItsButtonsAndKeepsThem30() {
        for scale in scales {
            let label = line(ChatTextStyles.goalLabel, scale)
            let goal = line(ChatTextStyles.goalText, scale)
            let layout = GoalBarLayout(
                width: 377,
                label: words("Current goal", ChatTextStyles.goalLabel, scale, maxLines: 1),
                text: words("Ship the release", ChatTextStyles.goalText, scale, maxLines: 1),
                actionCount: 2
            )
            assertFrame(layout.label, rect(41, layout.label.minY, 249, label))
            assertFrame(layout.text, rect(41, layout.label.maxY, 249, goal))
            XCTAssertEqual(layout.card.height, max(30, label + goal) + 22, accuracy: 0.001)
            XCTAssertEqual(layout.size.height, layout.card.height + 8, accuracy: 0.001)
            XCTAssertEqual((layout.label.minY + layout.text.maxY) / 2, layout.card.midY, accuracy: 0.001)
            assertSize(layout.icon.size, CGSize(width: 18, height: 18))
            XCTAssertEqual(layout.icon.midY, layout.card.midY, accuracy: 0.001)
            XCTAssertEqual(layout.actions.count, 2)
            for (index, action) in layout.actions.enumerated() {
                assertFrame(action, rect(300 + CGFloat(index) * 34, layout.card.midY - 15, 30, 30))
            }
        }
        // At AX-XXXL: 16 is 57.14, up to 172 pixels, and 19 is 67.85, up
        // to 204.
        let layout = GoalBarLayout(
            width: 377, label: words("Current goal", ChatTextStyles.goalLabel, largest, maxLines: 1),
            text: words("Ship", ChatTextStyles.goalText, largest, maxLines: 1), actionCount: 2
        )
        assertFrame(layout.card, rect(0, 0, 377, 376.0 / 3 + 22))
        assertFrame(layout.label, rect(41, 11, 249, 172.0 / 3))
    }

    /// RigActivityBar: its counts grow and wrap onto more lines sooner;
    /// the 12 pt glyphs keep their size, each on its count's middle.
    func testRigActivityWrapsSoonerAsItsCountsGrow() {
        var lines: [Int] = []
        for scale in scales {
            let labels = ["2 agents", "1 processes", "3 tasks"].map { words($0, ChatTextStyles.rigActivity, scale, maxLines: 1) }
            let layout = RigActivityLayout(width: 393, labels: labels)
            let count = line(ChatTextStyles.rigActivity, scale)
            XCTAssertEqual(layout.labels.count, 3)
            for (icon, label) in zip(layout.icons, layout.labels) {
                assertSize(icon.size, CGSize(width: 12, height: 12))
                XCTAssertEqual(label.height, count, accuracy: 0.001)
                XCTAssertEqual(icon.midY, label.midY, accuracy: 0.001)
                XCTAssertEqual(label.minX - icon.maxX, 4)
                XCTAssertLessThanOrEqual(label.maxX, 393 - 16 + 0.001)
            }
            let rows = Set(layout.labels.map(\.minY)).count
            lines.append(rows)
            let tallest = max(12, count)
            XCTAssertEqual(layout.size.height, CGFloat(rows) * tallest + CGFloat(rows - 1) * 10 + 10, accuracy: 0.001)
        }
        // One line up to XXXL, then one count a line.
        XCTAssertEqual(lines, [1, 1, 1, 2, 3])
    }

    /// InactiveArchivedHint: the notice grows; Resume keeps its 44 while
    /// its label grows past it, centred on it, as RN's fixed `height`
    /// leaves it; the command block grows past its 48 with its commands.
    func testResumeKeeps44AndTheCommandsGrowPast48() {
        for scale in scales {
            let notice = line(ChatTextStyles.inactiveHint, scale)
            let label = line(ChatTextStyles.resumeButton, scale)
            let resume = InactiveHintLayout(
                width: 361, notice: words("Inactive.", ChatTextStyles.inactiveHint, scale), terminalNotice: nil,
                action: .resume(label: words("Resume", ChatTextStyles.resumeButton, scale, maxLines: 1))
            )
            assertFrame(resume.notice, rect(8, 12, 345, notice))
            assertFrame(resume.button, rect(8, 12 + notice + 10, 345, 44))
            XCTAssertEqual(resume.buttonLabel?.height ?? 0, label, accuracy: 0.001)
            XCTAssertEqual(resume.buttonLabel?.midY ?? 0, resume.button?.midY ?? -1, accuracy: 0.001)
            XCTAssertEqual(resume.size.height, 12 + notice + 10 + 44 + 10, accuracy: 0.001)

            let commands = line(ChatTextStyles.resumeCommand, scale)
            let command = InactiveHintLayout(
                width: 361, notice: words("Inactive.", ChatTextStyles.inactiveHint, scale),
                terminalNotice: words("To resume it:", ChatTextStyles.inactiveHint, scale),
                action: .command(text("happy resume", advance: 8 * scale.multiplier, lineHeight: commands))
            )
            let textHeight = command.commandText?.height ?? 0
            XCTAssertEqual(command.command?.height ?? 0, max(48, textHeight + 24), accuracy: 0.001)
            assertSize(command.commandIcon?.size ?? .zero, CGSize(width: 16, height: 16))
            XCTAssertEqual(command.commandIcon?.minY ?? 0, (command.command?.minY ?? 0) + 13, accuracy: 0.001)
        }
        // At AX-M Resume's label (15 × 1.2 × 1.786 = 32.15) still fits; at
        // AX-XXXL it is 64.28, up to 193 pixels, and spills 10.17 above
        // and below.
        let largestResume = InactiveHintLayout(
            width: 361, notice: words("Inactive.", ChatTextStyles.inactiveHint, largest), terminalNotice: nil,
            action: .resume(label: words("Resume", ChatTextStyles.resumeButton, largest, maxLines: 1))
        )
        let button = try! XCTUnwrap(largestResume.button)
        let label = try! XCTUnwrap(largestResume.buttonLabel)
        XCTAssertEqual(button.height, 44)
        XCTAssertEqual(label.height, 193.0 / 3, accuracy: 0.001)
        XCTAssertEqual(button.minY - label.minY, (193.0 / 3 - 44) / 2, accuracy: 0.001)
    }
}
