import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Going back by dragging a pushed screen to the right, from anywhere on
/// it, as Telegram's navigation does (its techniques, none of its code):
/// when the drag starts, when it goes back, and where everything is on
/// the way. The navigation stack applies these; nothing here touches UIKit.
///
/// Telegram's references are `submodules/Display/Source/` in Telegram-iOS
/// (f1dd7a2dbd): `InteractiveTransitionGestureRecognizer.swift` (ITGR),
/// `Navigation/NavigationContainer.swift` (NC) and
/// `NavigationTransitionCoordinator.swift` (NTC).
public enum SwipeBack {
    /// The thresholds, all in one place to tune on a device. They are
    /// deliberately stricter than Telegram's, so a scroll or a tap that
    /// drifts sideways doesn't go back by accident: each names Telegram's
    /// value and where it is.
    public enum Metrics {
        /// A touch this close to the left edge always may go back, even on
        /// content that scrolls sideways. Telegram: 16 (ITGR:71).
        public static let edgeWidth: CGFloat = 16
        /// A drag this far to the right, at least twice as far as it went
        /// down, starts going back. Telegram: 2 (ITGR:199). Ours: 8.
        public static let horizontalSlop: CGFloat = 8
        /// A drag this far down, at least twice as far as it went
        /// sideways, is a scroll: going back is out. Telegram's: 2
        /// (ITGR:197), kept, so scrolling never waits.
        public static let verticalSlop: CGFloat = 2
        /// How much the drag's main direction must outweigh the other.
        /// Telegram: 2 (ITGR:197, :199).
        public static let dominance: CGFloat = 2
        /// Past this distance the main direction decides on its own.
        /// Telegram: 10 (ITGR:189). Ours: 18.
        public static let decideDistance: CGFloat = 18
        /// From the edge, a drag this far right starts going back.
        /// Telegram leaves it to UIKit's pan (ITGR:179, :208). Ours: 8.
        public static let edgeSlop: CGFloat = 8
        /// The finger must be moving right at least this fast (points a
        /// second) as it starts. Telegram: 4 (NC:186). Ours: 20.
        public static let minimumVelocity: CGFloat = 20
        /// Starting with a mostly vertical velocity faster than this is a
        /// scroll. Telegram: 4, outweighing sideways 2.5 times (NC:183).
        public static let verticalVelocity: CGFloat = 4
        public static let verticalVelocityDominance: CGFloat = 2.5
        /// Let go past this much of the width, it goes back.
        /// Telegram: 0.2 (NC:285). Ours: 0.33.
        public static let completeProgress: CGFloat = 0.33
        /// Or let go flicked right faster than this (points a second).
        /// Telegram: 1000 (NC:285). Ours: 1300.
        public static let completeVelocity: CGFloat = 1300
        /// The screen under it moves 30% of the width (NTC:161), and is
        /// dimmed 15% at the start (NTC:175); the shadow at the moving
        /// screen's edge is 16 wide (NTC:10) at 0.9 at the start (NTC:176).
        public static let parallax: CGFloat = 0.3
        public static let dim: CGFloat = 0.15
        public static let shadowWidth: CGFloat = 16
        public static let shadow: CGFloat = 0.9
        /// Going on to the end takes the rest of the width at the finger's
        /// speed, between 0.05 and 0.2 s, ease in-out (NTC:333); with no
        /// speed, a 0.5 s spring (NTC:329). Going back to where it was
        /// takes 0.1 s, ease in-out (NTC:236).
        public static let finishMin: Double = 0.05
        public static let finishMax: Double = 0.2
        public static let finishResting: Double = 0.5
        public static let cancelDuration: Double = 0.1
    }

    /// What a drag so far means.
    public enum Decision: Equatable, Sendable {
        /// Not yet: wait for more of it.
        case undecided
        /// It goes back: the screen follows the finger from here.
        case begin
        /// It is something else (a scroll, a swipe left): leave it be.
        case fail
    }

