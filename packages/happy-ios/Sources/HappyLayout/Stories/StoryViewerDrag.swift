import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A vertical drag on the viewer, as Telegram's `StoryItemSetContainerComponent`
/// follows one: down, the story goes with the finger one to one and shrinks
/// to 0.6 by a screen's height, the black behind it fading to half; let go
/// past 200, or a flick down past 5, it closes. Up, on one's own story, a
/// drag past 200 or a flick past 100 opens who has seen it.
public enum StoryViewerDrag {
    public enum Metrics {
        public static let minScale: CGFloat = 0.6
        /// The black behind at a full fraction, and never under.
        public static let groundFloor: CGFloat = 0.2
        public static let groundMin: CGFloat = 0.5
        public static let closeDistance: CGFloat = 200
        public static let closeFlickDistance: CGFloat = 5
        public static let closeFlickSpeed: CGFloat = 200
        public static let viewersDistance: CGFloat = 200
        public static let viewersFlickDistance: CGFloat = 100
        public static let viewersFlickSpeed: CGFloat = 100
    }

    public struct State: Equatable, Sendable {
        /// How far down the story sits, and its scale about its middle.
        public var offset: CGFloat
        public var scale: CGFloat
        /// The black behind it.
        public var groundAlpha: CGFloat
    }

    /// Where a drag of `translation` down puts the story on a screen `height` tall.
    public static func state(translation: CGFloat, height: CGFloat) -> State {
        let M = Metrics.self
        let fraction = max(0, min(1, translation / max(1, height)))
        let ground = (1 - fraction) + M.groundFloor * fraction
        return State(offset: fraction * height, scale: (1 - fraction) + M.minScale * fraction, groundAlpha: max(M.groundMin, min(1, ground)))
    }

    public enum Release: Equatable, Sendable { case close, viewers, stay }

    /// What letting go after `translation` at `velocity` (both down positive) does.
    public static func release(translation: CGFloat, velocity: CGFloat, canShowViewers: Bool) -> Release {
        let M = Metrics.self
        if translation > M.closeDistance || (translation > M.closeFlickDistance && velocity > M.closeFlickSpeed) { return .close }
        if canShowViewers, translation < -M.viewersDistance || (translation < -M.viewersFlickDistance && velocity < -M.viewersFlickSpeed) { return .viewers }
        return .stay
    }
}
