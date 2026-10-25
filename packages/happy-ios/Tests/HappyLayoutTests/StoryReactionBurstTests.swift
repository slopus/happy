import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The effect as a story is reacted to, around the heart or the bubble, as
/// Telegram's `StandaloneReactionAnimation` sizes it.
final class StoryReactionBurstTests: XCTestCase {
    /// 240 around the middle of what was tapped, as Telegram's effect frame
    /// is its 120 square inset by half again each side.
    func testEffectAroundTheTarget() {
        let burst = StoryReactionBurst(target: CGRect(x: 340, y: 780, width: 44, height: 44))
        XCTAssertEqual(burst.effect, CGRect(x: 242, y: 682, width: 240, height: 240))
        XCTAssertEqual(burst.particles.count, 7)
        for particle in burst.particles { XCTAssertEqual(particle.start, CGPoint(x: 362, y: 802)) }
    }

    /// The first goes straight up, the full reach plus the rise; the others
    /// round the ring, each a beat later, all ending with the effect.
    func testThrownOutAndRising() {
        let burst = StoryReactionBurst(target: CGRect(x: 0, y: 0, width: 40, height: 40))
        let first = burst.particles[0]
        XCTAssertEqual(first.end.x, 20, accuracy: 0.001)
        XCTAssertEqual(first.end.y, 20 - 105 - 26, accuracy: 0.001)
        XCTAssertEqual(first.peakScale, 1)
        XCTAssertEqual(first.delay, 0)
        let third = burst.particles[2]
        let angle = -CGFloat.pi / 2 + 2 * 2 * .pi / 7
        XCTAssertEqual(third.end.x, 20 + cos(angle) * 105 * 0.94, accuracy: 0.001)
        XCTAssertEqual(third.end.y, 20 + sin(angle) * 105 * 0.94 - 26, accuracy: 0.001)
        XCTAssertEqual(third.delay, 0.06, accuracy: 0.0001)
        for particle in burst.particles {
            XCTAssertEqual(particle.delay + particle.duration, 0.9, accuracy: 0.0001)
            // Every copy stays within the effect, but for the rise.
            XCTAssertLessThanOrEqual(abs(particle.end.x - 20), 105.001)
        }
    }
}
