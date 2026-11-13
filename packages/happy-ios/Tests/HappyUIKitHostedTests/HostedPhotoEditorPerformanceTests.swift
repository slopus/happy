#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A repeatable simulator workload through the editor's real input and
/// display paths. Numbers measure CPU input-to-submission, not panel latency.
@MainActor
final class HostedPhotoEditorPerformanceTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func tap(_ id: String, in view: UIView) {
        let control = views(view).compactMap { $0 as? UIControl }.first { $0.accessibilityIdentifier == id }
        XCTAssertNotNil(control, id)
        control?.sendActions(for: .touchUpInside)
    }

    private func time(_ name: String, _ body: () -> Void) {
        let start = CACurrentMediaTime()
        body()
        print("EDITOR_METRIC \(name) ms=\((CACurrentMediaTime() - start) * 1000)")
    }

    func testEditorWorkload() async throws {
        let root = UIViewController()
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let size = CGSize(width: 2048, height: 2048)
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            for x in stride(from: 0, to: 2048, by: 64) {
                UIColor(white: CGFloat(x) / 2048, alpha: 1).setFill()
                context.fill(CGRect(x: x, y: 0, width: 32, height: 2048))
            }
        }
        let strokes = (0..<24).map { n in
            PhotoStroke(tool: n % 4 == 0 ? .neon : .marker, color: RGBA(red: 0.2, green: 0.8, blue: 0.3), width: 40,
                        points: (0..<60).map { p in CGPoint(x: 100 + p * 30, y: 100 + n * 70 + p % 6 * 5) })
        }
        let edit = PhotoEdit(canvas: size, strokes: strokes)
        let draw = PhotoDrawViewController(picture: image, edit: edit)
        time("enter-draw-24-strokes") {
            root.present(draw, animated: false)
            draw.view.layoutIfNeeded()
        }
        let drawReady = CACurrentMediaTime()
        while draw.isPreparing { try await Task.sleep(for: .milliseconds(5)) }
        print("EDITOR_METRIC draw-background-ready ms=\((CACurrentMediaTime() - drawReady) * 1000)")
        for tool in [PhotoStroke.Tool.marker, .neon, .blur] {
            draw.select(tool)
            let probe = StrokeProbe(draw: draw)
            await probe.run()
            let sorted = probe.samples.sorted()
            let p50 = sorted[sorted.count / 2], p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
            print("EDITOR_METRIC stroke-\(tool) p50_ms=\(p50) p95_ms=\(p95) fps=\(probe.fps) longest_gap_ms=\(probe.longestGap * 1000)")
            time("commit-\(tool)") { draw.draw(CGPoint(x: 1900, y: 1300), phase: .ended) }
        }
        time("undo") { tap("photo-draw-undo", in: draw.view) }
        time("redo") { tap("photo-draw-redo", in: draw.view) }
        time("color-sheet") { tap("photo-draw-color", in: draw.view) }
        try await Task.sleep(for: .milliseconds(450))
        root.dismiss(animated: false)
        try await Task.sleep(for: .milliseconds(100))
        let library = AttachEditingLibrary(FixtureAttachLibrary(access: .authorized, count: 1))
        await withCheckedContinuation { continuation in library.load { continuation.resume() } }
        _ = library.commit()
        var thumbnailReady = false
        draw.onDone = { strokes in
            library.setEdit("fixture-0", PhotoEdit(canvas: size, strokes: strokes))
            _ = library.thumbnail(at: 0, pixels: CGSize(width: 1024, height: 1024)) { _ in thumbnailReady = true }
        }
        let gaps = EditorFrameProbe()
        gaps.start()
        try await Task.sleep(for: .milliseconds(50))
        let doneStart = CACurrentMediaTime()
        time("draw-done-ui") { tap("photo-draw-done", in: draw.view) }
        while !thumbnailReady { try await Task.sleep(for: .milliseconds(5)) }
        let ready = (CACurrentMediaTime() - doneStart) * 1000
        try await Task.sleep(for: .milliseconds(50))
        gaps.stop()
        print("EDITOR_METRIC done-thumbnail ready_ms=\(ready) longest_frame_ms=\(gaps.longest * 1000)")

        let crop = PhotoCropViewController(picture: image, edit: edit)
        time("enter-crop-24-strokes") {
            root.present(crop, animated: false)
            crop.view.layoutIfNeeded()
        }
        let cropReady = CACurrentMediaTime()
        while crop.isPreparing { try await Task.sleep(for: .milliseconds(5)) }
        print("EDITOR_METRIC crop-background-ready ms=\((CACurrentMediaTime() - cropReady) * 1000)")
        let wheel = try XCTUnwrap(views(crop.view).compactMap { $0 as? PhotoCropWheel }.first)
        wheel.onTouch?(true)
        var wheelTimes: [Double] = []
        for _ in 0..<60 {
            let start = CACurrentMediaTime()
            wheel.onDrag?(0.3)
            wheelTimes.append((CACurrentMediaTime() - start) * 1000)
            try await Task.sleep(for: .milliseconds(16))
        }
        wheel.onTouch?(false)
        let sorted = wheelTimes.sorted()
        print("EDITOR_METRIC crop-wheel p50_ms=\(sorted[30]) p95_ms=\(sorted[56])")
        let window = try XCTUnwrap(views(crop.view).first { $0.accessibilityIdentifier == "photo-crop-window" })
        let resize = CropPanProbe(point: CGPoint(x: window.frame.maxX - 2, y: window.frame.maxY - 2))
        measurePan("crop-resize", resize, in: crop)
        let pan = CropPanProbe(point: CGPoint(x: window.frame.midX, y: window.frame.midY))
        measurePan("crop-pan", pan, in: crop)
        let pinch = CropPinchProbe()
        pinch.state = .began
        crop.perform(NSSelectorFromString("pinched:"), with: pinch)
        time("crop-pinch-60-updates") {
            for _ in 0..<60 {
                pinch.state = .changed
                pinch.scale = 1.001
                crop.perform(NSSelectorFromString("pinched:"), with: pinch)
            }
        }
        pinch.state = .ended
        crop.perform(NSSelectorFromString("pinched:"), with: pinch)
        time("crop-mirror") { tap("photo-crop-mirror", in: crop.view) }
        time("crop-rotate") { tap("photo-crop-rotate", in: crop.view) }
        time("crop-done-callback") { tap("photo-crop-done", in: crop.view) }
        crop.dismiss(animated: false)
    }

    private func measurePan(_ name: String, _ pan: CropPanProbe, in crop: PhotoCropViewController) {
        pan.state = .began
        crop.perform(NSSelectorFromString("panned:"), with: pan)
        time(name + "-60-updates") {
            for n in 0..<60 {
                pan.delta = CGPoint(x: -CGFloat(n) * 0.3, y: -CGFloat(n) * 0.2)
                pan.state = .changed
                crop.perform(NSSelectorFromString("panned:"), with: pan)
            }
        }
        pan.state = .ended
        crop.perform(NSSelectorFromString("panned:"), with: pan)
    }
}

