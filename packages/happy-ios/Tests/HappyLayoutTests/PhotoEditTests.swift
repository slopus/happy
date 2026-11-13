import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The editor's crop: a window onto the picture that never leaves it.
final class PhotoEditTests: XCTestCase {
    private let canvas = CGSize(width: 4000, height: 3000)

    func testTheWholePictureIsNoEdit() {
        let edit = PhotoEdit(canvas: canvas)
        XCTAssertTrue(edit.isEmpty)
        XCTAssertEqual(edit.crop.corners, [CGPoint(x: 0, y: 0), CGPoint(x: 4000, y: 0), CGPoint(x: 4000, y: 3000), CGPoint(x: 0, y: 3000)])
        var drawn = edit
        drawn.strokes = [PhotoStroke(tool: .pen, color: .white, width: 10, points: [.zero])]
        XCTAssertFalse(drawn.isEmpty)
    }

    func testAQuarterTurnSwapsTheSidesAndKeepsTheWindow() {
        let turned = PhotoCrop.whole(canvas).rotatedLeft()
        XCTAssertEqual(turned.size, CGSize(width: 3000, height: 4000))
        XCTAssertTrue(turned.fits(canvas))
        // The picture's top right comes out at the top left.
        let topRight = CGPoint(x: 4000, y: 0).applying(turned.transform)
        XCTAssertEqual(topRight.x, 0, accuracy: 0.001)
        XCTAssertEqual(topRight.y, 0, accuracy: 0.001)
        XCTAssertEqual(turned.rotatedLeft().rotatedLeft().rotatedLeft().turns, 0)
    }

    func testMirroringFlipsWhatComesOut() {
        var crop = PhotoCrop.whole(canvas)
        crop.mirrored = true
        let topLeft = CGPoint(x: 0, y: 0).applying(crop.transform)
        XCTAssertEqual(topLeft.x, 4000, accuracy: 0.001)
        XCTAssertEqual(topLeft.y, 0, accuracy: 0.001)
        XCTAssertTrue(crop.fits(canvas))
    }

    func testStraighteningZoomsInSoTheWindowStaysOnThePicture() {
        let crop = PhotoCrop.whole(canvas).straightened(.pi / 12, in: canvas)
        XCTAssertTrue(crop.fits(canvas))
        XCTAssertLessThan(crop.size.width, canvas.width)
        XCTAssertEqual(crop.size.width / crop.size.height, 4 / 3, accuracy: 0.0001, "the shape stays")
        for corner in crop.corners {
            XCTAssertGreaterThanOrEqual(corner.x, -0.5)
            XCTAssertLessThanOrEqual(corner.x, 4000.5)
            XCTAssertGreaterThanOrEqual(corner.y, -0.5)
            XCTAssertLessThanOrEqual(corner.y, 3000.5)
        }
        XCTAssertEqual(PhotoCrop.whole(canvas).straightened(2, in: canvas).angle, PhotoCrop.maxAngle, "the wheel stops at 45°")
    }

    func testPanningStopsAtThePicturesEdge() {
        let half = PhotoCrop.whole(canvas).zoomed(by: 2, minimum: 64, in: canvas)
        XCTAssertEqual(half.size, CGSize(width: 2000, height: 1500))
        // Dragging the picture right moves the window left, to the edge.
        let moved = half.panned(by: CGPoint(x: 10000, y: 0), scale: 1, in: canvas)
        XCTAssertEqual(moved.center.x, 1000, accuracy: 0.001)
        XCTAssertEqual(moved.center.y, 1500, accuracy: 0.001)
    }

    func testZoomStopsAtTheWholePictureAndTheSmallestWindow() {
        let whole = PhotoCrop.whole(canvas)
        XCTAssertEqual(whole.zoomed(by: 0.5, minimum: 64, in: canvas).size, canvas)
        let close = whole.zoomed(by: 1000, minimum: 300, in: canvas)
        XCTAssertEqual(min(close.size.width, close.size.height), 300, accuracy: 0.001)
    }

    func testDraggingACornerPastThePictureStopsAtItsEdge() {
        let half = PhotoCrop.whole(canvas).zoomed(by: 2, minimum: 64, in: canvas)
        let frame = CGRect(x: 0, y: 0, width: 200, height: 150)
        // The right side dragged far out, 0.1 points to a pixel.
        let wider = half.resized(from: frame, to: CGRect(x: 0, y: 0, width: 2000, height: 150), scale: 0.1, minimum: 64, in: canvas)
        XCTAssertTrue(wider.fits(canvas))
        XCTAssertEqual(wider.center.x - wider.size.width / 2, 1000, accuracy: 1, "the left side stays")
        XCTAssertEqual(wider.center.x + wider.size.width / 2, 4000, accuracy: 1, "the right side stops at the picture's")
        XCTAssertEqual(wider.size.height, 1500, accuracy: 0.001)
    }

    func testAnAspectTakesTheLargestWindowOfItsShape() {
        let square = PhotoCrop.whole(canvas).with(aspect: .square, in: canvas)
        XCTAssertEqual(square.size.width, 3000, accuracy: 0.01)
        XCTAssertEqual(square.size.height, 3000, accuracy: 0.01)
        XCTAssertTrue(square.fits(canvas))
        XCTAssertEqual(PhotoAspects.oriented(PhotoAspect(16, 9), like: CGSize(width: 3, height: 4)), PhotoAspect(9, 16))
        XCTAssertEqual(PhotoCrop.whole(canvas).with(aspect: .square, in: canvas).rotatedLeft().aspect, .square)
    }
}
