import HappyLayout
import XCTest

final class StoryEditorLayoutTests: XCTestCase {
    /// An iPhone 16, as Telegram's story editor: the canvas 5 under the
    /// status bar, the caption over its foot, back, tools and Post 8 under it.
    func testAPhone() {
        let layout = StoryEditorLayout(bounds: CGRect(x: 0, y: 0, width: 393, height: 852), statusBar: 54, homeIndicator: 34, postContent: 60)
        XCTAssertEqual(layout.canvas, CGRect(x: 0, y: 59, width: 393, height: 698))
        XCTAssertEqual(layout.close, CGRect(x: 16, y: 765, width: 44, height: 44))
        XCTAssertEqual(layout.post, CGRect(x: 292, y: 765, width: 85, height: 44))
        XCTAssertEqual(layout.tools, CGRect(x: 127, y: 765, width: 98, height: 44))
        XCTAssertEqual(layout.toolButtons, [CGRect(x: 0, y: 0, width: 44, height: 44), CGRect(x: 54, y: 0, width: 44, height: 44)])
        XCTAssertEqual(layout.captionPanel, CGRect(x: 0, y: 694, width: 393, height: 60))
        XCTAssertEqual(layout.caption, CGRect(x: 9, y: 708, width: 375, height: 40))
        XCTAssertEqual(layout.framesButton, CGRect(x: 348, y: 661, width: 33, height: 33))
        XCTAssertEqual(layout.bin.width, 393.0 * 180 / 1080, accuracy: 1e-9)
        XCTAssertEqual(layout.bin.midX, 196.5, accuracy: 1e-9)
        XCTAssertEqual(layout.bin.maxY, 757 - 393.0 * 20 / 1080, accuracy: 1e-9)
        XCTAssertEqual(layout.binCircle.width, 393.0 * 160 / 1080, accuracy: 1e-9)
    }

    /// A home-button phone: the canvas from the top, the bar lifted 62 over it.
    func testAShortPhone() {
        let layout = StoryEditorLayout(bounds: CGRect(x: 0, y: 0, width: 375, height: 667), statusBar: 20, homeIndicator: 0, postContent: 60)
        XCTAssertEqual(layout.canvas, CGRect(x: 0, y: 0, width: 375, height: 666))
        XCTAssertEqual(layout.close, CGRect(x: 9, y: 612, width: 44, height: 44))
        XCTAssertEqual(layout.captionPanel.minY, 541)
    }

    /// An iPad: the canvas held by the height, centred, 30 from the sides.
    func testATablet() {
        let layout = StoryEditorLayout(bounds: CGRect(x: 0, y: 0, width: 1024, height: 1366), statusBar: 24, homeIndicator: 20, postContent: 60, tablet: true)
        XCTAssertEqual(layout.canvas, CGRect(x: 157, y: 29, width: 709, height: 1262))
        XCTAssertEqual(layout.close.minX, 30)
        XCTAssertEqual(layout.close.minY, 1299)
    }

    /// The frames panel: cards 95 by 112, 4 apart, the add card last, its
    /// right edge on the frames button's, 10 over it.
    func testTheFramesPanel() {
        let layout = StoryEditorLayout(bounds: CGRect(x: 0, y: 0, width: 393, height: 852), statusBar: 54, homeIndicator: 34, postContent: 60)
        let panel = layout.panel(width: 393, frames: 2, canAdd: true)
        XCTAssertEqual(panel.frame, CGRect(x: 80, y: 531, width: 301, height: 120))
        XCTAssertEqual(panel.items, [CGRect(x: 4, y: 4, width: 95, height: 112), CGRect(x: 103, y: 4, width: 95, height: 112)])
        XCTAssertEqual(panel.add, CGRect(x: 202, y: 4, width: 95, height: 112))
        let full = layout.panel(width: 393, frames: 10, canAdd: false)
        XCTAssertNil(full.add)
        XCTAssertEqual(full.frame, CGRect(x: 12, y: 531, width: 369, height: 120))
        XCTAssertEqual(full.content, CGSize(width: 994, height: 120))
    }
}

final class StoryStickerPillsLayoutTests: XCTestCase {
    /// LINK and the reaction bubble: one row, 30 apart, centred.
    func testTwoItemsCentre() {
        let link = StoryStickerPillsLayout.pill(title: 40)
        XCTAssertEqual(link, CGSize(width: 78, height: 34))
        let layout = StoryStickerPillsLayout(width: 393, sizes: [link, CGSize(width: 52, height: 52)])
        XCTAssertEqual(layout.items, [CGRect(x: 116, y: 27, width: 78, height: 34), CGRect(x: 224, y: 18, width: 52, height: 52)])
        XCTAssertEqual(layout.height, 76)
    }