    /// Whether going back may start for a touch at `startX` on a screen
    /// `width` wide. `edgeOnly`: the touch is on something that drags
    /// sideways itself (ITGR:114-116), so only the left edge goes back.
    public static func allows(startX: CGFloat, width: CGFloat, edgeOnly: Bool) -> Bool {
        if startX < Metrics.edgeWidth { return true }
        return !edgeOnly
    }

    /// The drag from `startX` moved `translation` (right and down
    /// positive) on a screen `width` wide (ITGR:161-203).
    public static func decide(startX: CGFloat, width: CGFloat, translation: CGPoint, edgeOnly: Bool) -> Decision {
        let x = abs(translation.x)
        let y = abs(translation.y)
        if startX < Metrics.edgeWidth {
            // From the edge: only which way it goes matters.
            if translation.x < 0 { return .fail }
            return translation.x >= Metrics.edgeSlop ? .begin : .undecided
        }
        if edgeOnly { return translation == .zero ? .undecided : .fail }
        // Left is never back.
        if translation.x < 0 { return .fail }
        if (x * x + y * y).squareRoot() > Metrics.decideDistance {
            return x >= y ? .begin : .fail
        }
        if y > Metrics.verticalSlop, y > x * Metrics.dominance { return .fail }
        if x > Metrics.horizontalSlop, y * Metrics.dominance < x { return .begin }
        return .undecided
    }

    /// Whether a drag that has decided to go back may, given the finger's
    /// velocity as it does (NC:180-192).
    public static func shouldBegin(velocity: CGPoint) -> Bool {
        if abs(velocity.y) > Metrics.verticalVelocity, abs(velocity.y) > abs(velocity.x) * Metrics.verticalVelocityDominance { return false }
        return velocity.x >= Metrics.minimumVelocity
    }

    /// How far back it is, 0 to 1, from how far right the finger went (NC:278).
    public static func progress(translation: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 0 }
        return max(0, min(1, translation / width))
    }

    /// Let go at `progress` moving right at `velocity`: back, or not (NC:285).
    public static func completes(progress: CGFloat, velocity: CGFloat) -> Bool {
        velocity > Metrics.completeVelocity || progress > Metrics.completeProgress
    }

    /// How long going on to the end takes from `progress` at `velocity`
    /// (NTC:328-335).
    public static func finishDuration(progress: CGFloat, width: CGFloat, velocity: CGFloat) -> Double {
        if abs(velocity) < .ulpOfOne, abs(progress) < .ulpOfOne { return Metrics.finishResting }
        let distance = (1 - progress) * width
        guard abs(velocity) > .ulpOfOne else { return Metrics.finishMax }
        return max(Metrics.finishMin, min(Metrics.finishMax, Double(abs(distance / velocity))))
    }

    /// Where the two screens are at `progress` (NTC:141-176).
    public struct Frames: Equatable, Sendable {
        /// The leaving screen's left edge, on the screen's pixels.
        public var topX: CGFloat
        /// The screen under it, coming back from the left.
        public var bottomX: CGFloat
        /// Black over the screen under it.
        public var dimAlpha: CGFloat
        /// The shadow along the leaving screen's left edge, `shadowWidth`
        /// wide, ending at `topX`.
        public var shadowAlpha: CGFloat

        public init(topX: CGFloat, bottomX: CGFloat, dimAlpha: CGFloat, shadowAlpha: CGFloat) {
            self.topX = topX
            self.bottomX = bottomX
            self.dimAlpha = dimAlpha
            self.shadowAlpha = shadowAlpha
        }
    }

    public static func frames(progress: CGFloat, width: CGFloat, scale: CGFloat) -> Frames {
        let p = max(0, min(1, progress))
        let scale = scale > 0 ? scale : 1
        return Frames(
            topX: (p * width * scale).rounded(.down) / scale,
            bottomX: (p - 1) * width * Metrics.parallax,
            dimAlpha: (1 - p) * Metrics.dim,
            shadowAlpha: (1 - p) * Metrics.shadow
        )
    }
}
