import CoreGraphics
@testable import HappyLayout
import XCTest

/// Telegram's crop and drawing screens on an iPhone 12 (390 × 844, safe
/// 47 / 34): where the picture's room, the bars and the tools fall.
final class PhotoEditorLayoutTests: XCTestCase {
    private let size = CGSize(width: 390, height: 844)
    private let safe = LayoutInsets(top: 47, left: 0, bottom: 34, right: 0)

    func testTheCropsRoomLeavesTheBarAndPanelBelow() {
        let layout = PhotoCropScreenLayout(size: size, safeArea: safe)
        XCTAssertEqual(layout.area, CGRect(x: 9, y: 56, width: 372, height: 844 - 34 - 49 - 115 - 47 - 18))
        XCTAssertEqual(layout.cancel.minX, 26)
        XCTAssertEqual(layout.done.maxX, 390 - 26)
        XCTAssertEqual(layout.cancel.midY, 844 - 34 - 24.5)
        XCTAssertEqual(layout.group.width, 3 * 44 + 2 * 10)
        XCTAssertEqual(layout.group.midX, 195)
        XCTAssertEqual(layout.reset.y, 844 - 34 - 49 - 61 + 20 + 12)
    }

    func testAWindowFitsTheAreaAndTheWheelSitsUnderIt() {
        let layout = PhotoCropScreenLayout(size: size, safeArea: safe)
        let wide = layout.window(for: CGSize(width: 4000, height: 3000))
        XCTAssertEqual(wide.width, layout.area.width, accuracy: 0.001)
        XCTAssertEqual(wide.midY, layout.area.midY, accuracy: 0.001)
        XCTAssertEqual(layout.wheel(under: wide).minY, wide.maxY)
        // A tall one fills the area's height; the wheel stays over Reset.
        let tall = layout.window(for: CGSize(width: 1000, height: 4000))
        XCTAssertEqual(tall.height, layout.area.height, accuracy: 0.001)
        XCTAssertLessThanOrEqual(layout.wheel(under: tall).minY + 57, layout.reset.y - 12)
    }

    func testTheWheelTurnsAgainstTheFingerAndStopsAt45() {
        let turned = PhotoCropScreenLayout.angle(0, dragged: -100)
        XCTAssertEqual(turned * 180 / .pi, 100 / .pi / 1.15, accuracy: 0.0001)
        XCTAssertEqual(PhotoCropScreenLayout.angle(0, dragged: -10000), .pi / 4, accuracy: 0.0001)
        XCTAssertEqual(PhotoCropScreenLayout.angle(0, dragged: 10000), -.pi / 4, accuracy: 0.0001)
    }

    func testTheDrawingScreensControlsSitAsTelegramsDo() {
        let layout = PhotoDrawScreenLayout(size: size, safeArea: safe)
        XCTAssertEqual(layout.topY, 47 + 31)
        XCTAssertEqual(layout.close.midX, 48)
        XCTAssertEqual(layout.done.midX, 390 - 48)
        XCTAssertEqual(layout.tools.midY, 844 - 34 - 8 - 78 - 60)
        XCTAssertEqual(layout.toolCenters.count, 6)
        XCTAssertEqual(layout.toolCenters[1] - layout.toolCenters[0], 44)
        XCTAssertEqual((layout.toolCenters.first! + layout.toolCenters.last!) / 2, 195)
        XCTAssertEqual(layout.color.midX, 28)
        XCTAssertEqual(layout.swatches.count, 8)
        XCTAssertEqual(layout.swatches.first!.midX, 28)
        XCTAssertEqual(layout.swatches.last!.midX, 390 - 28)
        XCTAssertEqual(layout.wedge.size, CGSize(width: 30, height: 240))
    }

    func testTheWedgeIsBigAtTheTop() {
        XCTAssertEqual(PhotoDrawScreenLayout.wedgeValue(at: 12, height: 240), 1)
        XCTAssertEqual(PhotoDrawScreenLayout.wedgeValue(at: 228, height: 240), 0)
        XCTAssertEqual(PhotoDrawScreenLayout.wedgeValue(at: 120, height: 240), 0.5, accuracy: 0.001)
    }

    func testTheToolsStartAsTelegramsWithTheArrowChosen() {
        XCTAssertEqual(PhotoTools.order, [.pen, .arrow, .marker, .neon, .blur, .eraser])
        XCTAssertEqual(PhotoTools.initial, .arrow)
        XCTAssertEqual(PhotoTools.color(.arrow), PhotoTools.hex(0xFF8A00))
        XCTAssertEqual(PhotoTools.size(.marker), 0.75)
        XCTAssertEqual(PhotoTools.grid.count, PhotoTools.gridColumns * PhotoTools.gridRows)
        XCTAssertEqual(PhotoTools.spectrum(at: CGPoint(x: 0, y: 0.5)), RGBA(red: 1, green: 0, blue: 0))
        XCTAssertEqual(PhotoTools.spectrum(at: CGPoint(x: 0.3, y: 0)), RGBA(red: 1, green: 1, blue: 1))
        XCTAssertEqual(PhotoTools.spectrum(at: CGPoint(x: 0.3, y: 1)), RGBA(red: 0, green: 0, blue: 0))
    }
}
