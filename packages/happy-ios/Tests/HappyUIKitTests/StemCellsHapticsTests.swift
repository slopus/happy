#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Each of the person's acts plays the feedback iOS gives that kind of
/// moment, through the player seam; a drag's slot ticks and its drop lands
/// as desktop's `haptics.ts` names them.
@MainActor
final class StemCellsHapticsTests: XCTestCase {
    private final class Recorder: StemCellsHaptics.Player {
        var played: [StemCellsHaptics.Feedback] = []
        var prepared: [StemCellsHaptics.Feedback] = []
        func prepare(_ feedback: StemCellsHaptics.Feedback) { prepared.append(feedback) }
        func play(_ feedback: StemCellsHaptics.Feedback) { played.append(feedback) }
    }

    private var kept: StemCellsHaptics.Player!

    override func setUp() async throws {
        kept = StemCellsHaptics.player
    }

    override func tearDown() async throws {
        StemCellsHaptics.player = kept
    }

    func testEachMomentPlaysItsFeedback() {
        let recorder = Recorder()
        StemCellsHaptics.player = recorder
        let expected: [(StemCellsHaptics.Moment, StemCellsHaptics.Feedback)] = [
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
        XCTAssertEqual(expected.count, StemCellsHaptics.Moment.allCases.count, "a moment without an expectation")
        for (moment, _) in expected { StemCellsHaptics.play(moment) }
        XCTAssertEqual(recorder.played, expected.map(\.1))
        StemCellsHaptics.prepare(.lift)
        XCTAssertEqual(recorder.prepared, [.impact(.medium)])
    }

    /// The hatch's samples make a valid Core Haptics pattern, as long as the hatch.
    func testTheHatchPatternBuilds() throws {
        let haptics = StemCellHatch.haptics(size: 20)
        let pattern = try StemCellHatchHaptics.pattern(haptics)
        XCTAssertEqual(pattern.duration, haptics.taps.last!.time, accuracy: 0.06)
    }
}
#endif
