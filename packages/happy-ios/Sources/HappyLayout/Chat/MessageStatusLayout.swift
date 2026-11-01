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
///     5 gap │ time │ 13 slot
///               ╰ clock: 11 square, centred 8.5 past the time, 7.5 down
///               ╰ checks: 11×9, 3 down; the first 1 past the time, the
///                 second 6 further, reaching 5 past the slot into the
///                 bubble's padding
///
/// Frames are in the status box, whose origin is the gap's left edge.
public struct MessageStatusLayout: Equatable, Sendable {
    public enum Metrics {
        /// The room between the text and the time.
        public static let gap: CGFloat = 5
        /// What the clock or the checks take after the time.
        public static let slot: CGFloat = 13
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

    /// `time` is the measured time text.
    public init(time: CGSize) {
        typealias M = Metrics
        let timeEnd = M.gap + time.width
        size = CGSize(width: timeEnd + M.slot, height: time.height)
        self.time = CGRect(x: M.gap, y: M.timeY, width: time.width, height: time.height)
        clock = CGRect(x: timeEnd + M.clockX - M.clock / 2, y: M.clockY - M.clock / 2, width: M.clock, height: M.clock)
        let readX = timeEnd + 5 + M.slot - M.checkWidth
        readCheck = CGRect(x: readX, y: M.checkY, width: M.checkWidth, height: M.checkHeight)
        sentCheck = CGRect(x: readX - M.checkOffset, y: M.checkY, width: M.checkWidth, height: M.checkHeight)
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
