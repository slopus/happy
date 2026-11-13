import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The "+" menu's picture opened whole, as Telegram's media picker gallery
/// places it, zooms it, and lets it be dragged away.
final class AttachPreviewLayoutTests: XCTestCase {
    private let phone = CGSize(width: 402, height: 874)

    func testTheCheckSitsWhereTelegramsGalleryCheckIsAndBackMirrorsIt() {
        let layout = AttachPreviewLayout(size: phone, safeArea: LayoutInsets(top: 62, bottom: 34), count: 30)
        // Telegram's 39 box at right − 44, top + 5: centred at 377.5, 86.5.
        XCTAssertEqual(layout.check, CGRect(x: 363, y: 72, width: 29, height: 29))
        XCTAssertEqual(layout.checkButton, CGRect(x: 355.5, y: 64.5, width: 44, height: 44))
        XCTAssertEqual(layout.back, CGRect(x: 2.5, y: 64.5, width: 44, height: 44))
        XCTAssertEqual(layout.check.midX - layout.checkButton.minX, 22)
        XCTAssertEqual(layout.back.midX, phone.width - layout.check.midX)
    }

    func testAStatusBarsTwentyIsNotSafeAreaAsInTelegram() {
        let layout = AttachPreviewLayout(size: CGSize(width: 375, height: 667), safeArea: LayoutInsets(top: 20), count: 3)
        XCTAssertEqual(layout.check, CGRect(x: 336, y: 10, width: 29, height: 29))
        XCTAssertEqual(layout.back, CGRect(x: 2.5, y: 2.5, width: 44, height: 44))
    }

    func testTurnedTheButtonsKeepInsideTheSideInsets() {
        let layout = AttachPreviewLayout(size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(left: 62, bottom: 21, right: 62), count: 3)
        XCTAssertEqual(layout.check, CGRect(x: 773, y: 10, width: 29, height: 29))
        XCTAssertEqual(layout.back, CGRect(x: 64.5, y: 2.5, width: 44, height: 44))
    }

    func testPagesAreAScreenWideAndTwentyApartAsTelegramsItemPadding() {
        let layout = AttachPreviewLayout(size: phone, safeArea: LayoutInsets(top: 62, bottom: 34), count: 30)
        XCTAssertEqual(layout.pager.pager, CGRect(x: -10, y: 0, width: 422, height: 874))
        XCTAssertEqual(layout.pager.contentSize, CGSize(width: 12660, height: 874))
        XCTAssertEqual(layout.pager.page(7), CGRect(x: 2964, y: 0, width: 402, height: 874))
        XCTAssertEqual(layout.pager.offset(7), 2954)
        XCTAssertEqual(layout.pager.index(at: 2954 + 200, count: 30), 7)
        XCTAssertEqual(layout.pager.index(at: 2954 + 212, count: 30), 8)
    }

    func testAPictureFillsTheScreenAcrossOrDownEnlargedAsTelegrams() {
        XCTAssertEqual(AttachPreviewLayout.fit(CGSize(width: 300, height: 400), in: phone), CGRect(x: 0, y: 169, width: 402, height: 536))
        XCTAssertEqual(AttachPreviewLayout.fit(CGSize(width: 4000, height: 3000), in: phone), CGRect(x: 0, y: 286.25, width: 402, height: 301.5))
        XCTAssertEqual(AttachPreviewLayout.fit(CGSize(width: 100, height: 400), in: phone), CGRect(x: 91.75, y: 0, width: 218.5, height: 874))
        XCTAssertEqual(AttachPreviewLayout.fit(.zero, in: phone), CGRect(x: 0, y: 0, width: 402, height: 874), "unknown: the whole page")
    }

    func testZoomReachesFilledAndAtLeastThreeTimes() {
        XCTAssertEqual(AttachPreviewLayout.maximumZoom(CGSize(width: 300, height: 400), in: phone), 3)
        XCTAssertEqual(AttachPreviewLayout.maximumZoom(CGSize(width: 4000, height: 1000), in: phone), 874 / 100.5, accuracy: 0.0001)
        XCTAssertEqual(AttachPreviewLayout.maximumZoom(.zero, in: phone), 1)
    }

