import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The chat's placeholder (EmptyMessages, PendingChatPlaceholder and the
/// deleted state) at the person's text size, as React Native lays it out:
/// its words grow by one multiplier, while the glyphs, the margins between
/// the lines, their paddings, the paging spinner and RoundButton's minimum
/// height do not, and the column stays centred in the frame. Text here is
/// the stand-in `text(_:advance:lineHeight:)`, its line up to a 3x
/// screen's next pixel, measured at the width its padding leaves it.
final class ChatPlaceholderLayoutTests: XCTestCase {
    private let frame = CGSize(width: 393, height: 700)
    private let scales: [TextScale] = [
        TextScale(.extraSmall), .standard, TextScale(.extraExtraExtraLarge),
        TextScale(.accessibilityMedium), TextScale(.accessibilityExtraExtraExtraLarge),
    ]
    private let spinner = CGSize(width: 20, height: 20)

    /// `count` characters with a line `lineHeight` tall at the designed
    /// size, 8 a character, at `scale` inside `padding`.
    private func words(_ count: Int, line lineHeight: CGFloat, _ scale: TextScale, padding: CGFloat = 48, maxLines: Int = 0) -> CGSize {
        text(
            String(repeating: "a", count: count), advance: 8 * scale.multiplier,
            lineHeight: PixelGrid.ceil(lineHeight * scale.multiplier, scale: 3), maxLines: maxLines
        ).size(fitting: frame.width - padding * 2)
    }

    /// RoundButton's small inverted label, stretched to `width`.
    private func button(_ count: Int, _ scale: TextScale, width: CGFloat) -> CGSize {
        RoundButtonLayout(.init(
            width: width, size: .small, display: .inverted,
            label: text(String(repeating: "a", count: count), advance: 8 * scale.multiplier, lineHeight: PixelGrid.ceil(17 * scale.multiplier, scale: 3))
        )).size
    }

    /// EmptyMessages for a session with no messages yet, paging: the
    /// glyph, host, path, the spinner and "Created …".
    private func empty(_ scale: TextScale, height: CGFloat? = nil) -> ChatPlaceholderLayout {
        ChatPlaceholderLayout(
            size: CGSize(width: frame.width, height: height ?? frame.height),
            icon: CGSize(width: 72, height: 72), title: nil,
            lines: [
                .init(size: words(10, line: 24, scale), spacing: 12, padding: 48),
                .init(size: words(20, line: 18, scale), spacing: 4, padding: 48),
                .init(size: words(12, line: 24, scale), spacing: 8, padding: 48),
            ],
            status: .init(index: 2, size: spinner, spacing: 40)
        )
    }

    /// The frames top to bottom.
    private func column(_ layout: ChatPlaceholderLayout) -> [CGRect] {
        ([layout.icon, layout.title].compactMap { $0 } + layout.lines + [layout.status].compactMap { $0 }).sorted { $0.minY < $1.minY }
    }

    /// Each frame's space above it, under the one before.
    private func gaps(_ frames: [CGRect]) -> [CGFloat] {
        zip(frames, frames.dropFirst()).map { $1.minY - $0.maxY }
    }

    private func assertCentred(_ frames: [CGRect], in size: CGSize, file: StaticString = #filePath, line: UInt = #line) {
        guard let top = frames.first, let bottom = frames.last else { return XCTFail("nothing placed", file: file, line: line) }
        XCTAssertEqual(top.minY, size.height - bottom.maxY, accuracy: 0.001, "the column is centred", file: file, line: line)
        for frame in frames {
            XCTAssertEqual(frame.midX, size.width / 2, accuracy: 0.001, "\(frame) is centred", file: file, line: line)
        }
    }

    func testAtTheDesignedSizeTheEmptyChatIsWhereRNPutsIt() {
        let layout = empty(.standard)
        assertFrame(layout.icon, rect(160.5, 239, 72, 72))
        XCTAssertNil(layout.title)
        XCTAssertEqual(layout.lines.count, 3)
        assertFrame(layout.lines[0], rect(156.5, 323, 80, 24))
        assertFrame(layout.lines[1], rect(116.5, 351, 160, 18))
        assertFrame(layout.status, rect(186.5, 409, 20, 20))
        assertFrame(layout.lines[2], rect(148.5, 437, 96, 24))
    }

    func testTheEmptyChatsWordsGrowAndItsMarginsAndGlyphsDoNot() {
        for scale in scales {
            let layout = empty(scale)
            let frames = column(layout)
            XCTAssertEqual(gaps(frames), [12, 4, 40, 8], "at \(scale.multiplier)")
            assertSize(layout.icon?.size ?? .zero, CGSize(width: 72, height: 72))
            assertSize(layout.status?.size ?? .zero, spinner)
            assertSize(layout.lines[0].size, words(10, line: 24, scale))
            assertSize(layout.lines[1].size, words(20, line: 18, scale))
            assertSize(layout.lines[2].size, words(12, line: 24, scale))
            assertCentred(frames, in: frame)
        }
        // At AX-XXXL the path wraps inside its padding, and the host's 24
        // line is 85.70, up to 86.
        let largest = empty(TextScale(.accessibilityExtraExtraExtraLarge))
        XCTAssertEqual(largest.lines[0].height, 86, accuracy: 0.001)
        XCTAssertEqual(largest.lines[1].height, 2 * 193.0 / 3, accuracy: 0.001)
        XCTAssertLessThanOrEqual(largest.lines[1].width, 297)
    }

    /// The keyboard moving the dock changes the frame's height: the column
    /// moves by half of it, measured as it was.
    func testANewHeightOnlyMovesTheColumn() {
        for scale in scales {
            let tall = column(empty(scale))
            let short = column(empty(scale, height: 600))
            XCTAssertEqual(short.count, tall.count)
            for (moved, was) in zip(short, tall) {
                assertFrame(moved, was.offsetBy(dx: 0, dy: -50))
            }
        }
    }

