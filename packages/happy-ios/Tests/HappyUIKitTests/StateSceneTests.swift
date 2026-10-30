#if canImport(UIKit)
import CryptoKit
import Lottie
import UIKit
import XCTest
@testable import HappyUI

/// `Sources/HappyUI/Resources/Animations`: desktop's five state pictures,
/// and the view that draws one of them.
@MainActor
final class StateSceneTests: XCTestCase {
    /// happy-desktop `packages/happy-desktop-ui/src/assets/animations/PROVENANCE.md`
    /// at 8b133d98e. Android's `res/raw` ships the same bytes.
    private static let hashes: [StateScene: String] = [
        .snail: "6a9c7b648681ae9d15b31455a76f7d47c5f53d6d72da10b8e43ba134fbd47a2c",
        .wand: "8de70508fe1ebdeb08fc7005820329696f28ec84adc94f3cc4362cf7d3e72870",
        .robot: "eeabc392ba20328ce97452eb826dddf3e306129e360ce4847c3b48470ffc053b",
        .sparkles: "b14e504ce3467a6ba1c519348dee9fc4e05286b9e4f058f33df9175865bde4b9",
        .owl: "95402270d116a310aa4b1606f88a2bbc79d2b4d947b5d84181c0b126c7aaba59",
    ]

    private func url(_ scene: StateScene) throws -> URL {
        try XCTUnwrap(
            Bundle.module.url(forResource: scene.rawValue, withExtension: "json")
                ?? Bundle.module.url(forResource: scene.rawValue, withExtension: "json", subdirectory: "Animations"),
            "\(scene.rawValue).json is not in the bundle"
        )
    }

    // MARK: The files

    /// A file that was replaced or re-exported fails here rather than
    /// changing the art quietly.
    func testEverySceneIsDesktopsExactBytes() throws {
        for scene in StateScene.allCases {
            let data = try Data(contentsOf: url(scene))
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(digest, Self.hashes[scene], "\(scene.rawValue).json is not desktop's file")
        }
    }

    func testEverySceneDecodes() throws {
        for scene in StateScene.allCases {
            XCTAssertNotNil(StateSceneView.read(scene), "\(scene.rawValue) did not decode")
        }
    }

