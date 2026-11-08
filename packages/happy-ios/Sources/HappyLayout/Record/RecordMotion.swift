import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// What the recording circles do each frame (Telegram's
/// `displayLinkUpdate`): the voice's level and the finger's drag are
/// followed with a lag, so the pulse breathes rather than flickers and the
/// circle trails the finger a little.
///
/// Telegram steps once per 60 Hz frame; `frames` is how many of those a
/// tick spans, so a 120 Hz screen moves the same over the same time.
public struct RecordMotion: Equatable, Sendable {
    public enum Metrics {
        /// The blue circle under the finger.
        public static let innerDiameter: CGFloat = 110
        /// How much of the last level each 60 Hz frame keeps.
        public static let levelKeep: CGFloat = 0.9
        /// How much of the last drag each 60 Hz frame keeps.
        public static let dragKeep: CGFloat = 0.7
        /// The circles' appearing spring (`animateIn`): 0.5 s, damping 0.55.
        public static let springDuration: Double = 0.5
        public static let springDamping: CGFloat = 0.55
        /// The circles start this small and this faint, and grow in.
        public static let appearScale: CGFloat = 0.2
        /// Their fade in, and the button's glyph out.
        public static let appearFade: Double = 0.1
        /// Going away (`animateOut`).
        public static let disappearDuration: Double = 0.18
        /// The lock panel rises this far into place.
        public static let lockRise: CGFloat = 100
        /// The bar growing out of the button (`barGrowth`): a spring with
        /// no overshoot, so it never runs past the bar's leading edge.
        public static let barDuration: Double = 0.4
        public static let barDamping: CGFloat = 1
        /// And back into it, the same spring a little quicker.
        public static let barShrinkDuration: Double = 0.3
        /// A cancel (`ChatTextInputPanelNode`'s `recordingToAttachButton`):
        /// the bar's clock shrinks to half as it fades, "Slide to cancel"
        /// fades over `cancelFade`, and the dot's bin travels to the icon
        /// it stands in for on the panel's spring, `binTravel`.
        public static let cancelClockScale: CGFloat = 0.5
        public static let cancelFade: Double = 0.25
        public static let binTravel: Double = 0.4
        public static let binDamping: CGFloat = 0.9
        /// Once the bin has shut, it shrinks away as the icon grows back.
        public static let binOut: Double = 0.2
        /// What the bin and the icon shrink to and grow from.
        public static let binOutScale: CGFloat = 0.001
    }

    /// The level shown, 0 to 1.
    public private(set) var level: CGFloat = 0
    /// The circle's lift, zero or less (up).
    public private(set) var lift: CGFloat = 0
    /// The circle's slide, zero or less (left).
    public private(set) var slide: CGFloat = 0

    public init() {}

    /// One tick toward the targets.
    public mutating func step(level target: CGFloat, lift liftTarget: CGFloat, slide slideTarget: CGFloat, frames: CGFloat = 1) {
        let frames = max(0, frames)
        let levelKeep = pow(Metrics.levelKeep, frames)
        let dragKeep = pow(Metrics.dragKeep, frames)
        level = level * levelKeep + min(1, max(0, target)) * (1 - levelKeep)
        lift = min(0, lift * dragKeep + liftTarget * (1 - dragKeep))
        slide = min(0, slide * dragKeep + slideTarget * (1 - dragKeep))
    }

    /// The appearing spring `elapsed` seconds in: UIKit's spring of
    /// `springDuration` and `springDamping` (natural frequency 2π over the
    /// duration), from 0 to 1 with Telegram's overshoot. Driven per frame
    /// with the drag rather than as a UIView animation, so a finger moving
    /// during the spring never makes the circle jump when it ends.
    public static func appear(at elapsed: Double) -> CGFloat {
        spring(at: elapsed, duration: Metrics.springDuration, damping: Metrics.springDamping)
    }

    /// The bar stretching out of the button `elapsed` seconds in, 0 to 1:
    /// UIKit's spring of `barDuration`, critically damped. Stepped with
    /// the circles, so the bar and what is in it move as one.
    public static func barGrowth(at elapsed: Double) -> CGFloat {
        min(1, spring(at: elapsed, duration: Metrics.barDuration, damping: Metrics.barDamping))
    }

    /// UIKit's spring (`usingSpringWithDamping`) from 0 to 1: natural
    /// frequency 2π over `duration`.
    private static func spring(at elapsed: Double, duration: Double, damping: CGFloat) -> CGFloat {
        guard elapsed > 0 else { return 0 }
        let omega = 2 * Double.pi / duration
        let zeta = Double(damping)
        let envelope = exp(-zeta * omega * elapsed)
        guard zeta < 1 else { return CGFloat(1 - envelope * (1 + omega * elapsed)) }
        let damped = omega * (1 - zeta * zeta).squareRoot()
        return CGFloat(1 - envelope * (cos(damped * elapsed) + zeta * omega / damped * sin(damped * elapsed)))
    }

    /// Whether the spring has settled, to within a hundredth for good.
    public static func appearSettled(at elapsed: Double) -> Bool {
        let omega = 2 * Double.pi / Metrics.springDuration
        return exp(-Double(Metrics.springDamping) * omega * elapsed) * 1.5 < 0.01
    }

    /// The circles' and the glyph's fade in, linear over `appearFade`
    /// from Telegram's 0.2.
    public static func appearAlpha(at elapsed: Double) -> CGFloat {
        let t = min(1, max(0, elapsed / Metrics.appearFade))
        return Metrics.appearScale + (1 - Metrics.appearScale) * CGFloat(t)
    }

    /// The lock closing on its own (`animateLock`): 0.2 s ease in and out
    /// from wherever the finger left it.
    public static let lockDuration: Double = 0.2

    public static func lockness(from start: CGFloat, at elapsed: Double) -> CGFloat {
        let t = min(1, max(0, elapsed / lockDuration))
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        return start + (1 - start) * CGFloat(eased)
    }

    /// A microphone buffer's loudness, as its RMS amplitude, on the 0 to 1
    /// the waves read: -50 dB is silence and 0 dB the loudest.
    public static func level(rms: Float) -> CGFloat {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(Double(rms))
        return CGFloat(min(1, max(0, (decibels + 50) / 50)))
    }
}

/// The recording's clock as Telegram shows it: minutes, seconds and
/// hundredths, "0:02,54", with hours in front past the hour.
public enum RecordClock {
    public static func text(_ seconds: Double) -> String {
        let seconds = max(0, seconds)
        let whole = Int(seconds)
        let hundredths = Int(seconds * 100) % 100
        if whole >= 3600 {
            return String(format: "%d:%02d:%02d,%02d", whole / 3600, whole / 60 % 60, whole % 60, hundredths)
        }
        return String(format: "%d:%02d,%02d", whole / 60, whole % 60, hundredths)
    }

    /// The widest the clock gets under an hour, to measure once: its
    /// digits are tabular, so the line never jitters as it runs.
    public static let widest = "00:00,00"
}
