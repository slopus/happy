import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import XCTest
@testable import HappyLayout

/// The call's bar takes the status bar's place as Telegram's does: as tall
/// as the status bar, never under 40, 12 more below a notch and 20 more
/// around the island, upright; the content under it starts at its foot.
final class CallBarLayoutTests: XCTestCase {
    private let title = CGSize(width: 40, height: 16)
    private let subtitle = CGSize(width: 30, height: 16)

    func testAnIPhone12UprightUnderItsNotch() {
        let layout = CallBarLayout(width: 390, safeArea: LayoutInsets(top: 47, bottom: 34), statusBar: 47,
                                   compactWidth: true, landscape: false, titleSize: title, subtitleSize: subtitle)
        XCTAssertEqual(layout.bar, CGRect(x: 0, y: 0, width: 390, height: 59))
        XCTAssertEqual(layout.waves, CGRect(x: 0, y: 0, width: 390, height: 59 + CallWaves.overhang))
        XCTAssertEqual(layout.row, CGRect(x: 0, y: 35, width: 390, height: 24))
        XCTAssertEqual(layout.muteGlyph, CGRect(x: 14, y: 38, width: 18, height: 18))
        XCTAssertEqual(layout.endGlyph, CGRect(x: 358, y: 38, width: 18, height: 18))
        XCTAssertEqual(layout.mute, CGRect(x: 1, y: 15, width: 44, height: 44))
        XCTAssertEqual(layout.end, CGRect(x: 345, y: 15, width: 44, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 157, y: 39, width: 40, height: 16))
        XCTAssertEqual(layout.subtitle, CGRect(x: 202, y: 39, width: 30, height: 16))
    }

    func testTheIslandAPlainStatusBarAndAPhoneOnItsSide() {
        XCTAssertEqual(CallBarLayout.height(safeArea: LayoutInsets(top: 62), statusBar: 62, compactWidth: true, landscape: false), 82)
        XCTAssertEqual(CallBarLayout.height(safeArea: LayoutInsets(top: 59), statusBar: 54, compactWidth: true, landscape: false), 79)
        XCTAssertEqual(CallBarLayout.height(safeArea: LayoutInsets(top: 20), statusBar: 20, compactWidth: true, landscape: false), 40)
        // Sideways the status bar is gone: Telegram's 22, and nothing added.
        XCTAssertEqual(CallBarLayout.height(safeArea: LayoutInsets(top: 0, left: 47), statusBar: 0, compactWidth: true, landscape: true), 22)
        // An iPad on its side keeps its status bar and the 40.
        XCTAssertEqual(CallBarLayout.height(safeArea: LayoutInsets(top: 24), statusBar: 24, compactWidth: false, landscape: true), 40)
    }

    func testTheEdgeIsReadFromTheSafeArea() {
        XCTAssertEqual(CallBarLayout.TopEdge.from(safeTop: 20), .plain)
        XCTAssertEqual(CallBarLayout.TopEdge.from(safeTop: 47), .notch)
        XCTAssertEqual(CallBarLayout.TopEdge.from(safeTop: 50), .notch)
        XCTAssertEqual(CallBarLayout.TopEdge.from(safeTop: 59), .island)
        XCTAssertEqual(CallBarLayout.TopEdge.from(safeTop: 62), .island)
    }

    func testTheContentStartsAtTheBarsFoot() {
        let bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
        XCTAssertEqual(CallBarLayout.content(in: bounds, barHeight: 59), CGRect(x: 0, y: 59, width: 390, height: 785))
        XCTAssertEqual(CallBarLayout.content(in: bounds, barHeight: 0), bounds)
    }

    func testButtonsKeepInsideTheSafeSidesAndLongWordsGiveWay() {
        let wide = CGSize(width: 900, height: 16)
        let layout = CallBarLayout(width: 874, safeArea: LayoutInsets(top: 0, left: 62, right: 62), statusBar: 0,
                                   compactWidth: true, landscape: true, titleSize: wide, subtitleSize: subtitle)
        XCTAssertEqual(layout.bar.height, 22)
        XCTAssertEqual(layout.muteGlyph.minX, 76)
        XCTAssertEqual(layout.endGlyph.maxX, 874 - 76)
        XCTAssertGreaterThanOrEqual(layout.title.minX, layout.mute.maxX)
        XCTAssertLessThanOrEqual(layout.subtitle.maxX, layout.end.minX)
        XCTAssertEqual(layout.subtitle.width, 30)
        XCTAssertEqual(layout.title.width + 5 + 30, layout.end.minX - layout.mute.maxX, accuracy: 0.001)
    }

    func testItSlidesFromBeyondItsOwnWaves() {
        XCTAssertEqual(CallBarMotion.duration, 0.3)
        XCTAssertEqual(CallBarMotion.hiddenOffset(barHeight: 59), -(59 + CallWaves.overhang))
    }

    func testTheVoiceGlyphIsThreeRoundBarsCentred() {
        let icon = VoiceIconLayout(size: 24)
        XCTAssertEqual(icon.bars.count, 3)
        XCTAssertEqual(icon.bars[0].minX, 5.55, accuracy: 0.001)
        XCTAssertEqual(icon.bars[1].minX, 10.8, accuracy: 0.001)
        XCTAssertEqual(icon.bars[2].minX, 16.05, accuracy: 0.001)
        for bar in icon.bars { XCTAssertEqual(bar.width, 2.4, accuracy: 0.001) }
        XCTAssertEqual(icon.bars[1].height, 17, accuracy: 0.001)
        for bar in icon.bars { XCTAssertEqual(bar.midY, 12, accuracy: 0.001) }
        // The tall bar is in the middle, the first the shortest.
        XCTAssertGreaterThan(icon.bars[1].height, icon.bars[2].height)
        XCTAssertGreaterThan(icon.bars[2].height, icon.bars[0].height)
        let toolbar = VoiceIconLayout(size: 22)
        XCTAssertEqual(toolbar.bars[1].midX, 11, accuracy: 0.001)
    }
}
