import Foundation
import HappyCore
import XCTest

final class CameraSettingsTests: XCTestCase {
    func testTheButtonsCycleAsTheSystemCamerasDo() {
        XCTAssertEqual(CameraSettings.Flash.auto.next, .on)
        XCTAssertEqual(CameraSettings.Flash.on.next, .off)
        XCTAssertEqual(CameraSettings.Flash.off.next, .auto)
        XCTAssertEqual(CameraSettings.Timer.off.next, .three)
        XCTAssertEqual(CameraSettings.Timer.three.next, .ten)
        XCTAssertEqual(CameraSettings.Timer.ten.next, .off)
        XCTAssertEqual(CameraSettings.Timer.ten.seconds, 10)
        XCTAssertEqual(CameraSettings.Aspect.standard.next, .wide)
        XCTAssertEqual(CameraSettings.Aspect.wide.next, .square)
        XCTAssertEqual(CameraSettings.Aspect.square.next, .standard)
    }

    func testTheShapesRatios() {
        XCTAssertEqual(CameraSettings.Aspect.standard.ratio, 4.0 / 3.0)
        XCTAssertEqual(CameraSettings.Aspect.wide.ratio, 16.0 / 9.0)
        XCTAssertEqual(CameraSettings.Aspect.square.ratio, 1)
    }

    /// Both cameras ask the camera for its flash; the screen is lit by
    /// hand only for a front camera without one, on or in the dark when
    /// auto; video never flashes.
    func testWhichFlashAShotGets() {
        var settings = CameraSettings()
        XCTAssertEqual(settings.photoFlash, .auto)
        XCTAssertFalse(settings.screenFlash(cameraFlashes: false, darkScene: true))
        settings.front = true
        XCTAssertEqual(settings.photoFlash, .auto)
        XCTAssertFalse(settings.screenFlash(cameraFlashes: true, darkScene: true))
        XCTAssertTrue(settings.screenFlash(cameraFlashes: false, darkScene: true))
        XCTAssertFalse(settings.screenFlash(cameraFlashes: false, darkScene: false))
        settings.flash = .on
        XCTAssertTrue(settings.screenFlash(cameraFlashes: false, darkScene: false))
        settings.flash = .off
        XCTAssertFalse(settings.screenFlash(cameraFlashes: false, darkScene: true))
        settings = CameraSettings()
        settings.mode = .video
        XCTAssertEqual(settings.photoFlash, .off)
    }

    func testVideoIsWide() {
        var settings = CameraSettings()
        settings.aspect = .square
        XCTAssertEqual(settings.effectiveAspect, .square)
        settings.mode = .video
        XCTAssertEqual(settings.effectiveAspect, .wide)
    }

    /// An iPhone 15 Pro's sizes: 12 MP is enough for the composer's 3072,
    /// 48 MP would be thrown away; a camera with only smaller sizes gives
    /// its largest.
    func testThePhotoSizeIsTheSmallestThatFillsTheUpload() {
        let twelve = CameraPhotoSize.Dimensions(width: 4032, height: 3024)
        let fortyEight = CameraPhotoSize.Dimensions(width: 8064, height: 6048)
        let video = CameraPhotoSize.Dimensions(width: 1920, height: 1080)
        XCTAssertEqual(CameraPhotoSize.choose([fortyEight, twelve, video], longEdge: 3072), twelve)
        XCTAssertEqual(CameraPhotoSize.choose([video], longEdge: 3072), video)
        XCTAssertNil(CameraPhotoSize.choose([], longEdge: 3072))
    }

    /// The slider is the system camera's two stops each way, within the
    /// camera's own range.
    func testTheSliderSpansTwoStops() {
        XCTAssertEqual(CameraExposure.bias(slider: 0, min: -8, max: 8), 0)
        XCTAssertEqual(CameraExposure.bias(slider: 1, min: -8, max: 8), 2)
        XCTAssertEqual(CameraExposure.bias(slider: -0.5, min: -8, max: 8), -1)
        XCTAssertEqual(CameraExposure.bias(slider: 3, min: -8, max: 8), 2)
        XCTAssertEqual(CameraExposure.bias(slider: -1, min: -1.5, max: 1.5), -1.5)
    }

    /// Daylight, a lit room, a dark one, as a front camera at f/1.9 exposes them.
    func testHowDarkTheSceneIs() {
        XCTAssertEqual(CameraExposure.ev100(aperture: 1.9, duration: 1.0 / 4000, iso: 25), 15.8, accuracy: 0.1)
        XCTAssertFalse(CameraExposure.isDark(aperture: 1.9, duration: 1.0 / 60, iso: 200))
        XCTAssertTrue(CameraExposure.isDark(aperture: 1.9, duration: 1.0 / 30, iso: 1600))
        XCTAssertEqual(CameraExposure.ev100(aperture: 0, duration: 1, iso: 100), 0)
    }
}