    /// Too many for a row: the rest wrap 12 under it.
    func testTheyWrap() {
        let layout = StoryStickerPillsLayout(width: 210, sizes: [CGSize(width: 80, height: 34), CGSize(width: 80, height: 34), CGSize(width: 80, height: 34)])
        XCTAssertEqual(layout.items[0], CGRect(x: 18, y: 18, width: 80, height: 34))
        XCTAssertEqual(layout.items[1], CGRect(x: 112, y: 18, width: 80, height: 34))
        XCTAssertEqual(layout.items[2], CGRect(x: 65, y: 64, width: 80, height: 34))
    }
}

final class StickerPickerLayoutTests: XCTestCase {
    /// A phone's picker: five sticker columns of 72 under a header with
    /// a ✕, then eight emoji columns of 43 without one.
    func testSections() {
        let layout = StickerPickerLayout(width: 393, sections: [
            .init(kind: .stickers, count: 7),
            .init(kind: .emoji, count: 3, header: false),
        ], clears: [0])
        XCTAssertEqual(layout.sections[0].header, CGRect(x: 8, y: 0, width: 377, height: 32))
        XCTAssertEqual(layout.sections[0].clear, CGRect(x: 353, y: 0, width: 32, height: 32))
        XCTAssertEqual(layout.sections[0].columns, 5)
        XCTAssertEqual(layout.sections[0].cells.map(\.minX), [8, 84, 160, 236, 312, 8, 84])
        XCTAssertEqual(layout.sections[0].cells[0], CGRect(x: 8, y: 32, width: 72, height: 72))
        XCTAssertEqual(layout.sections[0].cells[5], CGRect(x: 8, y: 108, width: 72, height: 72))
        XCTAssertNil(layout.sections[1].header)
        XCTAssertEqual(layout.sections[1].columns, 8)
        XCTAssertEqual(layout.sections[1].cells, [
            CGRect(x: 8, y: 188, width: 43, height: 43), CGRect(x: 55, y: 188, width: 43, height: 43), CGRect(x: 102, y: 188, width: 43, height: 43),
        ])
        XCTAssertEqual(layout.height, 188 + 43 + 8 + 72)
    }

    /// Wider grids take more columns, as the API's formula says.
    func testColumnsGrowWithTheWidth() {
        XCTAssertEqual(StickerPickerLayout.columns(.stickers, width: 300), 5)
        XCTAssertEqual(StickerPickerLayout.columns(.stickers, width: 736), 10)
        XCTAssertEqual(StickerPickerLayout.columns(.emoji, width: 300), 8)
        XCTAssertEqual(StickerPickerLayout.columns(.emoji, width: 700), 16)
    }
}

final class StorySnapperTests: XCTestCase {
    private let canvas = CGSize(width: 400, height: 800)

    /// Within 2% of the width it snaps to the centre line, and holds there
    /// until pulled twice as far.
    func testTheCentreLineHoldsUntilPulledTwiceAsFar() {
        var snapper = StorySnapper()
        var result = snapper.snap(center: CGPoint(x: 205, y: 300), half: CGSize(width: 30, height: 30), rotation: 0.3, canvas: canvas, edges: false)
        XCTAssertEqual(result.center, CGPoint(x: 200, y: 300))
        XCTAssertEqual(result.guides, [.centerX])
        XCTAssertTrue(result.snapped)
        result = snapper.snap(center: CGPoint(x: 214, y: 300), half: CGSize(width: 30, height: 30), rotation: 0.3, canvas: canvas, edges: false)
        XCTAssertEqual(result.center.x, 200)
        XCTAssertFalse(result.snapped)
        result = snapper.snap(center: CGPoint(x: 217, y: 300), half: CGSize(width: 30, height: 30), rotation: 0.3, canvas: canvas, edges: false)
        XCTAssertEqual(result.center.x, 217)
        XCTAssertEqual(result.guides, [])
    }

    /// A sticker's edge snaps 1/20 of the width in from the canvas's edge.
    func testAStickersEdgesSnapInsideTheCanvas() {
        var snapper = StorySnapper()
        let result = snapper.snap(center: CGPoint(x: 55, y: 400), half: CGSize(width: 30, height: 30), rotation: 0.3, canvas: canvas, edges: true)
        XCTAssertEqual(result.center, CGPoint(x: 50, y: 400))
        XCTAssertEqual(result.guides, [.left, .centerY])
        XCTAssertFalse(result.turned)
        var text = StorySnapper()
        XCTAssertEqual(text.snap(center: CGPoint(x: 55, y: 390), half: CGSize(width: 30, height: 30), rotation: 0.3, canvas: canvas, edges: false).center, CGPoint(x: 55, y: 390))
    }

    /// Landing on an overlay already on a line holds it without a tick.
    func testLandingOnALineDoesntTick() {
        var snapper = StorySnapper()
        snapper.begin(center: CGPoint(x: 200, y: 400), half: CGSize(width: 30, height: 30), rotation: 0, canvas: canvas, edges: false)
        let result = snapper.snap(center: CGPoint(x: 203, y: 404), half: CGSize(width: 30, height: 30), rotation: 0.01, canvas: canvas, edges: false)
        XCTAssertEqual(result.center, CGPoint(x: 200, y: 400))
        XCTAssertEqual(result.rotation, 0)
        XCTAssertTrue(result.turned)
        XCTAssertFalse(result.snapped)
    }

