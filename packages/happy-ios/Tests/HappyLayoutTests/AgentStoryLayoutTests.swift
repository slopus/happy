import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for agents' stories: live pages in their CSS viewports,
/// round videos, the repost chip and the viewer's feedback bar.
final class AgentStoryLayoutTests: XCTestCase {
    func testAnArtifactFramesPageFillsTheCanvasFromItsViewport() {
        // A 9:16 canvas holds 360 × 640 exactly.
        let page = AgentStoryLayout.framePage(canvas: CGSize(width: 393, height: 698.67))
        XCTAssertEqual(page.viewport, CGSize(width: 360, height: 640))
        XCTAssertEqual(page.scale, 698.67 / 640, accuracy: 1e-9)
        XCTAssertEqual(page.box.midX, 196.5, accuracy: 1e-9)
        XCTAssertEqual(page.box.minY, 0, accuracy: 1e-9)
        // A wider box crops top and bottom evenly.
        let wide = AgentStoryLayout.framePage(canvas: CGSize(width: 720, height: 1000))
        XCTAssertEqual(wide.scale, 2)
        XCTAssertEqual(wide.box, CGRect(x: 0, y: -140, width: 720, height: 1280))
    }

    func testAnArtifactWindowIsItsScaleOfTheCanvasWide() {
        let page = AgentStoryLayout.windowPage(aspectRatio: 0.8, scale: 0.8, canvas: CGSize(width: 540, height: 960))
        XCTAssertEqual(page.box, CGRect(x: -216, y: -270, width: 432, height: 540))
        XCTAssertEqual(page.viewport, CGSize(width: 360, height: 450))
        XCTAssertEqual(page.scale, 1.2)
        XCTAssertEqual(page.radius, 20)
        // The shape stays inside the API's range.
        XCTAssertEqual(AgentStoryLayout.windowPage(aspectRatio: 9, scale: 1, canvas: CGSize(width: 400, height: 700)).box.height, 100)
    }

    func testOnlyTheEdgeTenthsOfAPageMoveBetweenFrames() {
        let canvas = CGRect(x: 0, y: 50, width: 400, height: 711)
        XCTAssertTrue(AgentStoryLayout.navigates(x: 39, canvas: canvas))
        XCTAssertFalse(AgentStoryLayout.navigates(x: 41, canvas: canvas))
        XCTAssertFalse(AgentStoryLayout.navigates(x: 359, canvas: canvas))
        XCTAssertTrue(AgentStoryLayout.navigates(x: 361, canvas: canvas))
        XCTAssertEqual(AgentStoryLayout.edges(canvas: canvas.size), [CGRect(x: 0, y: 0, width: 40, height: 711), CGRect(x: 360, y: 0, width: 40, height: 711)])
    }

    func testTheRepostChipSitsAtTheCanvasesBottomLeft() {
        let chip = AgentStoryLayout.chip(textWidth: 100, canvas: CGSize(width: 360, height: 640))
        XCTAssertEqual(chip.fontSize, 11)
        XCTAssertEqual(chip.frame, CGRect(x: 14, y: 640 - 14 - 24, width: 120, height: 24))
        // Never wider than the canvas less its insets.
        XCTAssertEqual(AgentStoryLayout.chip(textWidth: 900, canvas: CGSize(width: 360, height: 640)).frame.width, 332)
    }

    func testTheFeedbackBarIsFieldHeartRepost() {
        let bar = AgentStoryLayout.bar(canvas: CGRect(x: 0, y: 59, width: 393, height: 699), bar: CGRect(x: 0, y: 758, width: 393, height: 60), barHeight: 52)
        XCTAssertEqual(bar.repost, CGRect(x: 351, y: 768, width: 32, height: 32))
        XCTAssertEqual(bar.heart, CGRect(x: 311, y: 768, width: 32, height: 32))
        XCTAssertEqual(bar.field, CGRect(x: 10, y: 766, width: 293, height: 36))
        // Over a keyboard, all three rise together.
        let lifted = AgentStoryLayout.bar(canvas: CGRect(x: 0, y: 59, width: 393, height: 699), bar: CGRect(x: 0, y: 758, width: 393, height: 60), barHeight: 52, lift: 300)
        XCTAssertEqual(lifted.field.minY, 466)
        XCTAssertEqual(lifted.repost.minY, 468)
    }

