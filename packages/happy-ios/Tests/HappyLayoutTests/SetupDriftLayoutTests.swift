import XCTest
@testable import HappyLayout

final class SetupDriftLayoutTests: XCTestCase {
    private let middle = SetupDriftLayout.Draw(size: 0.5, x: 0.5, y: 0.5, dx: 0.5, dy: 0.5, delay: 0.5, duration: 0.5)

    /// A fixed, spread-out run of picks, as `random` would give.
    private func draws(_ count: Int, seed: UInt64) -> [SetupDriftLayout.Draw] {
        var state = seed
        let next: () -> CGFloat = {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return CGFloat(state >> 33) / CGFloat(1 << 31)
        }
        return (0..<count).map { _ in SetupDriftLayout.Draw.random(next) }
    }

    /// The welcome on a phone: the art, the words across the column, the
    /// dots and the two buttons.
    private let phoneAvoid = [
        CGRect(x: 148.5, y: 262, width: 96, height: 96),
        CGRect(x: 24, y: 382, width: 345, height: 130),
        CGRect(x: 136, y: 536, width: 120, height: 26),
        CGRect(x: 78.5, y: 682, width: 236, height: 112),
    ]

    /// A phone: two a side, 48 at the middle picks, hugging the edge and
    /// partly off it, above and below the words that reach the edges.
    func testAPhonesHugTheEdgesAboveAndBelowTheWords() {
        let avoid = [CGRect(x: 24, y: 300, width: 345, height: 300)]
        let layout = SetupDriftLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 103, left: 0, bottom: 34, right: 0),
                                      avoid: avoid, draws: Array(repeating: middle, count: 6))
        XCTAssertEqual(layout.items.map(\.scene), [0, 1, 3, 4])
        let first = layout.items[0]
        XCTAssertEqual(first.frame.minX, -6.2, accuracy: 0.001)
        XCTAssertEqual(first.frame.minY, 186.75, accuracy: 0.001)
        XCTAssertEqual(first.frame.size, CGSize(width: 48, height: 48))
        XCTAssertEqual(first.offset, CGVector(dx: 0, dy: 0))
        XCTAssertEqual(first.delay, 1.3, accuracy: 0.001)
        XCTAssertEqual(first.duration, 22, accuracy: 0.001)
        XCTAssertEqual(layout.items[1].frame.midY, 710.25, accuracy: 0.001)
        // The right side mirrors the left.
        XCTAssertEqual(layout.items[2].frame.maxX, 393 + 6.2, accuracy: 0.001)
        XCTAssertEqual(layout.items[2].frame.minY, first.frame.minY, accuracy: 0.001)
    }

    /// Whatever the picks, a phone's never reach what they must avoid, with
    /// their wander and 8 to spare, nor each other, and show at most 35%
    /// off the edge.
    func testAPhonesStayClearOfTheSlidesAndTheButtons() {
        for seed in 1...200 as ClosedRange<UInt64> {
            let layout = SetupDriftLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 103, left: 0, bottom: 34, right: 0),
                                          avoid: phoneAvoid, draws: draws(6, seed: seed))
            XCTAssertLessThanOrEqual(layout.items.count, 4)
            for item in layout.items {
                let reach = item.frame.insetBy(dx: -abs(item.offset.dx) - 8, dy: -abs(item.offset.dy) - 8)
                for rect in phoneAvoid { XCTAssertFalse(reach.intersects(rect), "seed \(seed): \(item) reaches \(rect)") }
                XCTAssertTrue((40...56).contains(item.frame.width))
                XCTAssertGreaterThanOrEqual(item.frame.minX + abs(item.offset.dx), -item.frame.width * 0.35 - 0.001)
                XCTAssertLessThanOrEqual(item.frame.maxX - abs(item.offset.dx), 393 + item.frame.width * 0.35 + 0.001)
            }
            for (index, item) in layout.items.enumerated() {
                for other in layout.items[(index + 1)...] { XCTAssertFalse(item.frame.intersects(other.frame), "seed \(seed)") }
            }
        }
    }

    /// A tablet is desktop's: three a side, 64–104, 5–19% in from its side,
    /// between 14% and 80% down.
    func testATabletIsDesktops() {
        let avoid = [CGRect(x: 292, y: 500, width: 440, height: 400)]
        for seed in 1...50 as ClosedRange<UInt64> {
            let layout = SetupDriftLayout(size: CGSize(width: 1024, height: 1366), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0),
                                          avoid: avoid, draws: draws(6, seed: seed))
            XCTAssertEqual(layout.items.map(\.scene), [0, 1, 2, 3, 4, 5])
            for item in layout.items {
                XCTAssertTrue((64...104).contains(item.frame.width))
                let across = item.scene < 3 ? item.frame.midX / 1024 : 1 - item.frame.midX / 1024
                XCTAssertTrue((0.05 - 0.001...0.19 + 0.001).contains(across), "\(item)")
                XCTAssertGreaterThanOrEqual(item.frame.midY, 1366 * 0.14)
                XCTAssertLessThanOrEqual(item.frame.midY, 1366 * 0.80)
                XCTAssertTrue(abs(item.offset.dx) <= 36 && abs(item.offset.dy) <= 48)
                XCTAssertTrue((0.2...2.4).contains(item.delay) && (16...28).contains(item.duration))
            }
        }
    }

    /// Something reaching both edges top to bottom leaves no room: none.
    func testNoRoomShowsNone() {
        let layout = SetupDriftLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 103, left: 0, bottom: 34, right: 0),
                                      avoid: [CGRect(x: 10, y: 0, width: 373, height: 852)], draws: Array(repeating: middle, count: 6))
        XCTAssertEqual(layout.items, [])
    }
}
