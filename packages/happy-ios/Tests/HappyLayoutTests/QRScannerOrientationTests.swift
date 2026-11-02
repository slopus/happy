import CoreGraphics
import HappyLayout
import XCTest

/// The viewfinder as the camera's rect of interest, in every way the
/// picture can stand: the camera reads only there, so an area off the
/// viewfinder reads codes nobody is pointing at and none that they are.
///
/// Each case is checked twice: against fractions worked out by hand, and
/// by carrying the area's corners forward from the sensor to the screen
/// (the opposite direction to the function's) and finding the viewfinder.
final class QRScannerOrientationTests: XCTestCase {
    /// 1080p, as `.high` delivers it: landscape, as the sensor sees it.
    private let video = CGSize(width: 1920, height: 1080)
    private let portrait: CGFloat = 90
    private let landscapeRight: CGFloat = 0
    private let landscapeLeft: CGFloat = 180
    private let upsideDown: CGFloat = 270

    private func assertRect(_ actual: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        for (a, e) in [(actual.minX, expected.minX), (actual.minY, expected.minY), (actual.width, expected.width), (actual.height, expected.height)] {
            XCTAssertEqual(a, e, accuracy: 1e-9, "\(actual) is not \(expected)", file: file, line: line)
        }
    }

    /// Where a point of the sensor's unit space shows on the preview: turned
    /// clockwise by `rotation`, then filled aspect-fill and centred.
    private func onScreen(_ point: CGPoint, preview: CGSize, rotation: CGFloat) -> CGPoint {
        let (u, v) = (point.x, point.y)
        let turned: CGPoint = switch Int(rotation) {
        case 90: CGPoint(x: 1 - v, y: u)
        case 180: CGPoint(x: 1 - u, y: 1 - v)
        case 270: CGPoint(x: v, y: 1 - u)
        default: CGPoint(x: u, y: v)
        }
        let upright = Int(rotation) % 180 == 0 ? video : CGSize(width: video.height, height: video.width)
        let scale = max(preview.width / upright.width, preview.height / upright.height)
        let shown = CGSize(width: upright.width * scale, height: upright.height * scale)
        return CGPoint(
            x: (preview.width - shown.width) / 2 + turned.x * shown.width,
            y: (preview.height - shown.height) / 2 + turned.y * shown.height
        )
    }

    /// The area's corners, carried to the screen, are the viewfinder's.
    private func assertLandsOnViewfinder(_ viewfinder: CGRect, preview: CGSize, rotation: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        let area = QRScannerLayout.scanArea(viewfinder: viewfinder, preview: preview, video: video, rotation: rotation)
        let corners = [CGPoint(x: area.minX, y: area.minY), CGPoint(x: area.maxX, y: area.minY), CGPoint(x: area.minX, y: area.maxY), CGPoint(x: area.maxX, y: area.maxY)]
            .map { onScreen($0, preview: preview, rotation: rotation) }
        let xs = corners.map(\.x), ys = corners.map(\.y)
        let back = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
        for (a, e) in [(back.minX, viewfinder.minX), (back.minY, viewfinder.minY), (back.maxX, viewfinder.maxX), (back.maxY, viewfinder.maxY)] {
            XCTAssertEqual(a, e, accuracy: 1e-6, "rotation \(rotation): \(back) is not \(viewfinder)", file: file, line: line)
        }
    }

    /// The viewfinder that `QRScannerLayout` puts on a screen.
    private func viewfinder(_ size: CGSize, _ insets: LayoutInsets) -> CGRect {
        let layout = QRScannerLayout(.init(size: size, safeArea: insets, mode: .scanning(hint: .fixed(width: 100, height: 22))))
        return layout.viewfinder!
    }

    // MARK: A preview of the picture's own shape, an off-centre viewfinder

    // A viewfinder near the top left of the screen, so a mix-up of the
    // axes or their directions shows.
    private let offCentre = CGRect(x: 60, y: 120, width: 180, height: 240)

