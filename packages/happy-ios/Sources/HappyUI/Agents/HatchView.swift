#if canImport(UIKit)
import CoreHaptics
import HappyLayout
import UIKit

/// A seedling hatching into its picture, played over a mark once and then
/// gone: `Hatch`'s frames as Core Animation keyframes, so it runs on
/// the render server at the display's rate and the main thread does nothing
/// while it plays.
final class HatchView: UIView {
    private let membranes = CAShapeLayer()
    private let cores = CAShapeLayer()
    private let picture = CALayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(membranes)
        layer.addSublayer(cores)
        layer.addSublayer(picture)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Whether a hatch should play here now: the person can see it and
    /// asked for motion.
    static func canPlay(in view: UIView) -> Bool {
        guard !UIAccessibility.isReduceMotionEnabled, let window = view.window,
              window.windowScene?.activationState == .foregroundActive else { return false }
        let shown = view.convert(view.bounds, to: window)
        return window.bounds.intersects(shown) && !view.isHiddenInTree
    }

    /// Plays the hatch of `seed`'s cell into `image`, then removes itself.
    func play(seed: String, image: UIImage, done: @escaping () -> Void) {
        let size = bounds.width
        guard size > 0 else { done(); return }
        let resolved = traitCollection
        let membrane = UIColor(Palette.membrane).resolvedColor(with: resolved)
        let core = UIColor(Palette.core).resolvedColor(with: resolved)
        let tint = image.averageColor ?? membrane
        for shape in [membranes, cores] { shape.frame = bounds }
        picture.frame = bounds
        picture.contents = image.cgImage
        picture.contentsGravity = .resizeAspect
        picture.contentsScale = image.scale

        // Sixty keyframes a second, from the same frames the tests pin.
        let count = Int(Hatch.total * 60) + 1
        let times = (0..<count).map { Double($0) / Double(count - 1) }
        let frames = Hatch.frames(at: times.map { $0 * Hatch.total }, size: size, seed: seed)
        func path(_ frame: Hatch.Frame, scale: CGFloat) -> CGPath {
            let path = CGMutablePath()
            for cell in frame.cells {
                let r = cell.radius * scale
                path.addEllipse(in: CGRect(x: cell.center.x - r, y: cell.center.y - r, width: 2 * r, height: 2 * r))
            }
            return path
        }
        func keyframes(_ keyPath: String, _ values: [Any]) -> CAKeyframeAnimation {
            let animation = CAKeyframeAnimation(keyPath: keyPath)
            animation.values = values
            animation.keyTimes = times.map { NSNumber(value: $0) }
            animation.duration = Hatch.total
            animation.calculationMode = .linear
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
            return animation
        }
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            self?.removeFromSuperview()
            done()
        }
        membranes.fillColor = membrane.cgColor
        cores.fillColor = core.cgColor
        membranes.add(keyframes("path", frames.map { path($0, scale: 1) }), forKey: "hatch")
        membranes.add(keyframes("fillColor", frames.map { membrane.mixed(with: tint, $0.tint).cgColor }), forKey: "tint")
        membranes.add(keyframes("opacity", frames.map { NSNumber(value: Double($0.cellAlpha)) }), forKey: "fade")
        cores.add(keyframes("path", frames.map { path($0, scale: 0.42) }), forKey: "hatch")
        cores.add(keyframes("opacity", frames.map { NSNumber(value: Double($0.coreAlpha * $0.cellAlpha)) }), forKey: "fade")
        picture.add(keyframes("opacity", frames.map { NSNumber(value: Double($0.pictureAlpha)) }), forKey: "fade")
        picture.add(keyframes("transform.scale", frames.map { NSNumber(value: Double($0.pictureScale)) }), forKey: "grow")
        CATransaction.commit()
    }
}

