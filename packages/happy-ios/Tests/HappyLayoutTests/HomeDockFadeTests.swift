import HappyLayout
import XCTest

/// The resting dock fades in when it goes from hidden to shown: from
/// nothing when home's content comes in, its surface from where the closing
/// composer's shell left off when the composer closes, and not at all off
/// a window or with Reduce Motion.
final class HomeDockFadeTests: XCTestCase {
    func testAppearingFadesFromNothingIn220ms() {
        let fade = HomeDockFade.shown(from: .appearing, onWindow: true, reduceMotion: false)
        XCTAssertEqual(fade, HomeDockFade(surfaceFrom: 0, contentFrom: 0, duration: 0.22))
    }

    func testBackFromTheComposerTakesUpTheShellsOpacityForTheClosesDuration() throws {
        let fade = try XCTUnwrap(HomeDockFade.shown(from: .focus, onWindow: true, reduceMotion: false))
        // The closed shell: an empty capsule at 0.72.
        XCTAssertEqual(fade.surfaceFrom, 0.72, accuracy: 1e-9)
        XCTAssertEqual(fade.surfaceFrom, HomeDockFocusMotion(progress: 0).composerAlpha)
        XCTAssertEqual(fade.contentFrom, 0)
        XCTAssertEqual(fade.duration, HomeDockFocusMotion.closeDuration)
        XCTAssertEqual(fade.duration, 0.18)
    }

    func testOffAWindowOrWithReduceMotionItShowsAtOnce() {
        for origin in [HomeDockFade.Origin.appearing, .focus] {
            XCTAssertNil(HomeDockFade.shown(from: origin, onWindow: false, reduceMotion: false))
            XCTAssertNil(HomeDockFade.shown(from: origin, onWindow: true, reduceMotion: true))
            XCTAssertNil(HomeDockFade.shown(from: origin, onWindow: false, reduceMotion: true))
        }
    }

    func testThePresenceEasesOutToOne() {
        let fade = HomeDockFade(surfaceFrom: 0, contentFrom: 0, duration: 0.22)
        XCTAssertEqual(fade.presence(at: 0).surface, 0)
        // Ease-out cubic: 0.875 halfway.
        XCTAssertEqual(fade.presence(at: 0.11).surface, 0.875, accuracy: 1e-9)
        XCTAssertEqual(fade.presence(at: 0.11).content, 0.875, accuracy: 1e-9)
        XCTAssertEqual(fade.presence(at: 0.22).surface, 1)
        XCTAssertEqual(fade.presence(at: 0.22).content, 1)
        XCTAssertEqual(fade.presence(at: 1).surface, 1)
        XCTAssertEqual(fade.presence(at: -0.1).surface, 0, "before it starts")
        XCTAssertFalse(fade.isFinished(at: 0.2199))
        XCTAssertTrue(fade.isFinished(at: 0.22))
        var last: CGFloat = 0
        for step in 1...22 {
            let presence = fade.presence(at: Double(step) / 100).surface
            XCTAssertGreaterThan(presence, last, "rises every frame")
            last = presence
        }
    }

    func testBackFromTheComposerTheSurfaceNeverDipsBelowTheShell() {
        let fade = HomeDockFade(surfaceFrom: 0.72, contentFrom: 0, duration: 0.18)
        XCTAssertEqual(fade.presence(at: 0).surface, 0.72, accuracy: 1e-9)
        XCTAssertEqual(fade.presence(at: 0).content, 0)
        XCTAssertEqual(fade.presence(at: 0.09).surface, 0.72 + 0.28 * 0.875, accuracy: 1e-9)
        XCTAssertEqual(fade.presence(at: 0.09).content, 0.875, accuracy: 1e-9)
        XCTAssertEqual(fade.presence(at: 0.18).surface, 1)
        XCTAssertEqual(fade.presence(at: 0.18).content, 1)
        for step in 0...18 {
            XCTAssertGreaterThanOrEqual(fade.presence(at: Double(step) / 100).surface, 0.72 - 1e-9)
        }
    }

    func testNoDurationIsFullAtOnce() {
        let presence = HomeDockFade(surfaceFrom: 0, contentFrom: 0, duration: 0).presence(at: 0)
        XCTAssertEqual(presence.surface, 1)
        XCTAssertEqual(presence.content, 1)
    }
}
