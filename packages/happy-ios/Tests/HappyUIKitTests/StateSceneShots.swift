#if canImport(UIKit)
import Lottie
import UIKit
import XCTest
@testable import HappyUI

/// Every scene's held last frame: asserted always, and written out for a
/// person to look at when HAPPY_SHOTS_DIR is set (happy-android's
/// `AgentHomeShots` does the same).
///
/// This matters because "holds the last frame" is only as good as what that
/// frame draws: a scene that ended with its shapes animated off screen
/// would hold a blank box, which is worse than the glyph it replaced.
@MainActor
final class StateSceneShots: XCTestCase {
    func testEverySceneRestsOnACompletePicture() async throws {
        // The shipped view really does hold progress 1, for all five.
        let held = StateScene.allCases.map { StateSceneView(scene: $0, size: 128, play: .onDemand, replayLabel: "Play again") }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 128 * CGFloat(held.count), height: 128))
        window.isHidden = false
        for (index, view) in held.enumerated() {
            view.frame = CGRect(x: 128 * CGFloat(index), y: 0, width: 128, height: 128)
            window.addSubview(view)
        }
        for _ in 0..<200 where held.contains(where: { !$0.isLoaded }) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        for (scene, view) in zip(StateScene.allCases, held) {
            XCTAssertTrue(view.isLoaded, "\(scene.rawValue) never arrived")
            XCTAssertEqual(view.progress, 1, accuracy: 0.001, "\(scene.rawValue) is not on its last frame")
        }
        window.isHidden = true

        guard let dir = ProcessInfo.processInfo.environment["HAPPY_SHOTS_DIR"] else { return }
        let folder = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        // Rasterise that same frame to look at. The shipped view runs
        // Lottie's Core Animation engine, whose layer tree neither
        // `drawHierarchy` nor `layer.render(in:)` captures off screen, so
        // the picture is drawn through the main-thread engine instead: same
        // file, same progress, a rasteriser that draws into a context.
        for dark in [false, true] {
            let size = CGFloat(128)
            let strip = UIView(frame: CGRect(x: 0, y: 0, width: size * CGFloat(StateScene.allCases.count), height: size))
            strip.backgroundColor = dark ? UIColor(white: 0.07, alpha: 1) : .white
            strip.overrideUserInterfaceStyle = dark ? .dark : .light
            for (index, scene) in StateScene.allCases.enumerated() {
                let animation = try XCTUnwrap(StateSceneView.read(scene), "\(scene.rawValue) did not decode")
                let view = LottieAnimationView(animation: animation, configuration: LottieConfiguration(renderingEngine: .mainThread))
                view.contentMode = .scaleAspectFit
                view.frame = CGRect(x: size * CGFloat(index), y: 0, width: size, height: size)
                view.currentProgress = 1
                strip.addSubview(view)
            }
            strip.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: strip.bounds).image { context in
                strip.layer.render(in: context.cgContext)
            }
            let name = "state-scenes-last-frame-\(dark ? "dark" : "light").png"
            try XCTUnwrap(image.pngData()).write(to: folder.appendingPathComponent(name))
        }
    }
}
#endif