    func testAZoomedPictureCentresAlongASideItDoesntFill() {
        XCTAssertEqual(AttachPreviewLayout.zoomed(CGSize(width: 804, height: 1072), in: phone), CGRect(x: 0, y: 0, width: 804, height: 1072))
        XCTAssertEqual(AttachPreviewLayout.zoomed(CGSize(width: 804, height: 300), in: phone), CGRect(x: 0, y: 287, width: 804, height: 300))
        XCTAssertEqual(AttachPreviewLayout.zoomed(CGSize(width: 402, height: 536), in: phone), CGRect(x: 0, y: 169, width: 402, height: 536))
    }

    func testADoubleTapZoomsAroundTheTap() {
        XCTAssertEqual(AttachPreviewLayout.zoomRect(at: CGPoint(x: 201, y: 437), bounds: phone, scale: 2), CGRect(x: 100.5, y: 218.5, width: 201, height: 437))
        XCTAssertEqual(AttachPreviewLayout.zoomRect(at: CGPoint(x: 0, y: 0), bounds: phone, scale: 4), CGRect(x: -50.25, y: -109.25, width: 100.5, height: 218.5))
    }

    func testAVideosPlayButtonIsCentredOnItsPicture() {
        XCTAssertEqual(AttachPreviewLayout.play(in: CGRect(x: 0, y: 169, width: 402, height: 536)), CGRect(x: 171, y: 407, width: 60, height: 60))
    }

    func testTheZoomCutsThePictureAsTheCellAndShowsItWholeAsThePage() {
        let natural = CGSize(width: 200, height: 400)
        let page = AttachPreviewLayout.fit(natural, in: phone)
        XCTAssertEqual(page, CGRect(x: 0, y: 35, width: 402, height: 804))
        let zoom = AttachPreviewLayout.Zoom(cell: CGRect(x: 10, y: 500, width: 133, height: 133), page: page, natural: natural)
        XCTAssertEqual(zoom.cell, CGRect(x: 10, y: 500, width: 133, height: 133))
        XCTAssertEqual(zoom.cellPicture, CGRect(x: 0, y: -66.5, width: 133, height: 266))
        XCTAssertEqual(zoom.page, CGRect(x: 0, y: 35, width: 402, height: 804))
        XCTAssertEqual(zoom.pagePicture, CGRect(x: 0, y: 0, width: 402, height: 804))
        XCTAssertEqual(AttachPreviewLayout.fill(CGSize(width: 400, height: 200), in: CGSize(width: 100, height: 100)), CGRect(x: -50, y: 0, width: 200, height: 100))
    }

    func testADragFadesTheBlackWithinAQuarterOfItsDistanceAndHidesTheButtons() {
        let rest = AttachPreviewDismissal(distance: 0, velocity: 0)
        XCTAssertEqual(rest.progress, 0)
        XCTAssertEqual(rest.groundAlpha, 1)
        XCTAssertFalse(rest.chromeHidden)
        XCTAssertFalse(rest.closes)

        let some = AttachPreviewDismissal(distance: 30, velocity: 0)
        XCTAssertEqual(some.progress, 0.2, accuracy: 0.0001)
        XCTAssertEqual(some.groundAlpha, 0.2, accuracy: 0.0001)
        XCTAssertTrue(some.chromeHidden)

        XCTAssertEqual(AttachPreviewDismissal(distance: 37.5, velocity: 0).groundAlpha, 0)
        XCTAssertEqual(AttachPreviewDismissal(distance: -300, velocity: 0).progress, 1, "up as well as down")
    }

    func testLetGoPast128OrFasterThan700ItCloses() {
        XCTAssertFalse(AttachPreviewDismissal(distance: 127, velocity: 699).closes)
        XCTAssertTrue(AttachPreviewDismissal(distance: 128, velocity: 0).closes)
        XCTAssertTrue(AttachPreviewDismissal(distance: 20, velocity: 700).closes)
        XCTAssertTrue(AttachPreviewDismissal(distance: -20, velocity: -900).closes)
        // It goes at least 600 a second, the way it was flung.
        XCTAssertEqual(AttachPreviewDismissal(distance: 200, velocity: 100).velocity, 600)
        XCTAssertEqual(AttachPreviewDismissal(distance: -200, velocity: -100).velocity, -600)
        XCTAssertEqual(AttachPreviewDismissal(distance: 200, velocity: 1500).velocity, 1500)
    }

