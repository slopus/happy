import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where the viewer starts as it opens from what was tapped, and ends as it
/// closes back into it, as Telegram's does (`StoryItemSetContainerComponent`
/// `animateIn` / `animateOut`): the story shows through a window that is
/// the source itself, a circle for a row's avatar, its picture as wide as
/// that window and hung from its top; the author's avatar sits on the
/// source. All of it springs to its place together.
///
///     start    ( ⦿ )  the source, the picture's top in it
///     end      ┌───────┐ the canvas, 12 rounded
///              │ ⦿ name│
///              │       │
///              └───────┘
public struct StoryOpeningLayout: Equatable, Sendable {
    public enum Metrics {
        /// Telegram's `kCAMediaTimingFunctionSpring` at any length but 0.5
        /// (and iOS 26's 0.3832): cubic-bezier(0.38, 0.7, 0.125, 1), here
        /// over 0.3 s.
        public static let duration: Double = 0.3
        public static let curve: (CGPoint, CGPoint) = (CGPoint(x: 0.38, y: 0.7), CGPoint(x: 0.125, y: 1))
        /// The ground fades in over 0.28 and out over 0.25, eased; the
        /// controls over the story over 0.25.
        public static let groundIn: Double = 0.28
        public static let groundOut: Double = 0.25
        public static let controlsFade: Double = 0.25
        /// The bar under the story rises from below the screen, more
        /// slowly opening, as Telegram's input panel does.
        public static let barIn: Double = 0.48
        public static let barOut: Double = 0.3
    }

    /// A view's place against where it is laid out: scaled about its middle,
    /// then moved.
    public struct Placement: Equatable, Sendable {
        public var scale: CGFloat
        public var offset: CGPoint

        public init(scale: CGFloat, offset: CGPoint) {
            self.scale = scale
            self.offset = offset
        }

        public static let identity = Placement(scale: 1, offset: .zero)

        /// What puts a view laid out at `from` on `to`, by width.
        public init(from: CGRect, to: CGRect) {
            scale = from.width > 0 ? to.width / from.width : 1
            offset = CGPoint(x: to.midX - from.midX, y: to.midY - from.midY)
        }
    }

    /// The window the story shows through at the start, and its corners.
    public let window: CGRect
    public let windowRadius: CGFloat
    /// The canvas at the start: as wide as the window, from its top.
    public let canvas: Placement
    /// The author's avatar at the start: on the source when that is their
    /// avatar (Telegram's `sourceIsAvatar`); otherwise it fades with the
    /// controls.
    public let avatar: Placement?
    /// How far the bar under the story starts below where it ends.
    public let barDrop: CGFloat

    /// From `source` (the tapped avatar, or a card), rounded `sourceRadius`,
    /// into `viewer`'s layout of a screen `height` tall.
    public init(source: CGRect, sourceRadius: CGFloat, sourceIsAvatar: Bool, viewer: StoryViewerLayout, height: CGFloat) {
        window = source
        windowRadius = min(sourceRadius, min(source.width, source.height) / 2)
        let canvas = viewer.canvas
        let scale = canvas.width > 0 ? source.width / canvas.width : 1
        let start = CGRect(x: source.minX, y: source.minY, width: source.width, height: canvas.height * scale)
        self.canvas = Placement(from: canvas, to: start)
        avatar = sourceIsAvatar ? Placement(from: viewer.avatar, to: source) : nil
        barDrop = max(0, height - viewer.heart.minY)
    }
}