    /// Lottie 4.5.2 cannot draw everything After Effects can export. Rather
    /// than substituting art, name what it would skip: all five are plain
    /// shape animations, so nothing here should have an expression, an
    /// effect, a matte or a text layer.
    func testNoSceneUsesSomethingLottieCannotDraw() throws {
        for scene in StateScene.allCases {
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url(scene)))
            let json = try XCTUnwrap(object as? [String: Any])
            let layers = (json["layers"] as? [[String: Any]]) ?? []
            let assetLayers = ((json["assets"] as? [[String: Any]]) ?? []).flatMap { ($0["layers"] as? [[String: Any]]) ?? [] }
            for layer in layers + assetLayers {
                let name = (layer["nm"] as? String) ?? "?"
                XCTAssertNil(layer["ef"], "\(scene.rawValue): layer \(name) has an effect")
                XCTAssertNil(layer["tm"], "\(scene.rawValue): layer \(name) is time-remapped")
                XCTAssertEqual(layer["td"] as? Int ?? 0, 0, "\(scene.rawValue): layer \(name) is a matte")
                XCTAssertEqual(layer["tt"] as? Int ?? 0, 0, "\(scene.rawValue): layer \(name) is masked by a matte")
                // 5 is a text layer, which needs fonts we do not ship.
                XCTAssertNotEqual(layer["ty"] as? Int, 5, "\(scene.rawValue): layer \(name) is text")
            }
        }
    }

    // MARK: The box

    /// The notice and the search capsule both put this where a glyph was.
    /// A view that measured differently would start the notice scrolling
    /// and invalidate the results list's layout.
    func testTheBoxIsTheOneItWasBuiltWith() {
        for size in [CGFloat(56), 96, 128] {
            let view = StateSceneView(scene: .snail, size: size, replayLabel: "Play again")
            let square = CGSize(width: size, height: size)
            XCTAssertEqual(view.intrinsicContentSize, square)
            XCTAssertEqual(view.sizeThatFits(square), square)
            XCTAssertEqual(view.sizeThatFits(CGSize(width: 10, height: 10)), square, "a smaller offer still measures the same")
            XCTAssertEqual(view.sizeThatFits(CGSize(width: 1000, height: 1000)), square, "a larger offer still measures the same")
            XCTAssertEqual(view.sizeThatFits(.zero), view.intrinsicContentSize, "the two must agree")
        }
    }

    /// The notice's own regression: a view in HomeNotice's 56 icon box must
    /// not make NoSessionsView taller than the safe area, which is what
    /// starts it scrolling. `NoSessionsLayout.Input.icon` is already a
    /// CGSize, so the box this contributes is the glyph's, unchanged.
    func testItFitsHomeNoticesIconBox() {
        let view = StateSceneView(scene: .wand, size: 56, replayLabel: "Play again")
        let box = CGSize(width: 56, height: 56)
        XCTAssertEqual(view.intrinsicContentSize, box)
        for offer in [CGSize(width: 320, height: 2000), CGSize(width: 56, height: 57.67), CGSize.zero] {
            XCTAssertEqual(view.sizeThatFits(offer), box, "offered \(offer) it still measures the glyph's box")
        }
    }

    func testTheAnimationFillsTheBox() {
        let view = StateSceneView(scene: .owl, size: 96, replayLabel: "Play again")
        view.layoutIfNeeded()
        let animation = try? XCTUnwrap(view.subviews.first)
        XCTAssertEqual(animation?.frame, view.bounds)
    }

    // MARK: What it offers

    /// The artwork says nothing the words beside it do not; the only thing
    /// to announce is the one action.
    func testItIsAButtonNamedForItsOneAction() throws {
        try XCTSkipIf(UIAccessibility.isReduceMotionEnabled, "reduce motion is on in this environment")
        let view = StateSceneView(scene: .wand, size: 128, replayLabel: "Play again")
        XCTAssertTrue(view.isAccessibilityElement)
        XCTAssertEqual(view.accessibilityTraits, .button)
        XCTAssertEqual(view.accessibilityLabel, "Play again")
        XCTAssertTrue(view.isUserInteractionEnabled)
    }

    func testChangingTheSceneKeepsTheBox() {
        let view = StateSceneView(scene: .snail, size: 128, replayLabel: "Play again")
        view.scene = .sparkles
        XCTAssertEqual(view.scene, .sparkles)
        XCTAssertEqual(view.intrinsicContentSize, CGSize(width: 128, height: 128))
    }

    // MARK: Appearing, leaving, coming back

    /// Waits for the real read, which happens off the main thread.
    private func loaded(_ view: StateSceneView, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 where !view.isLoaded {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(view.isLoaded, "the animation never arrived", file: file, line: line)
    }

    /// A window the view can actually be seen in: Lottie refuses to play
    /// for a view that is not on one.
    private func shown(_ view: StateSceneView) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 320))
        window.isHidden = false
        window.addSubview(view)
        view.frame = CGRect(x: 0, y: 0, width: view.sceneSize, height: view.sceneSize)
        return window
    }

    func testItPlaysOnceWhenItAppearsAndThenHolds() async throws {
        try XCTSkipIf(UIAccessibility.isReduceMotionEnabled, "reduce motion is on in this environment")
        let view = StateSceneView(scene: .sparkles, size: 128, replayLabel: "Play again")
        let window = shown(view)
        try await loaded(view)
        XCTAssertTrue(view.isAnimating, "it plays as it appears")
        view.removeFromSuperview()
        XCTAssertFalse(view.isAnimating, "off screen, nothing moves")
        window.isHidden = true
    }

    /// An interrupted play has still not been seen, so coming back goes on
    /// from where it stopped rather than starting over.
    func testLeavingPausesAndComingBackResumes() async throws {
        try XCTSkipIf(UIAccessibility.isReduceMotionEnabled, "reduce motion is on in this environment")
        let view = StateSceneView(scene: .snail, size: 128, replayLabel: "Play again")
        let window = shown(view)
        try await loaded(view)
        try await Task.sleep(nanoseconds: 120_000_000)
        view.isHidden = true
        let stopped = view.progress
        XCTAssertFalse(view.isAnimating, "hidden, nothing moves")
        XCTAssertGreaterThan(stopped, 0, "it had started")
        XCTAssertLessThan(stopped, 1, "and had not finished")
        view.isHidden = false
        XCTAssertGreaterThanOrEqual(view.progress, stopped, "it goes on, it does not start over")
        window.isHidden = true
    }

    /// The parent's rule: a state that refreshes must not replay.
    func testComingBackAfterItFinishedDoesNotPlayAgain() async throws {
        try XCTSkipIf(UIAccessibility.isReduceMotionEnabled, "reduce motion is on in this environment")
        // owl is the shortest, 131 frames at 60fps, so this waits the least.
        let view = StateSceneView(scene: .owl, size: 96, replayLabel: "Play again")
        let window = shown(view)
        try await loaded(view)
        for _ in 0..<60 where view.progress < 1 {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(view.progress, 1, accuracy: 0.001, "it reached the last frame")
        view.isHidden = true
        view.isHidden = false
        XCTAssertFalse(view.isAnimating, "appearing again holds the frame it ended on")
        XCTAssertEqual(view.progress, 1, accuracy: 0.001)
        window.isHidden = true
    }

    /// `onDemand` is the deterministic form: it shows the held frame from
    /// the start and never moves on its own.
    func testOnDemandNeverStartsItself() async throws {
        let view = StateSceneView(scene: .robot, size: 128, play: .onDemand, replayLabel: "Play again")
        let window = shown(view)
        try await loaded(view)
        XCTAssertFalse(view.isAnimating, "nothing started it")
        XCTAssertEqual(view.progress, 1, accuracy: 0.001, "the last frame, not a blank first one")
        window.isHidden = true
    }

    /// Setting the scene again and again must leave one animation, one box
    /// and no stale play.
    func testRepeatedConfigurationSettles() async throws {
        let view = StateSceneView(scene: .snail, size: 128, play: .onDemand, replayLabel: "Play again")
        let window = shown(view)
        for scene in [StateScene.wand, .robot, .sparkles, .owl, .snail] {
            view.scene = scene
        }
        try await loaded(view)
        XCTAssertEqual(view.scene, .snail)
        XCTAssertEqual(view.subviews.count, 1, "one animation view, however often it was configured")
        XCTAssertEqual(view.intrinsicContentSize, CGSize(width: 128, height: 128))
        XCTAssertEqual(view.progress, 1, accuracy: 0.001)
        window.isHidden = true
    }

    /// Reduce motion holds the LAST frame — the pose each file was drawn to
    /// return to — not frame zero, which for several of these reads as a
    /// blank or half-drawn box.
    func testReduceMotionHoldsTheLastFrameAndOffersNoControl() async throws {
        try XCTSkipUnless(UIAccessibility.isReduceMotionEnabled, "run with reduce motion on to check this")
        for scene in StateScene.allCases {
            let view = StateSceneView(scene: scene, size: 128, replayLabel: "Play again")
            let window = shown(view)
            try await loaded(view)
            XCTAssertFalse(view.isAnimating, "\(scene.rawValue) moved with motion reduced")
            XCTAssertEqual(view.progress, 1, accuracy: 0.001, "\(scene.rawValue) did not hold its last frame")
            XCTAssertFalse(view.isAccessibilityElement, "\(scene.rawValue) offered a replay control")
            view.replay()
            XCTAssertFalse(view.isAnimating, "\(scene.rawValue) replayed with motion reduced")
            window.isHidden = true
        }
    }

    /// Going away while the read is still in flight must not leave the task
    /// running or touch a view that is gone.
    func testLeavingBeforeItLoadsCancelsTheRead() async throws {
        var view: StateSceneView? = StateSceneView(scene: .wand, size: 128, replayLabel: "Play again")
        weak var weakView = view
        view = nil
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(weakView, "the view was kept alive by its own read")
    }

    // MARK: Nothing to draw

    /// Until the animation arrives, and forever if it cannot, the host's own
    /// glyph underneath is what the reader sees.
    func testItDrawsNothingUntilTheAnimationArrives() {
        let view = StateSceneView(scene: .robot, size: 128, replayLabel: "Play again")
        let animation = view.subviews.first as? LottieAnimationView
        XCTAssertNotNil(animation)
        XCTAssertNil(animation?.animation, "the animation is read off the main thread, so it is not there yet")
        XCTAssertNil(view.backgroundColor, "nothing is drawn in its place")
    }
}
#endif
