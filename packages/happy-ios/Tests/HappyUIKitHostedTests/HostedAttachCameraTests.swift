#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The attach menu's camera cell on a stand-in engine: live once in a
/// window and in front, stopping as each of those ends, never asking for
/// access, and lending its running camera to the full one. Without access
/// it stays black with its glyph.
///
/// With `HAPPY_PREVIEW_DIR` set, the menu with a drawn stand-in for the
/// camera is kept there as `camera-tile-light.png` and `-dark.png`.
@MainActor
final class HostedAttachCameraTests: XCTestCase {
    private var window: UIWindow?
    private let photo = CameraConfiguration(mode: .photo, position: .back)

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func host(_ tile: AttachCameraTile) async throws -> UIView {
        let window = hostedKeyWindow(in: try await hostedActiveScene())
        self.window = window
        let root = try XCTUnwrap(window.rootViewController?.view)
        tile.frame = CGRect(x: 0, y: 100, width: 133, height: 267)
        root.addSubview(tile)
        window.layoutIfNeeded()
        return root
    }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state", file: file, line: line)
    }

    func testInAWindowItRunsThePhotoCameraAndShowsThePreview() async throws {
        let camera = FixtureCamera()
        let tile = AttachCameraTile(camera: camera)
        XCTAssertEqual(camera.calls, [], "started before it had a window")
        _ = try await host(tile)
        // The full camera's own run, without asking.
        try await wait { camera.calls == [.run(photo, asking: false)] && tile.live }
        XCTAssertTrue(tile.running)
        XCTAssertTrue(camera.preview.isDescendant(of: tile), "the preview isn't in the cell")
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(tile.fade.alpha, 0, accuracy: 0.001, "the black never faded")

        // Telegram's glyph, top right.
        let expected = AttachCameraTileLayout(size: tile.bounds.size, screenWidth: 1, scale: tile.traitCollection.displayScale).glyph
        XCTAssertEqual(expected.minX, 100)
        XCTAssertEqual(tile.icon.frame.minX, expected.minX, accuracy: 0.001)
        XCTAssertEqual(tile.icon.frame.minY, expected.minY, accuracy: 0.001)
        XCTAssertEqual(tile.icon.frame.size, expected.size)
        // The preview fills the cell at a full-screen camera's aspect.
        XCTAssertEqual(camera.preview.convert(camera.preview.bounds, to: tile).height, 267, accuracy: 0.01)

        tile.removeFromSuperview()
        XCTAssertEqual(camera.calls.last, .stop)
    }

    func testBackgroundStopsAndForegroundStartsAgain() async throws {
        let camera = FixtureCamera()
        let tile = AttachCameraTile(camera: camera)
        _ = try await host(tile)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: UIApplication.shared)
        XCTAssertEqual(camera.calls, [.run(photo, asking: false), .stop])
        XCTAssertFalse(tile.running)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: UIApplication.shared)
        XCTAssertEqual(camera.calls, [.run(photo, asking: false), .stop, .run(photo, asking: false)])
        XCTAssertTrue(tile.running)
    }

    /// Telegram's `isCameraPreviewVisible`: scrolled out, held; back, live.
    func testScrollingOutPausesAndBackResumes() async throws {
        let camera = FixtureCamera()
        let tile = AttachCameraTile(camera: camera)
        let window = hostedKeyWindow(in: try await hostedActiveScene())
        self.window = window
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 402, height: 500))
        scroll.contentSize = CGSize(width: 402, height: 3000)
        window.rootViewController?.view.addSubview(scroll)
        tile.frame = CGRect(x: 0, y: 0, width: 133, height: 267)
        scroll.addSubview(tile)
        XCTAssertEqual(camera.calls, [.run(photo, asking: false)])

        scroll.contentOffset = CGPoint(x: 0, y: 300)
        XCTAssertFalse(tile.onScreen)
        XCTAssertEqual(camera.calls.last, .stop)
        // Still partly in: still live.
        scroll.contentOffset = CGPoint(x: 0, y: 200)
        XCTAssertTrue(tile.onScreen)
        XCTAssertEqual(camera.calls.last, .run(photo, asking: false))
    }

    /// Lent to the full camera, the session runs on whatever happens to the
    /// cell; given back, the cell has its picture and its rules again.
    func testALentCameraKeepsRunning() async throws {
        let camera = FixtureCamera()
        let tile = AttachCameraTile(camera: camera)
        let root = try await host(tile)
        let lent = tile.lend()
        XCTAssertTrue(lent === camera)
        let elsewhere = UIView(frame: root.bounds)
        root.addSubview(elsewhere)
        elsewhere.addSubview(camera.preview)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: UIApplication.shared)
        tile.isHidden = true
        XCTAssertEqual(camera.calls, [.run(photo, asking: false)], "the cell touched a lent camera")
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: UIApplication.shared)
        tile.isHidden = false

        tile.takeBack()
        XCTAssertTrue(camera.preview.isDescendant(of: tile))
        XCTAssertEqual(camera.preview.transform, .identity)
        XCTAssertEqual(camera.calls, [.run(photo, asking: false), .run(photo, asking: false)])
        tile.removeFromSuperview()
        XCTAssertEqual(camera.calls.last, .stop)
    }

    /// Not asked yet, denied, or no camera: black with the glyph, and never
    /// a question (the cell runs without asking; the full camera asks).
    func testWithoutAccessTheCellStaysStill() async throws {
        for availability in [CameraAvailability.notDetermined, .denied, .noCamera] {
            let camera = FixtureCamera(availability: availability)
            let tile = AttachCameraTile(camera: camera)
            _ = try await host(tile)
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertEqual(camera.calls, [.run(photo, asking: false)], "\(availability)")
            XCTAssertFalse(tile.live)
            XCTAssertEqual(tile.fade.alpha, 1, "\(availability) uncovered the preview")
            XCTAssertEqual(tile.accessibilityIdentifier, "attach-camera")
            tile.removeFromSuperview()
            window?.isHidden = true
        }
    }

    /// The menu with the drawn stand-in, for screenshots.
    func testTheMenuShowsTheCameraLive() async throws {
        AttachMenuEnvironment.cameraEngine = { FixtureCamera() }
        defer { AttachMenuEnvironment.cameraEngine = { CameraEnvironment.engine() } }
        let root = UIViewController()
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        self.window = window
        let sheet = AttachSheetViewController(limit: 10, library: FixtureAttachLibrary(access: .authorized, count: 30), camera: true)
        root.present(sheet, animated: false)
        try await Task.sleep(for: .milliseconds(900))
        let tile = try XCTUnwrap(views(sheet.view).compactMap { $0 as? AttachCameraTile }.first)
        try await wait { tile.live }
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertNotNil(tile.camera.preview.surface.contents, "no stand-in frame")

        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(300))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("camera-tile-\(style == .dark ? "dark" : "light").png"))
        }
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }
}
#endif