    func testAStoryArtifactsReplyBarIs44Tall8OverTheBarsFoot() {
        let canvas = CGRect(x: 0, y: 59, width: 393, height: 699), under = CGRect(x: 0, y: 758, width: 393, height: 60)
        XCTAssertEqual(AgentStoryLayout.bar(canvas: canvas, bar: under, barHeight: 52, replyOnly: true).field, CGRect(x: 12, y: 766, width: 369, height: 44))
        XCTAssertEqual(AgentStoryLayout.bar(canvas: canvas, bar: under, barHeight: 52, lift: 300, replyOnly: true).field, CGRect(x: 12, y: 466, width: 369, height: 44))
        XCTAssertEqual(Palette.storiesReplyFill.dark.alpha, 0x8C / 255.0)
        // The header on one line: the name 8 after the avatar, the time 8 after the name, a long name cut first.
        let viewer = StoryViewerLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 59, left: 0, bottom: 34, right: 0))
        let header = AgentStoryLayout.header(viewer, withSound: false, name: CGSize(width: 150, height: 17), time: CGSize(width: 20, height: 16))
        XCTAssertEqual([header.name, header.time], [CGRect(x: 52, y: 84, width: 150, height: 18), CGRect(x: 210, y: 84, width: 20, height: 18)])
        XCTAssertEqual(AgentStoryLayout.header(viewer, withSound: false, name: CGSize(width: 400, height: 17), time: CGSize(width: 20, height: 16)).time.maxX, viewer.more.minX)
        XCTAssertEqual(AgentStoryLayout.pill(textWidth: 200, canvas: canvas.size).frame, CGRect(x: 52, y: 54, width: 218, height: 22))
    }

    func testAStoryArtifactsFootAndDrawerAreTheMocks() {
        let canvas = CGRect(x: 0, y: 59, width: 393, height: 699), field = CGRect(x: 12, y: 766, width: 369, height: 44)
        // Caption, 10, "View all", 6, two 28 rows 4 apart, 12 over the canvas's foot; the scrim from 72 over the caption.
        let foot = AgentStoryLayout.foot(canvas: canvas, field: field, caption: { XCTAssertEqual($0, 369); return 40 }, rows: 2, all: true)
        XCTAssertEqual([foot.scrim, foot.caption, foot.all] + foot.rows, [CGRect(x: 0, y: 538, width: 393, height: 220), CGRect(x: 12, y: 610, width: 369, height: 40),
                       CGRect(x: 12, y: 660, width: 369, height: 20), CGRect(x: 12, y: 686, width: 369, height: 28), CGRect(x: 12, y: 718, width: 369, height: 28)])
        XCTAssertEqual(AgentStoryLayout.foot(canvas: canvas, field: field, caption: { _ in 40 }, rows: 2, all: false).caption.minY, 636)
        XCTAssertEqual(AgentStoryLayout.foot(canvas: canvas, field: field, caption: { _ in 40 }, rows: 0, all: false).caption.minY, 706)
        let peek = AgentStoryLayout.replyRow(width: 369, text: nil), stacked = AgentStoryLayout.replyRow(width: 393, text: 40)
        XCTAssertEqual([peek.face, peek.line, stacked.face, stacked.line, stacked.text], [CGRect(x: 0, y: 2, width: 24, height: 24), CGRect(x: 32, y: 5, width: 337, height: 18),
                       CGRect(x: 16, y: 8, width: 32, height: 32), CGRect(x: 58, y: 8, width: 319, height: 18), CGRect(x: 58, y: 26, width: 319, height: 40)])
        XCTAssertEqual([peek.height, stacked.height], [28, 74])
        // The drawer, 562 tall: the heading's row, the rows at the list's foot, the field 8 over the home indicator.
        let drawer = AgentStoryLayout.drawer(size: CGSize(width: 393, height: 562), bottom: 34, heights: [74, 54])
        XCTAssertEqual([drawer.heading, drawer.close, drawer.list, drawer.field] + drawer.rows + drawer.lines, [CGRect(x: 16, y: 20.5, width: 337, height: 16),
                       CGRect(x: 353, y: 12.5, width: 32, height: 32), CGRect(x: 0, y: 50, width: 393, height: 417), CGRect(x: 12, y: 476, width: 369, height: 44),
                       CGRect(x: 0, y: 283, width: 393, height: 74), CGRect(x: 0, y: 357, width: 393, height: 54), CGRect(x: 0, y: 49, width: 393, height: 1), CGRect(x: 0, y: 467, width: 393, height: 1)])
        XCTAssertEqual([drawer.content, AgentStoryLayout.drawer(size: CGSize(width: 393, height: 562), bottom: 34, heights: [300, 300]).content], [417, 612])
    }

    func testARoundVideoNeverTouchesTheReplyBarAKeyboardLifts() {
        let canvas = CGRect(x: 0, y: 59, width: 393, height: 699), under = CGRect(x: 0, y: 758, width: 393, height: 60)
        // Under the header, 0.3 of the canvas wide, clear of the foot.
        XCTAssertEqual(AgentStoryLayout.round(canvas: canvas.size, above: 551), CGRect(x: 12, y: 86, width: 393 * 0.3, height: 393 * 0.3))
        // A keyboard lifting the field this far shrinks it in place, its foot 8 over the field.
        let field = AgentStoryLayout.bar(canvas: canvas, bar: under, barHeight: 52, lift: 600, replyOnly: true).field
        let round = AgentStoryLayout.round(canvas: canvas.size, above: field.minY - canvas.minY)
        XCTAssertEqual(round, CGRect(x: 12, y: 86, width: 13, height: 13))
        XCTAssertLessThanOrEqual(round.maxY + canvas.minY, field.minY - 8)
    }

    func testTheEditorMakesRoomForTheRoundVideoButton() {
        let plain = StoryEditorLayout(bounds: CGRect(x: 0, y: 0, width: 393, height: 852), statusBar: 59, homeIndicator: 34, postContent: 60)
        let round = StoryEditorLayout(bounds: CGRect(x: 0, y: 0, width: 393, height: 852), statusBar: 59, homeIndicator: 34, postContent: 60, roundVideo: true)
        XCTAssertNil(plain.roundVideo)
        let button = try! XCTUnwrap(round.roundVideo)
        XCTAssertEqual(button.size, CGSize(width: 40, height: 40))
        XCTAssertEqual(button.maxX, round.captionPanel.maxX - 9)
        XCTAssertEqual(button.minY, round.caption.minY)
        XCTAssertEqual(round.caption.maxX, button.minX - 9)
        XCTAssertEqual(round.caption.minX, plain.caption.minX)
    }
}
