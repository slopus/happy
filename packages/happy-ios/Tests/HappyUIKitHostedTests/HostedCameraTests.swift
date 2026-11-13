#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import ImageIO
import UIKit
import XCTest

/// The full camera over a stand-in engine: what it asks of the camera for
/// each button and gesture, the shot, the review and the way out.
@MainActor
final class HostedCameraTests: XCTestCase {
    private var window: UIWindow?
    private let back = CameraConfiguration(mode: .photo, position: .back)
    private let front = CameraConfiguration(mode: .photo, position: .front)

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state", file: file, line: line)
    }

    /// The camera open and settled over a plain screen; `tile` where its
    /// picture grows from.
    private func open(_ camera: FixtureCamera, tile: CGRect? = nil, file: StaticString = #filePath, line: UInt = #line) async throws -> CameraViewController {
        window?.isHidden = true
        let root = UIViewController()
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        let screen = CameraViewController(camera: camera)
        screen.tile = { tile }
        root.present(screen, animated: false)
        try await wait(5, { screen.phase == .live }, file: file, line: line)
        screen.view.layoutIfNeeded()
        return screen
    }

    private func shots(_ camera: FixtureCamera) -> [CameraShot] {
        camera.calls.compactMap { if case .capture(let shot) = $0 { shot } else { nil } }
    }

    private func reset(_ screen: CameraViewController) {
        // The settings outlive a screen, as the system camera's do.
        while screen.settings.aspect != .standard { screen.aspectButton.sendActions(for: .touchUpInside) }
        while screen.settings.flash != .auto { screen.flashButton.sendActions(for: .touchUpInside) }
        while screen.settings.timer != .off { screen.timerButton.sendActions(for: .touchUpInside) }
        if screen.settings.grid { screen.gridButton.sendActions(for: .touchUpInside) }
    }

    /// From the tile, the camera asks for exactly the run the tile had
    /// going, so the session goes on as it was.
    func testItTakesOverTheTilesRunningCamera() async throws {
        let camera = FixtureCamera()
        camera.run(back, asking: false)
        let screen = try await open(camera, tile: CGRect(x: 0, y: 300, width: 133, height: 267))
        XCTAssertEqual(camera.calls, [.run(back, asking: false), .run(back, asking: true)])
        XCTAssertTrue(camera.preview.isDescendant(of: screen.view))
        XCTAssertEqual(camera.preview.transform, .identity, "the picture never finished growing")
        XCTAssertEqual(screen.zoomBar.subviews.compactMap { $0 as? UIButton }.count, 3)
    }

    /// The shutter: a photo of the chosen shape with the chosen flash, the
    /// camera stopped under the review, Use Photo hands it over.
    func testAShotIsReviewedThenUsed() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera)
        reset(screen)
        var used: CameraPhoto??
        screen.onFinish = { used = .some($0) }
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { !screen.review.isHidden }
        XCTAssertEqual(shots(camera), [CameraShot(flash: .auto, ratio: 4.0 / 3.0)])
        XCTAssertEqual(camera.calls.last, .stop, "the camera ran under the review")
        screen.useButton.sendActions(for: .touchUpInside)
        try await wait { used != nil }
        XCTAssertEqual(used??.data, FixtureCamera.jpeg)
    }

    func testRetakeRunsTheCameraAgain() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera)
        reset(screen)
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { !screen.review.isHidden }
        screen.retakeButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(camera.calls.last, .run(back, asking: true))
        XCTAssertEqual(screen.phase, .live)
        try await wait { screen.review.isHidden }
    }

    /// A failed shot leaves the camera as it was.
    func testAFailedShotGoesBackToTheCamera() async throws {
        let camera = FixtureCamera()
        camera.capturesFail = true
        let screen = try await open(camera)
        reset(screen)
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { screen.phase == .live }
        XCTAssertTrue(screen.review.isHidden)
    }

    /// The shapes: square photos are the 4:3 picture's middle, the rest dimmed.
    func testTheShapeButtonCutsThePhoto() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera)
        reset(screen)
        screen.aspectButton.sendActions(for: .touchUpInside)
        screen.aspectButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.settings.aspect, .square)
        XCTAssertEqual(screen.aspectButton.accessibilityValue, "1:1")
        screen.view.layoutIfNeeded()
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { !shots(camera).isEmpty }
        XCTAssertEqual(shots(camera).first?.ratio, 1)
        reset(screen)
    }

    /// The timer counts down before the shot; a press while it counts stops it.
    func testTheTimerCountsDown() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera)
        reset(screen)
        screen.timerButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.settings.timer, .three)
        screen.shutter.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.phase, .counting(3))
        XCTAssertTrue(shots(camera).isEmpty)
        screen.shutter.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.phase, .live)

        screen.shutter.sendActions(for: .touchUpInside)
        try await wait(5) { !shots(camera).isEmpty }
        XCTAssertEqual(shots(camera).count, 1)
        reset(screen)
    }

    /// Lenses glide to their zoom; a tap focuses there, a long press locks.
    func testLensesAndFocus() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera)
        let lenses = try XCTUnwrap(screen.zoomBar.subviews.compactMap { $0 as? UIButton }.first)
        lenses.sendActions(for: .touchUpInside)
        XCTAssertEqual(camera.calls.last, .zoom(camera.lenses.stops[0], ramp: true))

        let point = CGPoint(x: 100, y: 120)
        screen.focus(at: point, lock: false)
        guard case .focus(let asked?, lock: false) = camera.calls.last else { return XCTFail("no focus: \(camera.calls)") }
        XCTAssertEqual(asked.x, point.x, accuracy: 0.5)
        XCTAssertTrue(screen.focusView.isShowing)
        XCTAssertFalse(screen.locked)
        screen.focus(at: point, lock: true)
        XCTAssertEqual(camera.calls.last.map { if case .focus(_, let lock) = $0 { lock } else { false } }, true)
        XCTAssertTrue(screen.locked)
    }

    /// The flip asks for the other camera; without a flash of its own the
    /// front camera's flash is the screen, lit before the shot.
    func testTheFrontCameraLightsTheScreen() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera)
        reset(screen)
        screen.flip()
        XCTAssertEqual(camera.calls.last, .run(front, asking: true))
        XCTAssertFalse(screen.flashButton.isHidden, "the front camera's screen flash has no button")
        screen.flashButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.settings.flash, .on)
        screen.shutter.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.screenFlash.alpha, 1)
        XCTAssertTrue(shots(camera).isEmpty, "shot before the screen lit")
        try await wait { !shots(camera).isEmpty }
        XCTAssertEqual(shots(camera), [CameraShot(flash: .off, ratio: 4.0 / 3.0)])
        reset(screen)
    }

    /// No access: the reason, Settings, and no shutter.
    func testDeniedSaysSo() async throws {
        let camera = FixtureCamera(availability: .denied)
        let screen = try await open(camera)
        let texts = views(screen.view).compactMap { ($0 as? StyledLabel).flatMap { $0.isHidden ? nil : $0.string } }
        XCTAssertTrue(texts.contains(Strings.Camera.denied), "\(texts)")
        XCTAssertFalse(screen.shutter.isEnabled)
        XCTAssertTrue(views(screen.view).contains { ($0 as? RoundButton)?.isHidden == false })
    }

    /// Closed with a tile to go back to, the camera keeps running for it;
    /// closed without one, it stops.
    func testClosingGoesBackToTheTileStillRunning() async throws {
        let camera = FixtureCamera()
        let screen = try await open(camera, tile: CGRect(x: 0, y: 300, width: 133, height: 267))
        var closed = false
        screen.onFinish = { photo in closed = photo == nil }
        screen.closeButton.sendActions(for: .touchUpInside)
        try await wait { closed }
        XCTAssertNotEqual(camera.calls.last, .stop)

        let alone = FixtureCamera()
        let other = try await open(alone)
        var gone = false
        other.onFinish = { _ in gone = true }
        other.closeButton.sendActions(for: .touchUpInside)
        try await wait { gone }
        XCTAssertEqual(alone.calls.last, .stop)
    }

    /// The menu's tile opens the camera on its own engine, over the menu,
    /// as Telegram's: each shot lands at the grid's start picked, the
    /// first opens in the preview with the caption and send, back from it
    /// the camera shoots on and its counter opens the strip; closed, the
    /// grid has them picked. Send in the preview sends the picks.
    func testTheMenuCameraPutsItsShotsInTheGridPicked() async throws {
        let engine = FixtureCamera()
        AttachMenuEnvironment.cameraEngine = { engine }
        defer { AttachMenuEnvironment.cameraEngine = { CameraEnvironment.engine() } }
        let root = UIViewController()
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        let sheet = AttachSheetViewController(limit: 10, library: FixtureAttachLibrary(access: .authorized, count: 6), camera: true)
        var actions: [AttachSheetViewController.Action] = []
        sheet.onAction = { actions.append($0) }
        root.present(sheet, animated: false)
        try await wait { sheet.cameraTile.live }
        sheet.cameraTile.sendActions(for: .touchUpInside)
        let screen = try XCTUnwrap(sheet.presentedViewController as? CameraViewController)
        XCTAssertTrue(screen.camera === engine)
        XCTAssertTrue(sheet.cameraTile.lent)
        try await wait { screen.phase == .live }
        reset(screen)
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { screen.presentedViewController is AttachPreviewViewController }
        XCTAssertTrue(screen.review.isHidden, "no Retake or Use Photo")
        let first = try XCTUnwrap(sheet.edits.shotsTaken.first)
        XCTAssertEqual(sheet.picked, [first])
        let preview = try XCTUnwrap(screen.presentedViewController as? AttachPreviewViewController)
        try await wait { preview.shown }
        XCTAssertEqual(preview.shownNumber, 1)
        preview.close()
        try await wait { screen.presentedViewController == nil }

        try await wait { screen.phase == .live }
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { sheet.edits.shotsTaken.count == 2 && sheet.picked.count == 2 }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(screen.presentedViewController, "only the first shot opens")
        XCTAssertFalse(screen.shotsButton.isHidden)
        screen.shotsButton.sendActions(for: .touchUpInside)
        XCTAssertNotNil(screen.shotView(1))

        screen.closeButton.sendActions(for: .touchUpInside)
        try await wait { sheet.presentedViewController == nil }
        XCTAssertFalse(sheet.cameraTile.lent)
        XCTAssertTrue(actions.isEmpty, "the menu stays")
        try await wait { sheet.feed.count == 8 }
        XCTAssertEqual(sheet.library.item(at: 0)?.id, sheet.edits.shotsTaken.last)
        XCTAssertEqual(sheet.library.item(at: 1)?.id, first)

        // Sent from the preview: both shots, the menu gone with them.
        let picks = sheet.picked
        sheet.feed.onOpen?(1)
        let again = try XCTUnwrap(sheet.presentedViewController as? AttachPreviewViewController)
        try await wait { again.shown }
        let send = try XCTUnwrap(views(again.view).compactMap { $0 as? UIControl }.first { $0.accessibilityIdentifier == "attach-preview-send" })
        send.sendActions(for: .touchUpInside)
        try await wait { !actions.isEmpty }
        XCTAssertEqual(actions, [.send(picks, caption: "")])
        let read = await sheet.library.read(picks)
        XCTAssertEqual(read.count, 2)
    }

    /// The composer cuts a camera photo to its shape before it shrinks it:
    /// the drawn 540 × 960 picture as a square is 540 across.
    func testTheComposerCutsThePhotoToItsShape() throws {
        let files = FileManager.default.temporaryDirectory.appendingPathComponent("camera-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: files) }
        let staging = ComposerAttachmentStaging(filesDirectory: files)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(FixtureCamera.jpeg as CFData, nil))
        let square = try ComposerImageNormalizer.normalize(source, into: staging, ratio: 1)
        XCTAssertEqual(square.width, 540)
        XCTAssertEqual(square.height, 540)
        let wide = try ComposerImageNormalizer.normalize(source, into: staging, ratio: 16.0 / 9.0)
        XCTAssertEqual(wide.width, 540)
        XCTAssertEqual(wide.height, 960)
        staging.remove(square.fileURL)
        staging.remove(wide.fileURL)
    }

    /// With `HAPPY_PREVIEW_DIR` set: the camera with its grid and a lock,
    /// square, and the review, as `camera-*.png`.
    func testScreenshots() async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let camera = FixtureCamera()
        let screen = try await open(camera)
        reset(screen)
        let window = try XCTUnwrap(self.window)
        func keep(_ name: String) throws {
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("camera-\(name).png"))
        }
        screen.gridButton.sendActions(for: .touchUpInside)
        screen.focus(at: CGPoint(x: 140, y: 200), lock: true)
        try await Task.sleep(for: .milliseconds(1200))
        try keep("photo")
        screen.aspectButton.sendActions(for: .touchUpInside)
        screen.aspectButton.sendActions(for: .touchUpInside)
        try await Task.sleep(for: .milliseconds(400))
        try keep("square")
        screen.aspectButton.sendActions(for: .touchUpInside)
        screen.aspectButton.sendActions(for: .touchUpInside)
        try await Task.sleep(for: .milliseconds(400))
        try keep("wide")
        screen.shutter.sendActions(for: .touchUpInside)
        try await wait { !screen.review.isHidden }
        try await Task.sleep(for: .milliseconds(400))
        try keep("review")
        reset(screen)
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }
}
#endif
