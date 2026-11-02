import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The full camera on an iPhone 15 Pro Max (430 × 932, its status bar 59
/// and home indicator 34) and an iPad Pro 11" held sideways (1194 × 834).
final class CameraScreenLayoutTests: XCTestCase {
    private let phoneSize = CGSize(width: 430, height: 932)
    private let phoneSafe = LayoutInsets(top: 59, bottom: 34)
    private let padSize = CGSize(width: 1194, height: 834)
    private let padSafe = LayoutInsets(top: 24, bottom: 20)

    private func phoneLayout(_ aspect: (preview: CGFloat, crop: CGFloat)) -> CameraScreenLayout {
        CameraScreenLayout(.init(size: phoneSize, safeArea: phoneSafe, previewRatio: aspect.preview, cropRatio: aspect.crop, regular: false, topButtons: 4, lenses: 3))
    }

    /// 4:3 under the bar, the shutter over the home indicator, the flip
    /// midway to the edge, the lenses over the picture's foot.
    func testAPhoneTakesFourByThreeUnderTheBar() {
        let layout = phoneLayout((4.0 / 3.0, 4.0 / 3.0))
        assertFrame(layout.close, rect(8, 59, 44, 44))
        XCTAssertEqual(layout.topButtons.count, 4)
        for (frame, x) in zip(layout.topButtons, [134, 215, 297, 378] as [CGFloat]) {
            assertFrame(frame, rect(x, 59, 44, 44))
        }
        assertFrame(layout.preview, rect(0, 103, 430, 430 * 4 / 3))
        assertFrame(layout.crop, layout.preview)
        assertFrame(layout.shutter, rect(167, 786, 96, 96))
        assertFrame(layout.flip, rect(323, 810, 48, 48))
        assertFrame(layout.modes, rect(0, 754, 430, 28))
        assertFrame(layout.zoomBar, rect(154, 103 + 430 * 4 / 3 - 55, 123, 43))
        for (frame, x) in zip(layout.zoomItems, [3, 43, 83] as [CGFloat]) {
            assertFrame(frame, rect(x, 3, 37, 37))
        }
    }

    /// 16:9 fills the screen's middle, under the bar and the controls; the
    /// lenses sit over the modes.
    func testWideIsCentredOnTheScreen() {
        let layout = phoneLayout((16.0 / 9.0, 16.0 / 9.0))
        assertFrame(layout.preview, rect(0, 84, 430, 430 * 16 / 9))
        assertFrame(layout.crop, layout.preview)
        assertFrame(layout.zoomBar, rect(154, 699, 123, 43))
        assertFrame(layout.shutter, rect(167, 786, 96, 96))
    }

    /// A square photo is the 4:3 picture's middle; the lenses follow it up.
    func testSquareIsTheMiddleOfFourByThree() {
        let layout = phoneLayout((4.0 / 3.0, 1))
        assertFrame(layout.preview, rect(0, 103, 430, 430 * 4 / 3))
        assertFrame(layout.crop, rect(0, 103 + 430 * 2 / 3 - 215, 430, 430))
        assertFrame(layout.cropInPreview, rect(0, 430 * 2 / 3 - 215, 430, 430))
        XCTAssertEqual(layout.outside.count, 2)
        assertFrame(layout.outside[0], rect(0, 0, 430, 430 * 2 / 3 - 215))
        assertFrame(layout.outside[1], rect(0, 430 * 2 / 3 + 215, 430, 430 * 2 / 3 - 215))
        assertFrame(layout.zoomBar, rect(154, 103 + 430 * 2 / 3 + 215 - 55, 123, 43))
    }

    /// An iPad: the controls are a column at the trailing edge, the picture
    /// fills the rest, close sits at the top leading corner.
    func testAnIPadHasAColumn() {
        let layout = CameraScreenLayout(.init(size: padSize, safeArea: padSafe, previewRatio: 4.0 / 3.0, cropRatio: 4.0 / 3.0, regular: true, topButtons: 3, lenses: 3))
        assertFrame(layout.close, rect(8, 32, 44, 44))
        assertFrame(layout.preview, rect(0, 14.25, 1074, 805.5))
        assertFrame(layout.shutter, rect(1086, 369, 96, 96))
        assertFrame(layout.flip, rect(1110, 489, 48, 48))
        assertFrame(layout.modes, rect(1074, 317, 120, 28))
        for (frame, y) in zip(layout.topButtons, [32, 84, 136] as [CGFloat]) {
            assertFrame(frame, rect(1112, y, 44, 44))
        }
        assertFrame(layout.zoomBar, rect(476, 764.75, 123, 43))
        // A square on its side: the bands are beside it.
        let square = CameraScreenLayout(.init(size: padSize, safeArea: padSafe, previewRatio: 4.0 / 3.0, cropRatio: 1, regular: true, topButtons: 3, lenses: 3))
        assertFrame(square.cropInPreview, rect(134.25, 0, 805.5, 805.5))
        assertFrame(square.outside[0], rect(0, 0, 134.25, 805.5))
        assertFrame(square.outside[1], rect(939.75, 0, 134.25, 805.5))

        // Upright, the picture stands in the room the column leaves.
        let upright = CameraScreenLayout(.init(size: CGSize(width: 834, height: 1194), safeArea: padSafe, previewRatio: 4.0 / 3.0, cropRatio: 4.0 / 3.0, regular: true, topButtons: 3, lenses: 3))
        assertFrame(upright.preview, rect(0, 121, 714, 952))
    }

    /// No lenses (a front camera): no bar.
    func testOneLensHasNoBar() {
        let layout = CameraScreenLayout(.init(size: phoneSize, safeArea: phoneSafe, previewRatio: 4.0 / 3.0, cropRatio: 4.0 / 3.0, regular: false, topButtons: 4, lenses: 0))
        XCTAssertEqual(layout.zoomBar.width, 0)
        XCTAssertTrue(layout.zoomItems.isEmpty)
    }

    /// The focus square stays within the picture; the exposure slider
    /// stands beside it, on its left when there is no room on its right.
    func testFocusAndExposure() {
        let preview = rect(0, 103, 430, 430 * 4 / 3)
        let focus = CameraScreenLayout.focus(at: CGPoint(x: 200, y: 300), in: preview)
        assertFrame(focus, rect(160, 260, 80, 80))
        assertFrame(CameraScreenLayout.focus(at: CGPoint(x: 10, y: 110), in: preview), rect(0, 103, 80, 80))

        let level = CameraScreenLayout.exposure(beside: focus, in: preview, bias: 0)
        assertFrame(level.track, rect(264.5, 228, 1, 144))
        assertFrame(level.sun, rect(252, 287, 26, 26))
        assertFrame(CameraScreenLayout.exposure(beside: focus, in: preview, bias: 1).sun, rect(252, 215, 26, 26))
        assertFrame(CameraScreenLayout.exposure(beside: focus, in: preview, bias: -2).sun, rect(252, 359, 26, 26))

        let right = CameraScreenLayout.focus(at: CGPoint(x: 420, y: 300), in: preview)
        assertFrame(right, rect(350, 260, 80, 80))
        assertFrame(CameraScreenLayout.exposure(beside: right, in: preview, bias: 0).track, rect(324.5, 228, 1, 144))
    }

    func testTheGridIsAtThePhotosThirds() {
        let crop = rect(0, 103, 430, 430 * 4 / 3)
        let lines = CameraScreenLayout.grid(in: crop)
        XCTAssertEqual(lines.count, 4)
        assertFrame(lines[0], rect(430.0 / 3 - 0.25, 103, 0.5, 430 * 4 / 3))
        assertFrame(lines[1], rect(430.0 * 2 / 3 - 0.25, 103, 0.5, 430 * 4 / 3))
        assertFrame(lines[2], rect(0, 103 + 430 * 4 / 9 - 0.25, 430, 0.5))
        assertFrame(lines[3], rect(0, 103 + 430 * 8 / 9 - 0.25, 430, 0.5))
    }

    func testTheShutterAndTheBanner() {
        let box = rect(167, 786, 96, 96)
        assertFrame(CameraScreenLayout.shutterRing(in: box), rect(14, 14, 68, 68))
        assertFrame(CameraScreenLayout.shutterDisc(in: box), rect(18, 18, 60, 60))
        let banner = CameraScreenLayout.banner(CGSize(width: 104, height: 18), in: rect(0, 103, 430, 573))
        assertFrame(banner.box, rect(155, 115, 120, 24))
        assertFrame(banner.label, rect(8, 3, 104, 18))
        assertFrame(CameraScreenLayout.centred(CGSize(width: 61, height: 20), in: rect(0, 0, 100, 100)), rect(20, 40, 61, 20))
    }

    /// The sun follows the finger: half the track is the slider's half.
    func testTheExposureSliderFollowsTheFinger() {
        XCTAssertEqual(CameraScreenLayout.exposureSlider(0, dragged: -36), 0.5)
        XCTAssertEqual(CameraScreenLayout.exposureSlider(0.5, dragged: 72), -0.5)
        XCTAssertEqual(CameraScreenLayout.exposureSlider(0.5, dragged: -200), 1)
    }

    /// The tile's 133 × 267 shows the full camera's 430 × 573 picture
    /// filled: scaled to its height.
    func testThePictureGrowsOutOfTheTile() {
        XCTAssertEqual(CameraScreenLayout.fillScale(CGSize(width: 430, height: 573), into: CGSize(width: 133, height: 267)), 267.0 / 573, accuracy: 1e-9)
        XCTAssertEqual(CameraScreenLayout.fillScale(.zero, into: CGSize(width: 1, height: 1)), 1)
    }

    /// Without a picture, the reason and Settings sit in its middle.
    func testTheMessage() {
        let area = rect(0, 103, 430, 573)
        XCTAssertEqual(CameraScreenLayout.messageWidth(in: area), 320)
        XCTAssertEqual(CameraScreenLayout.messageWidth(in: rect(0, 0, 300, 300)), 236)
        let placed = CameraScreenLayout.message(text: CGSize(width: 300, height: 44), button: CGSize(width: 160, height: 50), in: area)
        assertFrame(placed.text, rect(65, 333, 300, 44))
        assertFrame(placed.button, rect(135, 397, 160, 50))
        assertFrame(CameraScreenLayout.message(text: CGSize(width: 300, height: 44), button: nil, in: area).text, rect(65, 368, 300, 44))
    }

    /// The phone is locked upright; its buttons turn to read upright.
    func testTheButtonsTurnWithTheDevice() {
        XCTAssertEqual(CameraScreenLayout.iconRotation(.portrait), 0)
        XCTAssertEqual(CameraScreenLayout.iconRotation(.landscapeLeft), .pi / 2)
        XCTAssertEqual(CameraScreenLayout.iconRotation(.landscapeRight), -.pi / 2)
        XCTAssertEqual(CameraScreenLayout.iconRotation(.portraitUpsideDown), .pi)
    }

    /// A 12 MP photo cut to each shape, held either way.
    func testTheCropIsThePhotosMiddle() {
        let landscape = CGSize(width: 4032, height: 3024)
        assertFrame(CameraCrop.rect(pixels: landscape, ratio: 4.0 / 3.0), rect(0, 0, 4032, 3024))
        assertFrame(CameraCrop.rect(pixels: landscape, ratio: 16.0 / 9.0), rect(0, 378, 4032, 2268))
        assertFrame(CameraCrop.rect(pixels: landscape, ratio: 1), rect(504, 0, 3024, 3024))
        let portrait = CGSize(width: 3024, height: 4032)
        assertFrame(CameraCrop.rect(pixels: portrait, ratio: 16.0 / 9.0), rect(378, 0, 2268, 4032))
        assertFrame(CameraCrop.rect(pixels: portrait, ratio: 1), rect(0, 504, 3024, 3024))
        assertFrame(CameraCrop.rect(pixels: .zero, ratio: 1), rect(0, 0, 0, 0))
    }

    /// The review: the photo whole above the bar, Retake leading, Use
    /// Photo trailing.
    func testTheReview() {
        let layout = CameraReviewLayout(size: phoneSize, safeArea: phoneSafe, photo: CGSize(width: 3024, height: 4032), retake: CGSize(width: 70, height: 22), use: CGSize(width: 90, height: 22))
        assertFrame(layout.bar, rect(0, 802, 430, 130))
        assertFrame(layout.photo, rect(0, 144, 430, 573))
        assertFrame(layout.retake, rect(16, 839, 70, 22))
        assertFrame(layout.use, rect(324, 839, 90, 22))

        let wide = CameraReviewLayout(size: phoneSize, safeArea: phoneSafe, photo: CGSize(width: 4032, height: 2268), retake: .zero, use: .zero)
        assertFrame(wide.photo, rect(0, 310, 430, 242))
    }
}
