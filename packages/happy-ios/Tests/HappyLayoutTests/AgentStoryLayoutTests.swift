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
