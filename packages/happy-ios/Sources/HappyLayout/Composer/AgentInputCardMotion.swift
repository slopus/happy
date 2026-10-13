import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A horizontal shake: offsets at evenly spaced key times, each step eased
/// in and out.
public struct ComposerShake: Equatable, Sendable {
    /// translateX at each key time.
    public var values: [CGFloat]
    /// 0…1, one per value.
    public var keyTimes: [Double]
    /// Seconds.
    public var duration: Double

    public init(values: [CGFloat], keyTimes: [Double], duration: Double) {
        self.values = values
        self.keyTimes = keyTimes
        self.duration = duration
    }

    /// Steps of `step` seconds from rest through `offsets`.
    public init(offsets: [CGFloat], step: Double) {
        let steps = offsets.count
        values = [0] + offsets
        keyTimes = (0...steps).map { steps == 0 ? 0 : Double($0) / Double(steps) }
        duration = Double(steps) * step
    }

    /// Shaker.tsx's `shakeKeyframes`: 0, then `count` swings of
    /// `amplitude` alternating right and left (shrinking with `decay`), then 0.
    public static func shakerKeyframes(amplitude: CGFloat = 3, count: Int = 4, decay: Bool = false) -> [CGFloat] {
        var keyframes: [CGFloat] = [0]
        for index in 0..<max(0, count) {
            let sign: CGFloat = index % 2 == 0 ? 1 : -1
            let multiplier: CGFloat = decay ? 1 / CGFloat(index + 1) : 1
            keyframes.append(amplitude * sign * multiplier)
        }
        keyframes.append(0)
        return keyframes
    }

    /// Shaker.tsx: the keyframes in 300ms, a sixth each, from rest (so the
    /// first 50ms hold still). A refused send, a failed stop.
    public static let shaker = ComposerShake(offsets: shakerKeyframes(), step: 0.05)

    /// HomeDock.tsx `shakeOnce`: SHAKE_KEYFRAMES [3, -3, 3, -3, 0], 50ms
    /// each. Only the control that was pressed.
    public static let refusal = ComposerShake(offsets: [3, -3, 3, -3, 0], step: 0.05)
}

/// HomeDock.tsx's refusal flash on the primary button. Home drives
/// `amount` (0…1); the card scales the button and washes its fill.
public enum AgentInputPrimaryFlash {
    /// `scale: 1 + refusalFlash * 0.1`.
    public static func scale(_ amount: CGFloat) -> CGFloat {
        1 + max(0, amount) * 0.1
    }

    /// `opacity: refusalFlash * 0.55`, the wash under the glyph (stop only).
    public static func overlayAlpha(_ amount: CGFloat) -> CGFloat {
        min(1, max(0, amount) * 0.55)
    }
}

/// HomeDock.tsx's open animation for the focused card: the input (the
/// attachment strip and the text) rises in first, the action row after.
/// Transform and alpha only; nothing is laid out again.
public enum AgentInputCardReveal {
    /// `focusedInputRevealStyle`: 0.22…0.6 of the presentation, 8pt.
    public static let inputRange: ClosedRange<CGFloat> = 0.22...0.6
    public static let inputDistance: CGFloat = 8
    /// `focusedActionsRevealStyle`: 0.46…0.82, 7pt.
    public static let actionsRange: ClosedRange<CGFloat> = 0.46...0.82
    public static let actionsDistance: CGFloat = 7

    public static func input(progress: CGFloat) -> (alpha: CGFloat, offsetY: CGFloat) {
        reveal(progress, range: inputRange, distance: inputDistance)
    }

    public static func actions(progress: CGFloat) -> (alpha: CGFloat, offsetY: CGFloat) {
        reveal(progress, range: actionsRange, distance: actionsDistance)
    }

    /// `interpolate(progress, range, [0, 1], CLAMP)` as opacity, and
    /// `translateY: distance * (1 - reveal)`.
    static func reveal(_ progress: CGFloat, range: ClosedRange<CGFloat>, distance: CGFloat) -> (alpha: CGFloat, offsetY: CGFloat) {
        let span = range.upperBound - range.lowerBound
        let value = span > 0 ? (progress - range.lowerBound) / span : (progress >= range.upperBound ? 1 : 0)
        let reveal = min(1, max(0, value))
        return (reveal, distance * (1 - reveal))
    }
}