/// The hatch's haptic: `Hatch.haptics` on Core Haptics, a
/// continuous wave whose intensity and sharpness follow the animation's
/// curves, with a tap at each cleavage and a crisp one where the picture
/// forms. One at a time, and only while the app is in front.
@MainActor
final class HatchHaptics {
    static let shared = HatchHaptics()

    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?
    private var playingUntil = Date.distantPast
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        })
    }

    /// Plays the hatch felt for a mark `size` across, unless another is playing.
    func play(size: CGFloat) {
        guard Date() >= playingUntil, UIApplication.shared.applicationState == .active else { return }
        let haptics = Hatch.haptics(size: size)
        playingUntil = Date().addingTimeInterval(Hatch.total)
        if CHHapticEngine.capabilitiesForHardware().supportsHaptics, let pattern = try? Self.pattern(haptics) {
            do {
                let engine = try self.engine ?? makeEngine()
                try engine.start()
                let player = try engine.makePlayer(with: pattern)
                try player.start(atTime: CHHapticTimeImmediate)
                self.player = player
                return
            } catch {}
        }
        // No Core Haptics: the taps alone, as impacts.
        for tap in haptics.taps {
            DispatchQueue.main.asyncAfter(deadline: .now() + tap.time) {
                let generator = UIImpactFeedbackGenerator(style: tap.sharpness > 0.7 ? .rigid : .soft)
                generator.impactOccurred(intensity: tap.intensity)
            }
        }
    }

    private func makeEngine() throws -> CHHapticEngine {
        let engine = try CHHapticEngine()
        engine.playsHapticsOnly = true
        engine.isAutoShutdownEnabled = true
        engine.resetHandler = { [weak self] in
            Task { @MainActor in self?.engine = nil }
        }
        engine.stoppedHandler = { [weak self] _ in
            Task { @MainActor in self?.player = nil }
        }
        self.engine = engine
        return engine
    }

    private func stop() {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop()
        playingUntil = .distantPast
    }

    /// The pattern: the wave as one continuous event whose curves are the
    /// samples (cut into curves of 16 points, Core Haptics' most), and the taps.
    static func pattern(_ haptics: Hatch.Haptics) throws -> CHHapticPattern {
        var events = [CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
            ],
            relativeTime: haptics.start,
            duration: haptics.duration
        )]
        for tap in haptics.taps {
            events.append(CHHapticEvent(
                eventType: .hapticTransient,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(tap.intensity)),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(tap.sharpness)),
                ],
                relativeTime: tap.time
            ))
        }
        func curves(_ id: CHHapticDynamicParameter.ID, _ samples: [(time: Double, value: Double)]) -> [CHHapticParameterCurve] {
            stride(from: 0, to: samples.count, by: 15).map { from in
                // Each curve starts where the last ended, so the wave never jumps.
                let slice = samples[from..<min(samples.count, from + 16)]
                let start = slice.first!.time
                return CHHapticParameterCurve(
                    parameterID: id,
                    controlPoints: slice.map { .init(relativeTime: $0.time - start, value: Float($0.value)) },
                    relativeTime: haptics.start + start
                )
            }
        }
        let parameters = curves(.hapticIntensityControl, haptics.intensity) + curves(.hapticSharpnessControl, haptics.sharpness)
        return try CHHapticPattern(events: events, parameterCurves: parameters)
    }
}

private extension UIView {
    var isHiddenInTree: Bool {
        var view: UIView? = self
        while let current = view {
            if current.isHidden || current.alpha < 0.01 { return true }
            view = current.superview
        }
        return false
    }
}

private extension UIColor {
    func mixed(with other: UIColor, _ t: CGFloat) -> UIColor {
        var (r1, g1, b1, a1, r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0, 0, 0, 0, 0)
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t, alpha: a1 + (a2 - a1) * t)
    }
}

private extension UIImage {
    /// The picture's colour on average, weighted by how opaque it is.
    var averageColor: UIColor? {
        guard let cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .medium
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        let alpha = CGFloat(pixel[3]) / 255
        guard alpha > 0 else { return nil }
        return UIColor(red: CGFloat(pixel[0]) / 255 / alpha, green: CGFloat(pixel[1]) / 255 / alpha, blue: CGFloat(pixel[2]) / 255 / alpha, alpha: 1)
    }
}
#endif