    func testPortrait() {
        let preview = CGSize(width: 540, height: 960)
        // The sensor's x runs down the screen and its y from right to left:
        // the top left of the screen is the sensor's top right.
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: portrait), CGRect(x: 1.0 / 8, y: 5.0 / 9, width: 1.0 / 4, height: 1.0 / 3))
        assertLandsOnViewfinder(offCentre, preview: preview, rotation: portrait)
    }

    func testLandscapeRight() {
        let preview = CGSize(width: 960, height: 540)
        // The sensor's own way up.
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: landscapeRight), CGRect(x: 1.0 / 16, y: 2.0 / 9, width: 3.0 / 16, height: 4.0 / 9))
        assertLandsOnViewfinder(offCentre, preview: preview, rotation: landscapeRight)
    }

    func testLandscapeLeft() {
        let preview = CGSize(width: 960, height: 540)
        // Turned half round: the top left is the sensor's bottom right.
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: landscapeLeft), CGRect(x: 3.0 / 4, y: 1.0 / 3, width: 3.0 / 16, height: 4.0 / 9))
        assertLandsOnViewfinder(offCentre, preview: preview, rotation: landscapeLeft)
    }

    func testUpsideDown() {
        let preview = CGSize(width: 540, height: 960)
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: upsideDown), CGRect(x: 5.0 / 8, y: 1.0 / 9, width: 1.0 / 4, height: 1.0 / 3))
        assertLandsOnViewfinder(offCentre, preview: preview, rotation: upsideDown)
    }

    /// The coordinator's angles are whole quarter turns; one off by a
    /// rounding error is still that turn, and a full turn is none.
    func testAnglesRoundToTheQuarterTurn() {
        let preview = CGSize(width: 540, height: 960)
        let exact = QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: 90)
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: 90.000001), exact)
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: 450), exact)
        assertRect(QRScannerLayout.scanArea(viewfinder: offCentre, preview: preview, video: video, rotation: -270), exact)
    }

    // MARK: The devices Steve uses, with the viewfinder the layout draws

    /// iPhone 15 Pro Max in portrait: the picture is wider than the screen,
    /// so its sides are cut off and the viewfinder spans more of its width.
    func testIPhonePortrait() {
        let size = CGSize(width: 430, height: 932)
        let finder = viewfinder(size, LayoutInsets(top: 59, left: 0, bottom: 34, right: 0))
        XCTAssertEqual(finder, CGRect(x: 75, y: 338.5, width: 280, height: 280))
        // 1080 × 1920 upright, filled to 524.25 × 932: 47.125 cut off each side.
        let shownWidth = 1080 * 932.0 / 1920
        assertRect(
            QRScannerLayout.scanArea(viewfinder: finder, preview: size, video: video, rotation: portrait),
            CGRect(x: 338.5 / 932, y: (47.125 + 75) / shownWidth, width: 280 / 932, height: 280 / shownWidth)
        )
        assertLandsOnViewfinder(finder, preview: size, rotation: portrait)
    }

    func testIPhoneLandscapeBothWays() {
        let size = CGSize(width: 932, height: 430)
        let finder = viewfinder(size, LayoutInsets(top: 0, left: 59, bottom: 21, right: 59))
        for rotation in [landscapeLeft, landscapeRight] {
            assertLandsOnViewfinder(finder, preview: size, rotation: rotation)
        }
        // Centred on the screen but not on its safe area, so the two turns
        // put it on opposite sides of the sensor.
        let right = QRScannerLayout.scanArea(viewfinder: finder, preview: size, video: video, rotation: landscapeRight)
        let left = QRScannerLayout.scanArea(viewfinder: finder, preview: size, video: video, rotation: landscapeLeft)
        XCTAssertEqual(right.width, left.width, accuracy: 1e-9)
        XCTAssertEqual(right.minY, 1 - left.maxY, accuracy: 1e-9)
        XCTAssertNotEqual(right.minY, left.minY, accuracy: 1e-3)
    }

    /// iPad Pro 11": full screen either way, a third of a landscape screen
    /// in a split (a tall window, while the coordinator turns the picture
    /// by the interface, 0), and a Stage Manager window.
    func testIPadInEveryWindow() {
        let cases: [(CGSize, LayoutInsets, [CGFloat])] = [
            (CGSize(width: 834, height: 1194), LayoutInsets(top: 24, left: 0, bottom: 20, right: 0), [portrait, upsideDown]),
            (CGSize(width: 1194, height: 834), LayoutInsets(top: 24, left: 0, bottom: 20, right: 0), [landscapeLeft, landscapeRight]),
            (CGSize(width: 375, height: 834), LayoutInsets(top: 24, left: 0, bottom: 20, right: 0), [landscapeLeft, landscapeRight]),
            (CGSize(width: 700, height: 500), LayoutInsets(top: 32, left: 0, bottom: 0, right: 0), [portrait, landscapeLeft, landscapeRight]),
        ]
        for (size, insets, rotations) in cases {
            let finder = viewfinder(size, insets)
            for rotation in rotations {
                let area = QRScannerLayout.scanArea(viewfinder: finder, preview: size, video: video, rotation: rotation)
                XCTAssertTrue(CGRect(x: 0, y: 0, width: 1, height: 1).contains(area), "\(size) at \(rotation): \(area)")
                assertLandsOnViewfinder(finder, preview: size, rotation: rotation)
            }
        }
    }

    /// iPad Pro 11" landscape, worked out by hand: the picture is wider than
    /// the screen's 1194 × 834 (1482.67 × 834), and the 280 viewfinder sits
    /// 2 below the middle (the status bar's 24 against the indicator's 20).
    func testIPadLandscapeRight() {
        let size = CGSize(width: 1194, height: 834)
        let finder = viewfinder(size, LayoutInsets(top: 24, left: 0, bottom: 20, right: 0))
        XCTAssertEqual(finder, CGRect(x: 457, y: 279, width: 280, height: 280))
        let shownWidth = 1920 * 834.0 / 1080
        let left = (shownWidth - 1194) / 2
        assertRect(
            QRScannerLayout.scanArea(viewfinder: finder, preview: size, video: video, rotation: landscapeRight),
            CGRect(x: (left + 457) / shownWidth, y: 279.0 / 834, width: 280 / shownWidth, height: 280.0 / 834)
        )
    }

    func testNoPictureYetReadsTheWholeFrame() {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        XCTAssertEqual(QRScannerLayout.scanArea(viewfinder: offCentre, preview: .zero, video: video, rotation: portrait), whole)
        XCTAssertEqual(QRScannerLayout.scanArea(viewfinder: offCentre, preview: CGSize(width: 540, height: 960), video: .zero, rotation: portrait), whole)
        XCTAssertEqual(QRScannerLayout.scanArea(viewfinder: offCentre, preview: CGSize(width: 540, height: 960), video: video, rotation: .nan), whole)
    }

    // MARK: Zoom for a camera that can't focus close

    /// The iPhone 15 Pro's wide camera: 20 cm, 69° across, the viewfinder a
    /// third of the picture. A 30 mm code fills it at 7.3 cm, so 2.75×
    /// brings that to 20 cm.
    func testAFarFocusingCameraZoomsIn() {
        let distance = 30 / (2 * 0.3 * tan(34.5 * Double.pi / 180))
        XCTAssertEqual(Double(QRScannerLayout.focusZoom(minimumFocusDistance: 200, fieldOfView: 69, fill: 0.3)), 200 / distance, accuracy: 1e-3)
        XCTAssertEqual(Double(QRScannerLayout.focusZoom(minimumFocusDistance: 100, fieldOfView: 69, fill: 0.3)), 100 / distance, accuracy: 1e-3)
    }

    func testACameraThatFocusesCloseStaysAtOne() {
        XCTAssertEqual(QRScannerLayout.focusZoom(minimumFocusDistance: 50, fieldOfView: 69, fill: 0.3), 1)
        XCTAssertEqual(QRScannerLayout.focusZoom(minimumFocusDistance: -1, fieldOfView: 69, fill: 0.3), 1)
        XCTAssertEqual(QRScannerLayout.focusZoom(minimumFocusDistance: 200, fieldOfView: 0, fill: 0.3), 1)
        XCTAssertEqual(QRScannerLayout.focusZoom(minimumFocusDistance: 200, fieldOfView: 69, fill: 0), 1)
    }

    func testZoomStopsAtThree() {
        XCTAssertEqual(QRScannerLayout.focusZoom(minimumFocusDistance: 400, fieldOfView: 69, fill: 0.3), QRScannerLayout.Metrics.maxFocusZoom)
    }
}
