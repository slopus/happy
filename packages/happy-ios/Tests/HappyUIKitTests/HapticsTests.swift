#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Each of the person's acts plays the feedback iOS gives that kind of
/// moment, through the player seam; a drag's slot ticks and its drop lands
/// as desktop's `haptics.ts` names them.
@MainActor
final class HapticsTests: XCTestCase {
    private final class Recorder: Haptics.Player {
        var played: [Haptics.Feedback] = []
        var prepared: [Haptics.Feedback] = []
        func prepare(_ feedback: Haptics.Feedback) { prepared.append(feedback) }
        func play(_ feedback: Haptics.Feedback) { played.append(feedback) }
    }

    private var kept: Haptics.Player!

    override func setUp() async throws {
        kept = Haptics.player
    }

    override func tearDown() async throws {
        Haptics.player = kept
    }

    func testEachMomentPlaysItsFeedback() {
        let recorder = Recorder()
        Haptics.player = recorder
        let expected: [(Haptics.Moment, Haptics.Feedback)] = [
            (.hold, .impact(.light)),
            (.lift, .impact(.medium)),
            (.slot, .selection),
            (.drop, .impact(.light)),
            (.putAway, .notification(.success)),
            (.renamed, .impact(.light)),
            (.send, .impact(.light)),
            (.newWork, .impact(.light)),
            (.pick, .selection),
            (.fold, .impact(.light)),
        ]
        XCTAssertEqual(expected.count, Haptics.Moment.allCases.count, "a moment without an expectation")
        for (moment, _) in expected { Haptics.play(moment) }
        XCTAssertEqual(recorder.played, expected.map(\.1))
        Haptics.prepare(.lift)
        XCTAssertEqual(recorder.prepared, [.impact(.medium)])
    }

    /// The hatch's samples make a valid Core Haptics pattern, as long as the hatch.
    func testTheHatchPatternBuilds() throws {
        let haptics = Hatch.haptics(size: 20)
        let pattern = try HatchHaptics.pattern(haptics)
        XCTAssertEqual(pattern.duration, haptics.taps.last!.time, accuracy: 0.06)
    }
}
#endif
