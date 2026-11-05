#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest

/// A feed post's moving cover (`CoverAnimation`): an animated WebP or GIF
/// moves when its decoder says it has more than one frame, plays at its
/// file's delays and loop count with frames decoded at the size drawn,
/// only in a window, and stands on its first frame under Reduce Motion.
@MainActor
final class CoverAnimationTests: XCTestCase {
    override func tearDown() {
        CoverAnimation.reduceMotion = { UIAccessibility.isReduceMotionEnabled }
        super.tearDown()
    }

    /// An animated GIF made here, `frames` solid colours of `size`.
    static func gif(frames: Int, delay: Double, loops: Int, size: CGSize = CGSize(width: 320, height: 180)) -> Data {
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, frames, nil)!
        CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: loops]] as CFDictionary)
        let colors: [UIColor] = [.systemRed, .systemGreen, .systemBlue, .systemOrange]
        for index in 0..<frames {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
                colors[index % colors.count].setFill()
                context.fill(CGRect(origin: .zero, size: size))
            }
            CGImageDestinationAddImage(destination, image.cgImage!, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func webp() throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "moving", withExtension: "webp"), "the fixture is in the bundle")
        return try Data(contentsOf: url)
    }

    private func source(_ data: Data) throws -> CGImageSource {
        try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
    }

    func testTheDecoderSaysWhetherItMoves() throws {
        XCTAssertTrue(CoverAnimation.moves(Self.gif(frames: 3, delay: 0.1, loops: 0)))
        XCTAssertTrue(CoverAnimation.moves(try webp()))
        let still = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 16, height: 9)).image { _ in }.pngData())
        XCTAssertFalse(CoverAnimation.moves(still))
        XCTAssertFalse(CoverAnimation.moves(Self.gif(frames: 1, delay: 0.1, loops: 0)), "a GIF of one frame stays still")
        XCTAssertNil(CoverAnimation(data: still, pixels: 100, view: UIImageView()))
        XCTAssertNil(CoverAnimation.timing(try source(still)))
    }

    /// Each frame's delay and the loop count, from the WebP or the GIF;
    /// a delay under 20 ms is 100, as browsers play it.
    func testTheFilesTiming() throws {
        let webp = try XCTUnwrap(CoverAnimation.timing(try source(try webp())))
        XCTAssertEqual(webp.delays.count, 10)
        XCTAssertEqual(webp.loops, 3)
        for delay in webp.delays { XCTAssertEqual(delay, 0.1, accuracy: 0.001) }

        let gif = try XCTUnwrap(CoverAnimation.timing(try source(Self.gif(frames: 4, delay: 0.25, loops: 0))))
        XCTAssertEqual(gif.delays, [0.25, 0.25, 0.25, 0.25])
        XCTAssertEqual(gif.loops, 0, "for ever")
        let fast = try XCTUnwrap(CoverAnimation.timing(try source(Self.gif(frames: 2, delay: 0.01, loops: 1))))
        XCTAssertEqual(fast.delays, [0.1, 0.1])
    }

    private func window(_ view: UIView) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 320))
        window.addSubview(view)
        window.isHidden = false
        addTeardownBlock { window.isHidden = true }
        return window
    }

    private func wait(_ what: String, _ done: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !done() {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// In a window it plays, each frame decoded no larger than drawn; out
    /// of one it holds its frame; back in, it goes on.
    func testItPlaysOnlyInAWindowAtTheSizeDrawn() async throws {
        let view = UIImageView(frame: CGRect(x: 0, y: 0, width: 160, height: 90))
        view.image = UIImage(named: "none")
        let window = window(view)
        let animation = try XCTUnwrap(CoverAnimation(data: Self.gif(frames: 4, delay: 0.05, loops: 0), pixels: 64, view: view))
        XCTAssertTrue(animation.playing)
        try await wait("frames") { animation.advanced >= 3 }
        let frame = try XCTUnwrap(view.image?.cgImage)
        XCTAssertLessThanOrEqual(max(frame.width, frame.height), 64, "decoded at the size drawn, never whole")

        view.removeFromSuperview()
        animation.update()
        XCTAssertFalse(animation.playing)
        let held = animation.advanced
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(animation.advanced, held, "out of the window it holds its frame")

        window.addSubview(view)
        animation.update()
        try await wait("frames again") { animation.advanced > held + 2 }

        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertFalse(animation.playing, "in the background it rests")
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertTrue(animation.playing)
    }

    /// It plays its loop count, then rests on its last frame.
    func testItStopsAfterItsLoops() async throws {
        let view = UIImageView(frame: CGRect(x: 0, y: 0, width: 160, height: 90))
        _ = window(view)
        let animation = try XCTUnwrap(CoverAnimation(data: Self.gif(frames: 3, delay: 0.03, loops: 2), pixels: 64, view: view))
        try await wait("its loops") { !animation.playing }
        XCTAssertEqual(animation.index, 2)
        XCTAssertEqual(animation.advanced, 5, "two loops of three frames, from the first")
    }

    /// Under Reduce Motion: the first frame, the still it was read as.
    func testReduceMotionShowsTheFirstFrame() async throws {
        let view = UIImageView(frame: CGRect(x: 0, y: 0, width: 160, height: 90))
        let first = UIImage()
        view.image = first
        _ = window(view)
        let animation = try XCTUnwrap(CoverAnimation(data: Self.gif(frames: 4, delay: 0.03, loops: 0), pixels: 64, view: view))
        try await wait("a frame") { animation.advanced >= 2 }
        CoverAnimation.reduceMotion = { true }
        NotificationCenter.default.post(name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
        XCTAssertFalse(animation.playing)
        XCTAssertEqual(animation.index, 0)
        XCTAssertTrue(view.image === first)
        let held = animation.advanced
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(animation.advanced, held)

        CoverAnimation.reduceMotion = { false }
        NotificationCenter.default.post(name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
        XCTAssertTrue(animation.playing)
    }
}
#endif
