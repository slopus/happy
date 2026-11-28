import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A home row swiped toward its leading edge to archive it, as an inset
/// grouped list's trailing swipe goes: the row's content slides inside its
/// card and the red action grows in from the card's trailing edge, clipped
/// to the card. Let go past half the action and the row stays open on it;
/// past `fullFraction` of the card the action fills the row, its label
/// moves to the content's edge, and letting go there archives at once.
public enum SidebarSwipeLayout {
    /// The action's width while the row stands open on it.
    public static let actionWidth: CGFloat = 84
    /// How far across the card a swipe archives when let go.
    public static let fullFraction: CGFloat = 0.55
    /// Between the action's icon and its title.
    public static let labelGap: CGFloat = 4
    /// A flick this fast (points a second, toward opening) opens the row
    /// however little it has moved; as fast the other way, it closes.
    public static let flick: CGFloat = 400

    public enum Outcome: Equatable, Sendable {
        case closed, open, full
    }

    /// Where everything stands, in the card's coordinates (its box's
    /// top-left): how far the content moves (negative: toward the leading
    /// edge), the action, and its icon and title in the action's own.
    public struct Frames: Equatable, Sendable {
        public var offset: CGFloat
        public var action: CGRect
        public var icon: CGRect
        public var title: CGRect
    }

    /// The swipe past which letting go archives, in a card `width` wide.
    public static func fullThreshold(width: CGFloat) -> CGFloat {
        max(actionWidth + 1, (width * fullFraction).rounded())
    }

    /// What a finger `proposed` points toward the leading edge shows: as
    /// far as the finger went, never past the card's width, never back past
    /// closed.
    public static func shown(_ proposed: CGFloat, width: CGFloat) -> CGFloat {
        min(max(0, proposed), max(0, width))
    }

    /// Whether the row shows `reveal` filled by its action.
    public static func isFull(_ reveal: CGFloat, width: CGFloat) -> Bool {
        reveal >= fullThreshold(width: width)
    }

    /// Where the row goes when let go at `reveal`, moving `velocity` toward
    /// opening.
    public static func release(reveal: CGFloat, velocity: CGFloat, width: CGFloat) -> Outcome {
        if isFull(reveal, width: width) { return .full }
        if velocity >= flick { return .open }
        if velocity <= -flick { return .closed }
        return reveal >= actionWidth / 2 ? .open : .closed
    }

    /// How far the row stands open for `outcome`.
    public static func reveal(_ outcome: Outcome, width: CGFloat) -> CGFloat {
        switch outcome {
        case .closed: 0
        case .open: min(actionWidth, width)
        case .full: width
        }
    }

    /// `box`: the row's card, `reveal`: how far it stands open, `full`:
    /// filled by its action. `icon` and `title`: the label's measured
    /// sizes, icon over title, centred in the action's own width from its
    /// trailing edge, or from its leading edge once full.
    public static func frames(box: CGSize, reveal: CGFloat, full: Bool, icon: CGSize, title: CGSize) -> Frames {
        let reveal = shown(reveal, width: box.width)
        let action = CGRect(x: box.width - reveal, y: 0, width: reveal, height: box.height)
        let lane = min(reveal, actionWidth)
        let laneX = full ? 0 : reveal - lane
        let height = icon.height + labelGap + title.height
        let top = ((box.height - height) / 2).rounded()
        let iconFrame = CGRect(x: laneX + ((lane - icon.width) / 2).rounded(), y: top, width: icon.width, height: icon.height)
        let titleFrame = CGRect(x: laneX + ((lane - title.width) / 2).rounded(), y: top + icon.height + labelGap, width: title.width, height: title.height)
        return Frames(offset: -reveal, action: action, icon: iconFrame, title: titleFrame)
    }
}