@MainActor
private final class EditorFrameProbe: NSObject {
    var longest: Double = 0
    private var last: Double?
    private var link: CADisplayLink?
    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }
    @objc private func tick() {
        let now = CACurrentMediaTime()
        if let last { longest = max(longest, now - last) }
        last = now
    }
    func stop() { link?.invalidate(); link = nil }
}

@MainActor
private final class CropPanProbe: UIPanGestureRecognizer {
    let point: CGPoint
    var delta = CGPoint.zero
    private var scripted: UIGestureRecognizer.State = .possible
    override var state: UIGestureRecognizer.State {
        get { scripted }
        set { scripted = newValue }
    }
    init(point: CGPoint) { self.point = point; super.init(target: nil, action: nil) }
    override func location(in view: UIView?) -> CGPoint { point }
    override func translation(in view: UIView?) -> CGPoint { delta }
    override func setTranslation(_ translation: CGPoint, in view: UIView?) { delta = translation }
}

@MainActor
private final class CropPinchProbe: UIPinchGestureRecognizer {
    private var scripted: UIGestureRecognizer.State = .possible
    override var state: UIGestureRecognizer.State {
        get { scripted }
        set { scripted = newValue }
    }
}

@MainActor
private final class StrokeProbe: NSObject {
    let draw: PhotoDrawViewController
    var samples: [Double] = []
    var longestGap: Double = 0
    private var first: Double = 0
    private var last: Double = 0
    private var link: CADisplayLink?
    private var continuation: CheckedContinuation<Void, Never>?
    var fps: Double { Double(max(0, samples.count - 1)) / max(0.001, last - first) }

    init(draw: PhotoDrawViewController) { self.draw = draw }

    func run() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            draw.draw(CGPoint(x: 100, y: 900), phase: .began)
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if samples.isEmpty { first = now } else { longestGap = max(longestGap, now - last) }
        last = now
        let n = samples.count
        let start = CACurrentMediaTime()
        let x = CGFloat(100 + n * 20)
        let y = CGFloat(900 + sin(Double(n) * 0.1) * 300)
        draw.draw(CGPoint(x: x, y: y), phase: .changed)
        draw.perform(NSSelectorFromString("frame"))
        samples.append((CACurrentMediaTime() - start) * 1000)
        if samples.count == 90 {
            link.invalidate()
            self.link = nil
            continuation?.resume()
            continuation = nil
        }
    }
}
#endif