import Foundation
import HappyCore
import XCTest

/// The lens buttons and zooms of the cameras Happy runs on, as the system
/// camera shows them on each.
final class CameraLensesTests: XCTestCase {
    /// iPhone 15 Pro Max: ultra wide, wide (48 MP, 2× crop), 5× telephoto.
    private let proMax = CameraLenses(hasUltraWide: true, switchOvers: [2, 10], secondaryNative: [4], minZoom: 1, maxZoom: 123.75)
    /// iPhone 13 Pro to 15 Pro: a 3× telephoto, no crop.
    private let pro = CameraLenses(hasUltraWide: true, switchOvers: [2, 6], minZoom: 1, maxZoom: 123.75)
    /// iPhone 13: ultra wide and wide.
    private let dualWide = CameraLenses(hasUltraWide: true, switchOvers: [2], minZoom: 1, maxZoom: 95.6)
    /// iPhone XS: wide and a 2× telephoto.
    private let dual = CameraLenses(switchOvers: [2], minZoom: 1, maxZoom: 16)
    /// iPhone SE, iPad Pro M4, a front camera.
    private let wide = CameraLenses(minZoom: 1, maxZoom: 16)

    func testTheButtonsAreTheSystemCamerasOnEveryDevice() {
        XCTAssertEqual(proMax.displayStops, [0.5, 1, 2, 5])
        XCTAssertEqual(pro.displayStops, [0.5, 1, 3])
        XCTAssertEqual(dualWide.displayStops, [0.5, 1])
        XCTAssertEqual(dual.displayStops, [1, 2])
        XCTAssertEqual(wide.displayStops, [1])
    }

    /// 1× is the wide camera, at the first switch-over when there is an
    /// ultra wide below it.
    func testOneIsTheWideCamera() {
        XCTAssertEqual(proMax.wideZoom, 2)
        XCTAssertEqual(proMax.device(1), 2)
        XCTAssertEqual(proMax.display(10), 5)
        XCTAssertEqual(dual.wideZoom, 1)
        XCTAssertEqual(wide.device(1), 1)
    }

    /// The pinch goes five times past the longest lens, as far as the
    /// device does: 25× with a 5×, 15× with a 3×, 5× with the wide alone.
    func testThePinchStopsWhereTheSystemCamerasDoes() {
        XCTAssertEqual(proMax.display(proMax.maxZoom), 25)
        XCTAssertEqual(pro.display(pro.maxZoom), 15)
        XCTAssertEqual(wide.display(wide.maxZoom), 5)
        XCTAssertEqual(dual.display(dual.maxZoom), 10)
        XCTAssertEqual(proMax.pinched(from: 2, scale: 100), proMax.maxZoom)
        XCTAssertEqual(proMax.pinched(from: 2, scale: 0.01), 1)
        XCTAssertEqual(proMax.pinched(from: 2, scale: 1.5), 3)
        XCTAssertEqual(proMax.pinched(from: 2, scale: .nan), 2)
        XCTAssertEqual(proMax.device(0.1), 1)
    }

    func testTheZoomFallsUnderTheLongestLensAtOrBelowIt() {
        XCTAssertEqual(proMax.stop(for: 1), 0)
        XCTAssertEqual(proMax.stop(for: 1.9), 0)
        XCTAssertEqual(proMax.stop(for: 2), 1)
        XCTAssertEqual(proMax.stop(for: 3.99), 1)
        XCTAssertEqual(proMax.stop(for: 4), 2)
        XCTAssertEqual(proMax.stop(for: 50), 3)
        XCTAssertEqual(wide.stop(for: 3), 0)
    }

    /// A crop beside a lens of about its reach is not a second button.
    func testACropBesideALensIsThatLens() {
        let lenses = CameraLenses(hasUltraWide: true, switchOvers: [2, 6], secondaryNative: [6.2, 4], minZoom: 1, maxZoom: 100)
        XCTAssertEqual(lenses.displayStops, [0.5, 1, 2, 3])
    }

    func testLabelsAreTheSystemCamerasWords() {
        XCTAssertEqual(CameraLenses.label(0.5, selected: false), ".5")
        XCTAssertEqual(CameraLenses.label(0.5, selected: true), ".5×")
        XCTAssertEqual(CameraLenses.label(1, selected: true), "1×")
        XCTAssertEqual(CameraLenses.label(2, selected: false), "2")
        XCTAssertEqual(CameraLenses.label(1.43, selected: true), "1.4×")
        XCTAssertEqual(CameraLenses.label(24.96, selected: true), "25×")
    }

    func testBeforeTheDeviceIsKnownThereIsOneLens() {
        XCTAssertEqual(CameraLenses.single.displayStops, [1])
        XCTAssertEqual(CameraLenses.single.device(3), 1)
    }

    func testWarmthBringsTheFrameRateDownThenTheResolution() {
        XCTAssertEqual(CameraThermal.nominal.frameRate(60), 60)
        XCTAssertEqual(CameraThermal.fair.frameRate(60), 60)
        XCTAssertEqual(CameraThermal.serious.frameRate(60), 30)
        XCTAssertEqual(CameraThermal.serious.frameRate(24), 24)
        XCTAssertEqual(CameraThermal.critical.frameRate(60), 24)
        XCTAssertFalse(CameraThermal.serious.limitsResolution)
        XCTAssertTrue(CameraThermal.critical.limitsResolution)
    }
}
