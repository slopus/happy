import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// What covers the chat list at each end, for its scroll indicator, which
/// runs only where messages show (`ChatScreenLayout`). Telegram keeps these
/// apart from the content insets too: those add the list's own padding.
public struct ChatIndicatorInsets: Equatable, Sendable {
    /// The dock and the keyboard over the newest end, the bottom of the
    /// screen.
    public var newest: CGFloat
    /// The header over the oldest end.
    public var oldest: CGFloat
    /// The safe area on the indicator's side, the right.
    public var side: CGFloat

    public init(newest: CGFloat = 0, oldest: CGFloat = 0, side: CGFloat = 0) {
        self.newest = max(0, newest)
        self.oldest = max(0, oldest)
        self.side = max(0, side)
    }
}

/// UIKit's vertical scroll indicator over the chat's flipped list: where it
/// must be for what the reader sees.
///
/// The list is flipped, so its scroll origin, the newest message, is the
/// bottom of the screen. The indicator rests at the bottom at the newest
/// message and climbs as the reader goes back:
///
///     oldest inset      header
///     ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ track top (endInset under the header)
///                  ▐    the indicator: the visible share of the track,
///                  ▐    `progress` of the way from the bottom
///     ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ track bottom (endInset above the dock)
///     newest inset      dock, keyboard
///
/// Its length is the viewport's share of everything there is to scroll
/// (content and both content insets), never shorter than
/// `minimumLength`. Pulled past either end, it is squashed against that end
/// by the overscroll, down to `minimumSquashedLength`. Dragging it is the
/// inverse: `distanceFromNewest(indicatorMinY:)`.
///
/// Frames are in the list's own coordinates as it shows on screen, y down
/// from its top; `frameInScrollView` is the same frame where UIKit puts the
/// indicator view, inside the flipped collection view.
public struct ChatScrollIndicatorLayout: Equatable, Sendable {
    /// UIKit's indicator. Its constants are the only ones here that come
    /// from UIKit rather than from the screen; `standard` says where they
    /// were measured.
    public struct Style: Equatable, Sendable {
        public var thickness: CGFloat
        /// Between the indicator and the ends of its track.
        public var endInset: CGFloat
        /// Between the indicator and the list's side.
        public var sideInset: CGFloat
        public var minimumLength: CGFloat
        public var minimumSquashedLength: CGFloat

        public init(thickness: CGFloat, endInset: CGFloat, sideInset: CGFloat, minimumLength: CGFloat, minimumSquashedLength: CGFloat) {
            self.thickness = thickness
            self.endInset = endInset
            self.sideInset = sideInset
            self.minimumLength = minimumLength
            self.minimumSquashedLength = minimumSquashedLength
        }

        /// Not yet measured: UIKit's long-standing values, to be checked on
        /// the iOS 26 and iOS 18 simulators (`HostedChatScrollIndicatorTests`).
        public static let standard = Style(thickness: 3, endInset: 3, sideInset: 3, minimumLength: 36, minimumSquashedLength: 7)
    }

    public struct Input: Equatable, Sendable {
        /// The list's size.
        public var viewport: CGSize
        public var contentHeight: CGFloat
        /// The list's content insets at its two ends.
        public var newestInset: CGFloat
        public var oldestInset: CGFloat
        public var indicatorInsets: ChatIndicatorInsets
        /// How far the reader has scrolled back from the newest edge
        /// (`visibleMinY`): 0 at the newest message, below 0 while pulled
        /// past it.
        public var distanceFromNewest: CGFloat

        public init(
            viewport: CGSize, contentHeight: CGFloat, newestInset: CGFloat, oldestInset: CGFloat,
            indicatorInsets: ChatIndicatorInsets, distanceFromNewest: CGFloat
        ) {
            self.viewport = viewport
            self.contentHeight = contentHeight
            self.newestInset = newestInset
            self.oldestInset = oldestInset
            self.indicatorInsets = indicatorInsets
            self.distanceFromNewest = distanceFromNewest
        }
    }

    public var input: Input
    public var style: Style
    /// Content and both content insets: everything there is to scroll.
    public var span: CGFloat
    /// The furthest the reader can go back from the newest edge.
    public var maxDistance: CGFloat
    /// Whether there is anything to scroll; UIKit shows no indicator
    /// otherwise.
    public var scrolls: Bool
    /// Where the indicator moves, between what covers the list's ends.
    public var track: CGRect
    /// The indicator's unsquashed length.
    public var length: CGFloat
    /// 0 at the newest message, 1 at the oldest.
    public var progress: CGFloat
    public var frame: CGRect

    public init(_ input: Input, style: Style = .standard) {
        self.input = input
        self.style = style
        let height = max(0, input.viewport.height)
        let insets = input.indicatorInsets
        span = max(0, input.contentHeight) + max(0, input.newestInset) + max(0, input.oldestInset)
        maxDistance = max(0, span - height)
        scrolls = maxDistance > 0
        let top = insets.oldest + style.endInset
        let bottom = max(top, height - insets.newest - style.endInset)
        let x = max(0, input.viewport.width) - insets.side - style.sideInset - style.thickness
        track = CGRect(x: x, y: top, width: style.thickness, height: bottom - top)
        let share = span > 0 ? track.height * height / span : track.height
        length = min(track.height, max(style.minimumLength, share))
        let distance = input.distanceFromNewest
        progress = scrolls ? min(1, max(0, distance / maxDistance)) : 0
        if distance < 0 {
            // Pulled past the newest message: squashed onto the bottom.
            let squashed = min(length, max(style.minimumSquashedLength, length + distance))
            frame = CGRect(x: x, y: bottom - squashed, width: style.thickness, height: squashed)
        } else if distance > maxDistance {
            // Past the oldest: squashed onto the top.
            let squashed = min(length, max(style.minimumSquashedLength, length - (distance - maxDistance)))
            frame = CGRect(x: x, y: top, width: style.thickness, height: squashed)
        } else {
            frame = CGRect(x: x, y: bottom - length - progress * (track.height - length), width: style.thickness, height: length)
        }
    }

    /// The indicator's frame inside the flipped collection view, as its
    /// `frame` reads: in content coordinates, where y grows from the newest
    /// edge, `contentOffset.y` (`distanceFromNewest - newestInset`) at the
    /// screen's bottom edge of the list.
    public var frameInScrollView: CGRect {
        let offset = input.distanceFromNewest - input.newestInset
        let height = max(0, input.viewport.height)
        return CGRect(x: frame.minX, y: offset + height - frame.maxY, width: frame.width, height: frame.height)
    }

    /// Dragging the indicator: how far back from the newest edge the reader
    /// is when the indicator's top is at `minY` (y down from the list's
    /// top). It stops at both ends of the track.
    public func distanceFromNewest(indicatorMinY minY: CGFloat) -> CGFloat {
        let travel = track.height - length
        guard scrolls, travel > 0 else { return 0 }
        let progress = min(1, max(0, (track.maxY - length - minY) / travel))
        return progress * maxDistance
    }
}
