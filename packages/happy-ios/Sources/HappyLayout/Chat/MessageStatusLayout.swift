import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The time and the delivery mark at the foot of a person's own bubble,
/// as Telegram's outgoing bubble sets them (ChatMessageDateAndStatusNode at
/// its 17-point base size): the time 5 after the text, then a 13-wide
/// slot for the clock or the checks, which is always kept, so the clock
/// turning into checks never moves anything.
///
///     5 gap │ time │ 13 slot ┊ 5 overhang
///               ╰ clock: 11 square, centred 8.5 past the time, 7.5 down
///               ╰ checks: 11×9, 3 down; the first 1 past the time, the
///                 second 6 further, reaching 5 past the slot into the
///                 bubble's padding
///               ╰ failed: the clock's square
///
/// Every mark is drawn inside `mark`, the union of all four, so the box
/// is as wide for one as for another: no state can move the time or the
/// words, or widen the bubble. Past the box only `overhang` is drawn, at
/// most 5, inside the bubble's 12 of padding and the pill's 7.
///
/// The marks grow with the text size as Telegram's follow its font size
/// (`scale`, the text's multiplier). Beyond the designed size the overhang
/// stays 5 and the slot takes the rest, so a large mark never leaves the
/// bubble.
///
/// Frames are in the status box, whose origin is the gap's left edge.
public struct MessageStatusLayout: Equatable, Sendable {
    public enum Metrics {
        /// The room between the text and the time.
        public static let gap: CGFloat = 5
        /// What the clock or the checks take after the time.
        public static let slot: CGFloat = 13
        /// How far the second check reaches past the box, into the padding.
        public static let overhang: CGFloat = 5
        public static let clock: CGFloat = 11
        public static let clockX: CGFloat = 8.5
        public static let clockY: CGFloat = 7.5
        public static let checkWidth: CGFloat = 11
        public static let checkHeight: CGFloat = 9
        public static let checkY: CGFloat = 3
        /// The second check's start past the first's.
        public static let checkOffset: CGFloat = 6
        /// The time sits a point under the box's top.
        public static let timeY: CGFloat = 1
        /// On pictures alone: the pill's padding, and its distance from
        /// the picture's corner (`dateAndStatusMediaBackground`, the image
        /// layout's status insets).
        public static let pillPadding = LayoutInsets(top: 2, left: 7, bottom: 2, right: 7)
        public static let pillInset: CGFloat = 6
    }

    public var size: CGSize
    public var time: CGRect
    public var clock: CGRect
    public var sentCheck: CGRect
    public var readCheck: CGRect
    /// Where the failed mark goes: the clock's square.
    public var failed: CGRect { clock }
    /// What any mark may draw over, whichever it is: the clock's square
    /// and both checks. The live mark's frame, and its tap target.
    public var mark: CGRect { clock.union(sentCheck).union(readCheck) }
    /// How far `mark` reaches past the box's right edge.
    public var overhang: CGFloat { mark.maxX - size.width }

    /// `time` is the measured time text, `scale` the text size's multiplier.
    public init(time: CGSize, scale: CGFloat = 1) {
        typealias M = Metrics
        let s = scale > 0 ? scale : 1
        let timeEnd = M.gap + time.width
        // The marks' extent past the time: the second check's far end.
        let reach = (M.slot + M.overhang) * s
        let overhang = min(M.overhang * s, M.overhang)
        size = CGSize(width: timeEnd + reach - overhang, height: time.height)
        self.time = CGRect(x: M.gap, y: M.timeY, width: time.width, height: time.height)
        let end = size.width + overhang
        let check = CGSize(width: M.checkWidth * s, height: M.checkHeight * s)
        readCheck = CGRect(x: end - check.width, y: M.checkY * s, width: check.width, height: check.height)
        sentCheck = readCheck.offsetBy(dx: -M.checkOffset * s, dy: 0)
        let clockSide = M.clock * s
        let clockMid = end - (M.slot + M.overhang - M.clockX) * s
        clock = CGRect(x: clockMid - clockSide / 2, y: M.clockY * s - clockSide / 2, width: clockSide, height: clockSide)
    }

    /// Where the box goes in a bubble's content, and what that does to it
    /// (Telegram's `trailingContent`): on the last line when that line
    /// and the box fit in `available`, the content growing wide enough
    /// for both; otherwise on a line of its own under the text, the
    /// content growing that line taller. Either way it ends at the
    /// content's right edge.
    public struct Placement: Equatable, Sendable {
        /// The content's size with the box in it.
        public var content: CGSize
        /// The box, in the content's coordinates.
        public var frame: CGRect
        public var inline: Bool
    }

    /// `text`: the content's size without the box. `trailing`: how wide
    /// its last line is, nil where the box can't share it (a code block
    /// or a list ends the text).
    public func place(text: CGSize, trailing: CGFloat?, available: CGFloat) -> Placement {
        if let trailing, trailing + size.width <= available {
            let width = max(text.width, trailing + size.width)
            // It rides up onto the last line, its foot a point under the line's.
            return Placement(content: CGSize(width: width, height: text.height),
                             frame: CGRect(x: width - size.width, y: text.height - size.height + 1, width: size.width, height: size.height),
                             inline: true)
        }
        let width = max(text.width, size.width)
        return Placement(content: CGSize(width: width, height: text.height + size.height),
                         frame: CGRect(x: width - size.width, y: text.height, width: size.width, height: size.height),
                         inline: false)
    }

    /// On pictures sent alone, the box sits in a pill at the last
    /// picture's foot, `Metrics.pillInset` in from its right and bottom.
    public func pill(over picture: CGRect) -> (pill: CGRect, frame: CGRect) {
        typealias M = Metrics
        let padding = M.pillPadding
        let pill = CGRect(
            x: picture.maxX - M.pillInset - size.width - padding.left - padding.right + M.gap,
            y: picture.maxY - M.pillInset - size.height - padding.top - padding.bottom,
            width: size.width - M.gap + padding.left + padding.right,
            height: size.height + padding.top + padding.bottom
        )
        return (pill, CGRect(x: pill.minX + padding.left - M.gap, y: pill.minY + padding.top, width: size.width, height: size.height))
    }
}

/// What a person's own message shows at its foot: the clock while it is
/// on this phone, one check when the computer has it, two when the agent
/// took it into its turn, and a refusal's mark.
public enum MessageDelivery: Equatable, Sendable {
    case sending
    case received
    case accepted
    case failed
}