    /// The angle snaps to multiples of 45° within 2°, and holds to 4°.
    func testTheAngleSnapsToFortyFiveDegrees() {
        var snapper = StorySnapper()
        let far = CGPoint(x: 120, y: 120)
        let half = CGSize(width: 10, height: 10)
        XCTAssertEqual(snapper.snap(center: far, half: half, rotation: 0.03, canvas: canvas, edges: false).rotation, 0)
        XCTAssertEqual(snapper.snap(center: far, half: half, rotation: 0.06, canvas: canvas, edges: false).rotation, 0)
        XCTAssertEqual(snapper.snap(center: far, half: half, rotation: 0.08, canvas: canvas, edges: false).rotation, 0.08)
        let turned = snapper.snap(center: far, half: half, rotation: 0.80, canvas: canvas, edges: false)
        XCTAssertEqual(turned.rotation, .pi / 4, accuracy: 1e-9)
        XCTAssertTrue(turned.snapped)
    }

    /// A box turned a quarter reaches as far as its height across.
    func testATurnedBoxsReach() {
        let half = StorySnapper.half(CGSize(width: 100, height: 40), rotation: .pi / 2)
        XCTAssertEqual(half.width, 20, accuracy: 1e-9)
        XCTAssertEqual(half.height, 50, accuracy: 1e-9)
    }
}

final class StoryTextEntryLayoutTests: XCTestCase {
    /// Over a phone's keyboard: Cancel and Done 20 under the safe area's
    /// top, the slider centred between it and the keyboard.
    func testOverTheKeyboard() {
        let layout = StoryTextEntryLayout(bounds: CGRect(x: 0, y: 0, width: 393, height: 852), statusBar: 54, safeTop: 59, safeBottom: 34, keyboard: 380, cancelWidth: 54.3, doneWidth: 41.2)
        XCTAssertEqual(layout.cancel, CGRect(x: 13, y: 79, width: 55, height: 30))
        XCTAssertEqual(layout.done, CGRect(x: 338, y: 79, width: 42, height: 30))
        XCTAssertEqual(layout.slider, CGRect(x: 0, y: 145, width: 30, height: 240))
    }

    /// With the keyboard down the slider centres over the safe area's bottom.
    func testWithoutTheKeyboard() {
        let layout = StoryTextEntryLayout(bounds: CGRect(x: 0, y: 0, width: 393, height: 852), statusBar: 54, safeTop: 59, safeBottom: 34, keyboard: 0, cancelWidth: 54.3, doneWidth: 41.2)
        XCTAssertEqual(layout.slider, CGRect(x: 0, y: 318, width: 30, height: 240))
    }

    /// The knob rides 12 past the track's ends; a finger maps back to the value.
    func testTheKnob() {
        XCTAssertEqual(StoryTextEntryLayout.knob(value: 1, height: 240), 14)
        XCTAssertEqual(StoryTextEntryLayout.knob(value: 0, height: 240), 226)
        XCTAssertEqual(StoryTextEntryLayout.value(y: 12, height: 240), 1)
        XCTAssertEqual(StoryTextEntryLayout.value(y: 120, height: 240), 0.5)
        XCTAssertEqual(StoryTextEntryLayout.value(y: 300, height: 240), 0)
    }

    /// The keyboard's bar: swatch, fill and alignment at the left, the font at the right.
    func testTheBar() {
        let bar = StoryTextEntryLayout.bar(width: 393, fontTitle: 89.6)
        XCTAssertEqual(bar.swatch, CGRect(x: 2, y: 0, width: 44, height: 44))
        XCTAssertEqual(bar.style, CGRect(x: 48, y: 0, width: 44, height: 44))
        XCTAssertEqual(bar.align, CGRect(x: 92, y: 0, width: 44, height: 44))
        XCTAssertEqual(bar.font, CGRect(x: 247, y: 7, width: 130, height: 30))
    }

    /// The slider runs the font from 2.5% to 25% of the canvas's height.
    func testTheSliderMapsTheSize() {
        XCTAssertEqual(StoryTextEntryLayout.scale(slider: 0), 0.025 * 1920 / 67.5, accuracy: 1e-9)
        XCTAssertEqual(StoryTextEntryLayout.scale(slider: 1), 0.25 * 1920 / 67.5, accuracy: 1e-9)
        XCTAssertEqual(StoryTextEntryLayout.slider(scale: StoryTextEntryLayout.scale(slider: 0.3)), 0.3, accuracy: 1e-9)
        XCTAssertEqual(StoryTextEntryLayout.slider(scale: 0.1), 0)
    }
}
