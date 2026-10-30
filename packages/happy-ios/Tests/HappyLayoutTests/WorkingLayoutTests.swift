import CoreGraphics
@testable import HappyLayout
import XCTest

/// The working line on a 390-wide phone, frame by frame.
final class WorkingLayoutTests: XCTestCase {
    func testTheLoaderSitsInItsColumnThenClockDotAndPhase() {
        let layout = WorkingLayout(width: 390, glyph: .loader, timer: 19.5, separator: 4.25, phase: 70.5)
        XCTAssertEqual(layout.glyph, CGRect(x: 19, y: 13, width: 8, height: 14))
        XCTAssertEqual(layout.timer, CGRect(x: 36, y: 8, width: 19.5, height: 24))
        XCTAssertEqual(layout.separator, CGRect(x: 61.5, y: 8, width: 4.25, height: 24))
        XCTAssertEqual(layout.phase, CGRect(x: 71.75, y: 8, width: 70.5, height: 24))
    }

    func testAMarkFillsTheColumnAndALongPhaseStopsAtTheSide() {
        let layout = WorkingLayout(width: 390, glyph: .mark, timer: nil, separator: nil, phase: 900)
        XCTAssertEqual(layout.glyph, CGRect(x: 16, y: 13, width: 14, height: 14))
        XCTAssertNil(layout.timer)
        XCTAssertNil(layout.separator)
        XCTAssertEqual(layout.phase, CGRect(x: 36, y: 8, width: 338, height: 24))
    }

    func testTheWaitRingKeepsItsStrokeInsideTheColumn() {
        XCTAssertEqual(WorkingLayout.ringRadius(CGSize(width: 14, height: 14)), 6)
        XCTAssertEqual(WorkingLayout.ringRadius(CGSize(width: 1, height: 14)), 0)
    }
}
