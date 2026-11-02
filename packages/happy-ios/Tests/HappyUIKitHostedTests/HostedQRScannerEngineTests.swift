#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The scanner over a stand-in engine: what it asks of the camera, and
/// what it shows for each thing the camera reports.
@MainActor
final class HostedQRScannerEngineTests: XCTestCase {
    private var window: UIWindow?
    private let video = CGSize(width: 1920, height: 1080)

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func show(_ camera: FixtureCamera) async throws -> QRScannerViewController {
        window?.isHidden = true
        let scanner = QRScannerViewController(camera: camera)
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: scanner)
        scanner.view.layoutIfNeeded()
        return scanner
    }

    private func visibleTexts(_ scanner: QRScannerViewController) -> [String] {
        scanner.view.subviews.compactMap { ($0 as? StyledLabel).flatMap { $0.isHidden ? nil : $0.string } }
    }

    private func areas(_ camera: FixtureCamera) -> [CGRect] {
        camera.calls.compactMap { call in
            if case .scanArea(let area) = call { area } else { nil }
        }
    }

    private func viewfinder(_ scanner: QRScannerViewController) throws -> CGRect {
        try XCTUnwrap(scanner.view.subviews.compactMap { $0 as? ScannerOverlayView }.first?.viewfinder)
    }

    func testItRunsTheQRModeAskingAndHandsOverItsViewfinder() async throws {
        let camera = FixtureCamera()
        let scanner = try await show(camera)
        XCTAssertEqual(camera.calls.first, .run(CameraConfiguration(mode: .qr), asking: true))
        let expected = QRScannerLayout.scanArea(viewfinder: try viewfinder(scanner), preview: camera.preview.bounds.size, video: video, rotation: 90)
        XCTAssertEqual(areas(camera).last, expected)
        XCTAssertEqual(visibleTexts(scanner), [Strings.Scanner.hint])
    }

    /// A turn of the device or the window changes the preview's rotation,
    /// and the area follows; a layout that changes nothing sends nothing.
    func testATurnHandsOverTheAreaAgain() async throws {
        let camera = FixtureCamera()
        let scanner = try await show(camera)
        let before = areas(camera).count
        scanner.view.setNeedsLayout()
        scanner.view.layoutIfNeeded()
        XCTAssertEqual(areas(camera).count, before)
        camera.report { $0.previewRotation = 0 }
        XCTAssertEqual(areas(camera).count, before + 1)
        XCTAssertEqual(areas(camera).last, QRScannerLayout.scanArea(viewfinder: try viewfinder(scanner), preview: camera.preview.bounds.size, video: video, rotation: 0))
    }

    func testRefusedShowsSettingsAndRestrictedSaysSo() async throws {
        let denied = try await show(FixtureCamera(availability: .denied))
        XCTAssertEqual(visibleTexts(denied), [Strings.Modals.cameraPermissionsRequiredToScanQr])
        let restricted = try await show(FixtureCamera(availability: .restricted))
        XCTAssertEqual(visibleTexts(restricted), [Strings.Camera.restricted])
        let none = try await show(FixtureCamera(availability: .noCamera))
        XCTAssertEqual(visibleTexts(none), [Strings.Scanner.unavailable])
    }

    func testAnInterruptionSaysWhyAndClearsWhenItEnds() async throws {
        let camera = FixtureCamera()
        let scanner = try await show(camera)
        camera.report { $0.interruption = .inUse }
        XCTAssertEqual(visibleTexts(scanner), [Strings.Camera.inUse])
        camera.report { $0.interruption = .systemPressure }
        XCTAssertEqual(visibleTexts(scanner), [Strings.Camera.systemPressure])
        camera.report { $0.interruption = nil }
        XCTAssertEqual(visibleTexts(scanner), [Strings.Scanner.hint])
    }

    func testACodeStopsTheCameraAndIsReported() async throws {
        let camera = FixtureCamera()
        let navigation = UINavigationController(rootViewController: UIViewController())
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        let scanner = QRScannerViewController(camera: camera)
        var read: String??
        scanner.onFinish = { read = $0 }
        navigation.present(scanner, animated: false)
        scanner.view.layoutIfNeeded()
        camera.read(["happy://terminal?x"])
        XCTAssertEqual(camera.calls.last, .stop)
        let deadline = ContinuousClock.now + .seconds(3)
        while read == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(read, .some("happy://terminal?x"))
    }
}
#endif
