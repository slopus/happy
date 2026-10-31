import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's title in the navigation bar, as Telegram heads a chat
/// on iOS 26 (ChatTitleComponent): its name, and what the agent is doing in
/// grey under it, on one glass capsule as tall as the bar's buttons. Its
/// content is the wider line, but never narrower than `minContent` (as much
/// of it as the room has) nor than the widest status, with `padding` clear
/// at each end. It is centred on the bar; only when that would run into the
/// bar's items does it move, just far enough, towards the other side; with
/// no room for it whole it fills the room and the name is cut. Right to
/// left is the same rule: the room is simply on the other side.
///
///     (<)     (      hey      )     (✎)
///             (    offline    )
///
/// Every status fits the capsule as it stands, the widest included (as
/// Telegram's fits "typing"), so a new word changes neither the capsule
/// nor either line: the status's line is the widest status's width.
public struct ChatHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        /// The name's line and the status's, touching.
        public static let titleHeight: CGFloat = 22
        public static let statusHeight: CGFloat = 16
        /// The capsule: the bar's buttons' 44.
        public static let height: CGFloat = 44
        /// Clear between the capsule's ends and its content (Telegram's
        /// `containerSideInset`).
        public static let padding: CGFloat = 14
        /// The content is never narrower than this (Telegram's 150): a
        /// short name's capsule is 178, not a bubble round its word.
        public static let minContent: CGFloat = 150
    }

    /// The glass, its ends round.
    public var capsule: CGRect
    /// The name's line.
    public var title: CGRect
    public var status: CGRect?

    /// Widths are single-line measurements: the name, the status shown (nil
    /// with none), and the widest status there is. `centerX` is the bar's
    /// middle and `room` what the bar left between its items, both in the
    /// header's own coordinates; `height` is the header's.
    public init(
        titleWidth: CGFloat, statusWidth: CGFloat?, reservedStatusWidth: CGFloat = 0,
        centerX: CGFloat, room: ClosedRange<CGFloat>, height: CGFloat
    ) {
        typealias M = Metrics
        let roomWidth = room.upperBound - room.lowerBound
        let titleWidth = max(0, titleWidth).rounded(.up)
        let statusLine = statusWidth.map { max($0, reservedStatusWidth, 0).rounded(.up) }
        let floor = min(M.minContent, max(0, roomWidth - 2 * M.padding))
        let content = max(titleWidth, statusLine ?? 0, floor)
        let width = min(content + 2 * M.padding, roomWidth)
        let x = min(max((centerX - width / 2).rounded(), room.lowerBound), room.upperBound - width)
        capsule = CGRect(x: x, y: ((height - M.height) / 2).rounded(), width: width, height: M.height)
        let top = capsule.minY + ((M.height - M.titleHeight - M.statusHeight) / 2).rounded()
        let inner = max(0, width - 2 * M.padding)
        let name = min(titleWidth, inner)
        title = CGRect(x: (capsule.midX - name / 2).rounded(), y: top, width: name, height: M.titleHeight)
        // As wide as the widest status, cut only by the capsule: a
        // crossfade between two words never stretches either.
        status = statusLine.map {
            let line = min($0, inner)
            return CGRect(x: (capsule.midX - line / 2).rounded(), y: top + M.titleHeight, width: line, height: M.statusHeight)
        }
    }
}
