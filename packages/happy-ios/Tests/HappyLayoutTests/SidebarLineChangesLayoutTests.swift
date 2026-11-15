import XCTest
@testable import HappyLayout

final class SidebarLineChangesLayoutTests: XCTestCase {
    func testMeasuredStatusInkIsCentredInTheStatusSlotAfterTheCounts() {
        let ink = CGRect(x: 5, y: 4, width: 17, height: 17)
        for depth in 0...2 {
            let row = SidebarLayout.Row(kind: .row, depth: depth, hasTrailing: true, lineChangesWidth: 80, trailingInk: ink)
            let frame = SidebarLayout.layout([row], width: 390, top: 0, bottom: 0, style: .grouped).frames[0]
            let slot = SidebarLayout.statusSlot(box: frame.box, activityRight: frame.box.maxX - 16)
            XCTAssertEqual(slot.size, CGSize(width: Metrics.statusSlot, height: Metrics.statusSlot))
            XCTAssertEqual(frame.trailing!.minX + ink.midX, slot.midX)
            XCTAssertEqual(frame.trailing!.minY + ink.midY, slot.midY)
            XCTAssertEqual(slot.midY, frame.box.midY)
            XCTAssertEqual(slot.minX - frame.lineChanges!.maxX, Metrics.statusGap)
            XCTAssertEqual(frame.lineChanges!.minX - frame.label.maxX, Metrics.trailingGap)
        }
    }

    func testEveryStatusMarkSharesOneColumn() {
        let question = CGRect(x: 7, y: 6.5, width: 12.5, height: 13)
        let dot = CGRect(x: 8.5, y: 8.5, width: 10, height: 10)
        for style in [SidebarLayout.Style.plain, .grouped] {
            for counts: CGFloat in [0, 60] {
                let rows = [
                    SidebarLayout.Row(kind: .row, hasWorkingSignal: true, lineChangesWidth: counts),
                    SidebarLayout.Row(kind: .row, hasTrailing: true, lineChangesWidth: counts, trailingInk: question),
                    SidebarLayout.Row(kind: .row, hasTrailing: true, lineChangesWidth: counts, trailingInk: dot),
                ]
                let frames = SidebarLayout.layout(rows, width: 390, top: 0, bottom: 0, style: style).frames
                let signal = SidebarLayout.workingInk(scale: 3)
                let centres = [
                    CGPoint(x: frames[0].corner!.minX + signal.midX, y: frames[0].corner!.minY + signal.midY - frames[0].box.minY),
                    CGPoint(x: frames[1].trailing!.minX + question.midX, y: frames[1].trailing!.minY + question.midY - frames[1].box.minY),
                    CGPoint(x: frames[2].trailing!.minX + dot.midX, y: frames[2].trailing!.minY + dot.midY - frames[2].box.minY),
                ]
                XCTAssertEqual(Set(centres.map(\.x)).count, 1)
                XCTAssertEqual(Set(centres.map(\.y)).count, 1)
                XCTAssertEqual(Set(frames.map(\.label.maxX)).count, 1)
                if counts > 0 { XCTAssertEqual(Set(frames.map { $0.lineChanges!.maxX }).count, 1) }
            }
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
                        let inset = style == .grouped ? GroupedSidebarMetrics.markInset : Metrics.endInset - Metrics.mark / 2
                        let original = SidebarLayout.layout([row], width: width, top: 0, bottom: 0, style: style).frames[0]
                        let frame = SidebarLayout.layout([counted], width: width, top: 0, bottom: 0, style: style).frames[0]
                        XCTAssertEqual(frame.box, original.box)
                        var working = row
                        working.hasWorkingSignal = true
                        let workingFrame = SidebarLayout.layout([working], width: width, top: 0, bottom: 0, style: style).frames[0]
                        XCTAssertEqual(frame.lineChanges?.maxX, active ? original.label.maxX : frame.box.maxX - inset)
                        XCTAssertEqual(frame.lineChanges?.width, 120)
                        XCTAssertEqual(frame.label.maxX + Metrics.trailingGap, frame.lineChanges?.minX)
                        XCTAssertEqual(frame.corner, original.corner)
                        XCTAssertEqual(workingFrame.corner!.midX, frame.box.maxX - inset - Metrics.statusSlot / 2)
                        if active {
                            XCTAssertEqual(frame.corner!.midX - Metrics.statusSlot / 2 - frame.lineChanges!.maxX, Metrics.statusGap)
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