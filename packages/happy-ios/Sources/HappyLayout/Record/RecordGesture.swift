import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The microphone's press, as Telegram's voice button reads it
/// (`TGModernConversationInputMicButton`): recording starts on the touch,
/// and where the finger goes decides how it ends.
///
///     ↑ 110 up while held, or let go 60 up: locked, hands-free
///     ← 150 left while held, or let go 100 left: cancelled
///     let go anywhere else: sent
///     let go within 0.19 s: a tap, which lands locked
///
/// A quick flick (400 points a second) up or left counts as getting there.
/// On release only the longer of the two directions counts, so a drag up
/// and a little left still locks.
public struct RecordGesture: Equatable, Sendable {
    public enum Metrics {
        /// Telegram's `modeTimeoutTimer`: a press let go sooner is a tap.
        public static let tapDuration: Double = 0.19
        /// A new press this soon after the last one is ignored.
        public static let repressInterval: Double = 0.4
        /// Left while held: cancelled at once.
        public static let cancelDistance: CGFloat = 150
        /// Left when let go: cancelled.
        public static let cancelReleaseDistance: CGFloat = 100
        /// Up while held: locked at once.
        public static let lockDistance: CGFloat = 110
        /// Up when let go: locked.
        public static let lockReleaseDistance: CGFloat = 60
        /// A release this fast up or left counts as the whole way.
        public static let flickVelocity: CGFloat = 400
        /// The circle shrinks over this much drag left, to `minScale`.
        public static let scaleDistance: CGFloat = 300
        public static let minScale: CGFloat = 0.4
        /// The lock closes over this much drag up.
        public static let locknessDistance: CGFloat = 105
    }

    public enum Outcome: Equatable, Sendable {
        /// Stop and use what was said.
        case send
        /// Stop and throw it away.
        case cancel
        /// Keep recording without the finger.
        case lock
    }

    /// When the press began, nil before one.
    public private(set) var began: Double?
    /// How far the finger is from where it went down, only up and left
    /// (both zero or less).
    public private(set) var translation: CGPoint = .zero
    public private(set) var isLocked = false

    public init() {}

    /// Whether a press at `time` starts a recording: not right after the
    /// last one began, as Telegram drops a double tap's second touch.
    public func accepts(at time: Double) -> Bool {
        guard let began else { return true }
        return abs(time - began) >= Metrics.repressInterval
    }

    public mutating func begin(at time: Double) {
        began = time
        translation = .zero
        isLocked = false
    }

    /// The finger moved; `offset` is from where it went down. A drag far
    /// enough left cancels and one far enough up locks, then and there.
    public mutating func move(_ offset: CGPoint) -> Outcome? {
        translation = CGPoint(x: min(0, offset.x), y: min(0, offset.y))
        if translation.x < -Metrics.cancelDistance { return .cancel }
        if translation.y < -Metrics.lockDistance {
            isLocked = true
            return .lock
        }
        return nil
    }

    /// The finger lifted at `time`, `offset` from where it went down and
    /// moving at `velocity`.
    public mutating func end(_ offset: CGPoint, velocity: CGPoint, at time: Double) -> Outcome {
        translation = .zero
        if let began, time - began < Metrics.tapDuration {
            isLocked = true
            return .lock
        }
        var x = min(0, offset.x)
        var y = min(0, offset.y)
        if abs(x) > abs(y) { y = 0 } else { x = 0 }
        if velocity.x < -Metrics.flickVelocity || x < -Metrics.cancelReleaseDistance { return .cancel }
        if velocity.y < -Metrics.flickVelocity || y < -Metrics.lockReleaseDistance {
            isLocked = true
            return .lock
        }
        return .send
    }

    /// The circle under the finger, smaller the further left it goes.
    public var scale: CGFloat {
        let progress = min(1, max(0, -translation.x / Metrics.scaleDistance))
        return max(Metrics.minScale, min(1, 1 - progress))
    }

    /// How closed the lock is, 0 to 1: it follows the finger up and stays
    /// shut once locked.
    public var lockness: CGFloat {
        isLocked ? 1 : min(1, abs(translation.y) / Metrics.locknessDistance)
    }

    /// How far left the finger is, zero or more: what the "slide to
    /// cancel" line moves by.
    public var cancelTranslation: CGFloat {
        -translation.x
    }
}
