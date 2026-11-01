import XCTest
@testable import HappyLayout

final class SidebarLineChangesLayoutTests: XCTestCase {
    func testMeasuredStatusInkSharesTheSymmetricEdgeAndSixPointGap() {
        let ink = CGRect(x: 5, y: 4, width: 17, height: 17)
        for depth in 0...2 {
            let row = SidebarLayout.Row(kind: .row, depth: depth, hasTrailing: true, lineChangesWidth: 80, trailingInk: ink)
            let frame = SidebarLayout.layout([row], width: 390, top: 0, bottom: 0, style: .grouped).frames[0]
            XCTAssertEqual(frame.trailing!.minX + ink.maxX, frame.box.maxX - 16)
            XCTAssertEqual(frame.trailing!.minX + ink.minX - frame.lineChanges!.maxX, 6)
            XCTAssertEqual(frame.trailing!.minY + ink.midY, frame.box.midY)
        }
    }

    func testCountsReserveATrailingLaneWithoutChangingHeight() {
        for style in [SidebarLayout.Style.plain, .grouped] {
            for width: CGFloat in [320, 390, 768] {
                for depth in 0...2 {
                    for active in [false, true] {
                        let row = SidebarLayout.Row(kind: .row, depth: depth, hasMark: depth == 0, hasWorkingSignal: active)
                        var counted = row
                        counted.lineChangesWidth = 120
                        let original = SidebarLayout.layout([row], width: width, top: 0, bottom: 0, style: style).frames[0]
                        let frame = SidebarLayout.layout([counted], width: width, top: 0, bottom: 0, style: style).frames[0]
                        XCTAssertEqual(frame.box, original.box)
                        var working = row
                        working.hasWorkingSignal = true
                        let workingFrame = SidebarLayout.layout([working], width: width, top: 0, bottom: 0, style: style).frames[0]
                        XCTAssertEqual(frame.lineChanges?.maxX, active ? original.label.maxX : workingFrame.corner!.maxX - 1)
                        XCTAssertEqual(frame.lineChanges?.width, 120)
                        XCTAssertEqual(frame.label.maxX + 8, frame.lineChanges?.minX)
                        XCTAssertEqual(frame.corner, original.corner)
                        let inset = style == .grouped ? GroupedSidebarMetrics.markInset : Metrics.endInset - Metrics.mark / 2
                        XCTAssertEqual(workingFrame.corner!.maxX - 1, frame.box.maxX - inset)
                        if active {
                            XCTAssertEqual(frame.corner!.minX + 1 - frame.lineChanges!.maxX, 6)
                        }
                        XCTAssertEqual(frame.label.midY, frame.box.midY)
                        let local = SidebarLayout.local(frame, top: 12)
                        XCTAssertEqual(local.lineChanges?.minY, frame.lineChanges!.minY - 12)
                    }
                }
            }
        }
    }
}