    /// Load more or Retry in EmptyMessages' column: RoundButton stretched
    /// to its padding, at least its 32 tall, with no margin under it.
    func testTheStatusButtonGrowsWithItsLabelAndKeepsNoMargin() {
        for scale in scales {
            let status = button(9, scale, width: 297)
            let layout = ChatPlaceholderLayout(
                size: frame, icon: CGSize(width: 72, height: 72), title: nil,
                lines: [
                    .init(size: words(10, line: 24, scale), spacing: 12, padding: 48),
                    .init(size: words(12, line: 24, scale), spacing: 0, padding: 48),
                ],
                status: .init(index: 1, size: status, spacing: 4)
            )
            let frames = column(layout)
            XCTAssertEqual(gaps(frames), [12, 4, 0])
            assertFrame(layout.status, rect(48, frames[2].minY, 297, max(32, PixelGrid.ceil(17 * scale.multiplier, scale: 3) + 16)))
            assertCentred(frames, in: frame)
        }
    }

    func testAtTheDesignedSizeTheStartingChatIsWhereRNPutsIt() {
        let layout = ChatPlaceholderLayout(
            size: frame, icon: CGSize(width: 64, height: 64), title: words(18, line: 23, .standard, maxLines: 1),
            lines: [.init(size: words(50, line: 21, .standard, maxLines: 6), spacing: 10, padding: 48)],
            status: nil
        )
        assertFrame(layout.icon, rect(164.5, 272.5, 64, 64))
        assertFrame(layout.title, rect(124.5, 352.5, 144, 23))
        assertFrame(layout.lines.first, rect(48.5, 385.5, 296, 42))
        XCTAssertNil(layout.status)
    }

    /// PendingChatPlaceholder: the glyph 64, 16 to the title, the queued
    /// message 10 under it, at most six lines at any size.
    func testTheStartingChatsWordsGrowAndItsQueuedMessageStopsAtSixLines() {
        for scale in scales {
            let queued = words(300, line: 21, scale, maxLines: 6)
            let layout = ChatPlaceholderLayout(
                size: frame, icon: CGSize(width: 64, height: 64), title: words(18, line: 23, scale, maxLines: 1),
                lines: [.init(size: queued, spacing: 10, padding: 48)],
                status: nil
            )
            let frames = column(layout)
            XCTAssertEqual(gaps(frames), [16, 10])
            assertSize(layout.icon?.size ?? .zero, CGSize(width: 64, height: 64))
            assertSize(layout.title?.size ?? .zero, words(18, line: 23, scale, maxLines: 1))
            XCTAssertEqual(layout.lines[0].height, 6 * PixelGrid.ceil(21 * scale.multiplier, scale: 3), accuracy: 0.001)
            assertCentred(frames, in: frame)
        }
    }

    /// The deleted state: the glyph 48, the title 16 under it across the
    /// whole width, the body 8 under that inside its 32 padding.
    func testTheDeletedStateKeepsItsMarginsAndPaddingsAtEverySize() {
        let designed = ChatPlaceholderLayout(
            size: frame, icon: CGSize(width: 48, height: 48), title: nil,
            lines: [
                .init(size: words(15, line: 24, .standard, padding: 0), spacing: 16, padding: 0),
                .init(size: words(60, line: 18, .standard, padding: 32), spacing: 8, padding: 32),
            ],
            status: nil
        )
        assertFrame(designed.icon, rect(172.5, 284, 48, 48))
        assertFrame(designed.lines[0], rect(136.5, 348, 120, 24))
        assertFrame(designed.lines[1], rect(32.5, 380, 328, 36))

        for scale in scales {
            let body = words(60, line: 18, scale, padding: 32)
            let layout = ChatPlaceholderLayout(
                size: frame, icon: CGSize(width: 48, height: 48), title: nil,
                lines: [
                    .init(size: words(15, line: 24, scale, padding: 0), spacing: 16, padding: 0),
                    .init(size: body, spacing: 8, padding: 32),
                ],
                status: nil
            )
            let frames = column(layout)
            XCTAssertEqual(gaps(frames), [16, 8])
            assertSize(layout.lines[1].size, body)
            XCTAssertLessThanOrEqual(layout.lines[1].width, 329)
            assertCentred(frames, in: frame)
        }
    }

    /// The first load failed: RoundButton's Retry alone in the middle,
    /// across the width, growing with its label past its 32.
    func testTheFirstLoadsRetrySitsInTheMiddleAtEverySize() {
        assertFrame(ChatPlaceholderLayout(size: frame, button: button(5, .standard, width: 393)).status, rect(0, 333.5, 393, 33))
        for scale in scales {
            let size = button(5, scale, width: 393)
            let layout = ChatPlaceholderLayout(size: frame, button: size)
            XCTAssertNil(layout.icon)
            XCTAssertNil(layout.title)
            XCTAssertEqual(layout.lines, [])
            assertFrame(layout.status, rect(0, (700 - size.height) / 2, 393, size.height))
        }
        let largest = button(5, TextScale(.accessibilityExtraExtraExtraLarge), width: 393)
        XCTAssertEqual(largest.height, 61 + 16, accuracy: 0.001)
    }

    func testAStatusPastTheLinesIsNotPlaced() {
        let layout = ChatPlaceholderLayout(
            size: frame, icon: nil, title: nil,
            lines: [.init(size: CGSize(width: 80, height: 24), spacing: 0, padding: 48)],
            status: .init(index: 2, size: spinner, spacing: 8)
        )
        XCTAssertNil(layout.status)
        assertFrame(layout.lines.first, rect(156.5, 338, 80, 24))
    }
}
