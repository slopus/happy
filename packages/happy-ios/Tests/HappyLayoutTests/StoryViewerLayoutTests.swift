import HappyLayout
import XCTest

final class StoryViewerLayoutTests: XCTestCase {
    /// An iPhone 17 Pro: the canvas fills the width under the status bar,
    /// the bar takes what is left below it.
    func testAPhone() {
        let layout = StoryViewerLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34))
        XCTAssertEqual(layout.canvas, CGRect(x: 0, y: 62, width: 402, height: 714))
        XCTAssertEqual(layout.strip, CGRect(x: 8, y: 70, width: 386, height: 2))
        XCTAssertEqual(layout.avatar, CGRect(x: 12, y: 80, width: 32, height: 32))
        XCTAssertEqual(layout.close, CGRect(x: 352, y: 64, width: 50, height: 64))
        XCTAssertEqual(layout.more, CGRect(x: 310, y: 64, width: 50, height: 64))
        XCTAssertEqual(layout.titleOrigin, CGPoint(x: 54, y: 79))
        XCTAssertEqual(layout.titleWidth, 256)
        XCTAssertEqual(layout.bar, CGRect(x: 0, y: 776, width: 402, height: 64))
        XCTAssertEqual(layout.heart, CGRect(x: 350, y: 780, width: 44, height: 44))
        XCTAssertEqual(layout.views, CGRect(x: 8, y: 780, width: 201, height: 44))
    }

    /// An iPad: held by the height, the canvas is centred across.
    func testAnIPad() {
        let layout = StoryViewerLayout(size: CGSize(width: 1024, height: 1366), safeArea: LayoutInsets(top: 24, bottom: 20))
        XCTAssertEqual(layout.canvas, CGRect(x: 154.8125, y: 24, width: 714, height: 1270))
        XCTAssertEqual(layout.canvas.midX, 512, accuracy: 0.5)
    }

    func testSegmentsShareTheStrip() {
        let strip = CGRect(x: 8, y: 70, width: 386, height: 2)
        XCTAssertEqual(StoryViewerLayout.segments(1, in: strip), [strip])
        let three = StoryViewerLayout.segments(3, in: strip)
        for (index, segment) in three.enumerated() { XCTAssertEqual(segment.minX, 8 + CGFloat(index) * (380.0 / 3 + 3), accuracy: 0.001) }
        XCTAssertEqual(three.last?.maxX ?? 0, strip.maxX, accuracy: 0.001)
        // Thirty frames: never thinner than 2.
        XCTAssertTrue(StoryViewerLayout.segments(200, in: strip).allSatisfy { $0.width >= 2 })
        XCTAssertEqual(StoryViewerLayout.segments(0, in: strip), [])
    }

    func testTapsByThirds() {
        let layout = StoryViewerLayout(size: CGSize(width: 402, height: 874), safeArea: LayoutInsets(top: 62, bottom: 34))
        XCTAssertEqual(layout.tap(at: 10), .back)
        XCTAssertEqual(layout.tap(at: 133), .back)
        XCTAssertEqual(layout.tap(at: 135), .forward)
        XCTAssertEqual(layout.tap(at: 400), .forward)
    }

    func testTheCubeTurnsAQuarter() {
        XCTAssertEqual(StoryCube.angle(1), .pi / 2)
        XCTAssertEqual(StoryCube.angle(-0.5), -.pi / 4)
        XCTAssertEqual(StoryCube.angle(3), .pi / 2)
        XCTAssertEqual(StoryCube.perspective, 500)
    }
}

final class StoryCanvasLayoutTests: XCTestCase {
    private let canvas = CGSize(width: 360, height: 640)

    func testFitHoldsNineBySixteen() {
        XCTAssertEqual(StoryCanvasLayout.fit(in: CGRect(x: 0, y: 10, width: 360, height: 1000)), CGRect(x: 0, y: 10, width: 360, height: 640))
        XCTAssertEqual(StoryCanvasLayout.fit(in: CGRect(x: 0, y: 0, width: 1000, height: 640)), CGRect(x: 320, y: 0, width: 360, height: 640))
        XCTAssertEqual(StoryCanvasLayout.fit(in: .zero), .zero)
    }

    /// A screenshot fills the width at scale 1, with bands above and below.
    func testMediaIsFittedWholeAndCentred() {
        let wide = StoryCanvasLayout.media(pixels: CGSize(width: 1920, height: 1080), x: 0.5, y: 0.5, scale: 1, canvas: canvas)
        XCTAssertEqual(wide, CGRect(x: 0, y: 218.75, width: 360, height: 202.5))
        let tall = StoryCanvasLayout.media(pixels: CGSize(width: 1080, height: 1920), x: 0.5, y: 0.5, scale: 1, canvas: canvas)
        XCTAssertEqual(tall, CGRect(x: 0, y: 0, width: 360, height: 640))
        let grown = StoryCanvasLayout.media(pixels: CGSize(width: 100, height: 100), x: 0.25, y: 0.5, scale: 2, canvas: canvas)
        XCTAssertEqual(grown, CGRect(x: -270, y: -40, width: 720, height: 720))
        // Not measured yet: as a 16:9 picture.
        XCTAssertEqual(StoryCanvasLayout.media(pixels: nil, x: 0.5, y: 0.5, scale: 1, canvas: canvas), wide)
    }

    func testSizesAreFractionsOfTheWidth() {
        XCTAssertEqual(StoryCanvasLayout.textFontSize(canvas: canvas), 22.5)
        XCTAssertEqual(StoryCanvasLayout.linkHeight(canvas: canvas), 30)
        XCTAssertEqual(StoryCanvasLayout.textWrap(0.8, canvas: canvas), 288)
        XCTAssertEqual(StoryCanvasLayout.textWrap(5, canvas: canvas), 360)
        XCTAssertEqual(StoryCanvasLayout.sticker(pixels: CGSize(width: 512, height: 256), scale: 0.5, canvas: canvas), CGSize(width: 180, height: 90))
        XCTAssertEqual(StoryCanvasLayout.sticker(pixels: CGSize(width: 256, height: 512), scale: 0.5, canvas: canvas), CGSize(width: 90, height: 180))
        XCTAssertEqual(StoryCanvasLayout.reaction(scale: 0.25, canvas: canvas), CGSize(width: 90, height: 90))
        XCTAssertEqual(StoryCanvasLayout.center(0.5, 0.25, canvas: canvas), CGPoint(x: 180, y: 160))
    }

    func testTheCaptionSitsAtTheFoot() {
        let caption = StoryCanvasLayout.caption(textHeight: 39.2, canvas: canvas)
        XCTAssertEqual(caption.text, CGRect(x: 16, y: 584, width: 328, height: 40))
        XCTAssertEqual(caption.fade, CGRect(x: 0, y: 520, width: 360, height: 120))
    }
}