    func testWithNoCellItLeavesTheScreenWithinTheZoomsTime() {
        let slow = AttachPreviewDismissal.leave(velocity: 600, height: 874)
        XCTAssertEqual(slow.offset, 874)
        XCTAssertEqual(slow.duration, 0.22, accuracy: 0.0001)
        let up = AttachPreviewDismissal.leave(velocity: -8000, height: 874)
        XCTAssertEqual(up.offset, -874)
        XCTAssertEqual(up.duration, 874.0 / 8000, accuracy: 0.0001, "a finger faster than the zoom keeps its speed")
        let opening = AttachPreviewDismissal.leave(velocity: 0, height: 874)
        XCTAssertEqual(opening.offset, 874, "with no velocity it comes from below")
        XCTAssertEqual(opening.duration, 0.22, accuracy: 0.0001)
    }

    func testThePreviewMovesIn220MillisecondsBothWays() {
        XCTAssertEqual(AttachPreviewMotion.duration, 0.22)
        XCTAssertLessThan(AttachPreviewMotion.fadeOut, AttachPreviewMotion.duration)
        // An ease out that never overshoots.
        let curve = AttachPreviewMotion.curve
        XCTAssertGreaterThan(curve.y1, curve.x1)
        XCTAssertLessThanOrEqual(max(curve.y1, curve.y2), 1)
    }
}

/// The preview's foot: Telegram's toolbar and caption panel, and what the
/// keyboard does to them.
final class AttachPreviewFootLayoutTests: XCTestCase {
    private let phone = CGSize(width: 402, height: 874)
    private let safe = LayoutInsets(top: 62, bottom: 34)

    func testBackAndToolsShareTheBottomRowAndThePictureClearsTheCaption() {
        let foot = AttachPreviewFootLayout(size: phone, safeArea: safe, keyboard: 0, inset: 8, cardHeight: 50, tools: 2)
        XCTAssertEqual(foot.bar, CGRect(x: 0, y: 791, width: 402, height: 83))
        XCTAssertEqual(foot.tools, [CGRect(x: 152, y: 793.5, width: 44, height: 44), CGRect(x: 206, y: 793.5, width: 44, height: 44)])
        XCTAssertEqual(foot.card, CGRect(x: 8, y: 731, width: 386, height: 50))
        XCTAssertEqual(foot.back, CGRect(x: 26, y: 793.5, width: 44, height: 44))
        XCTAssertEqual(foot.group, CGRect(x: 152, y: 793.5, width: 98, height: 44))
        XCTAssertEqual(foot.pictures, CGRect(x: 12, y: 118, width: 378, height: 601))
        XCTAssertFalse(foot.typing)
    }

    func testTypingTheCaptionAndWholePictureStayAboveTheKeyboard() {
        let foot = AttachPreviewFootLayout(size: phone, safeArea: safe, keyboard: 336, inset: 8, cardHeight: 50, tools: 2)
        XCTAssertTrue(foot.typing)
        XCTAssertEqual(foot.card, CGRect(x: 8, y: 480, width: 386, height: 50))
        XCTAssertEqual(foot.pictures, CGRect(x: 12, y: 118, width: 378, height: 350))
        // The bar stays where it was, under the keyboard.
        XCTAssertEqual(foot.bar.minY, 791)
    }

    func testALongCaptionStopsAtAThirdOfWhatTheKeyboardLeaves() {
        let foot = AttachPreviewFootLayout(size: phone, safeArea: safe, keyboard: 336, inset: 8, cardHeight: 400, tools: 2)
        XCTAssertEqual(foot.card.height, (874 - 336) / 3)
        XCTAssertEqual(foot.card.maxY, 874 - 336 - 8)
    }

    func testTurnedTheCaptionKeepsInsideTheSideInsets() {
        let foot = AttachPreviewFootLayout(size: CGSize(width: 874, height: 402), safeArea: LayoutInsets(left: 62, bottom: 21, right: 62), keyboard: 0, inset: 8, cardHeight: 50, tools: 2)
        XCTAssertEqual(foot.card, CGRect(x: 70, y: 272, width: 734, height: 50))
        XCTAssertEqual(foot.bar, CGRect(x: 0, y: 332, width: 874, height: 70))
    }
}
