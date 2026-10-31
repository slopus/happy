import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's title in the navigation bar, as Telegram heads a chat
/// on iOS 26: its name, and what the agent is doing in grey under it, on
/// one glass capsule as tall as the bar's buttons. The capsule hugs the
/// wider line with `padding` clear at each end, never narrower than it is
/// tall, and is centred on the bar. Only when that would run into the
/// bar's items does it move, just far enough, towards the other side;
/// with no room for it whole it fills the room and the name is cut.
/// Right to left is the same rule: the room is simply on the other side.
///
///     (<)      ( Pineapple poem )      ( ✎  ⋯ )
///              (     online     )
///
/// The status's line keeps the widest status's width, centred, so a new
/// word never moves it; the capsule hugs the word shown, and growing or
/// shrinking about the bar's middle moves neither line.
public struct ChatHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        /// The name's line and the status's, touching.
        public static let titleHeight: CGFloat = 22
        public static let statusHeight: CGFloat = 16
        /// The capsule: the bar's buttons' 44.
        public static let height: CGFloat = 44
        /// Clear between the capsule's ends and the wider line (Telegram's 12).
        public static let padding: CGFloat = 12
    }

    /// The glass, its ends round.
    public var capsule: CGRect
    /// The name's line.
    public var title: CGRect
    public var status: CGRect?

    /// Widths are single-line measurements: the name, the status shown, and
    /// the widest status there is. `centerX` is the bar's middle and `room`
    /// what the bar left between its items, both in the header's own
    /// coordinates; `height` is the header's.
    public init(
        titleWidth: CGFloat, statusWidth: CGFloat?, reservedStatusWidth: CGFloat = 0,
        centerX: CGFloat, room: ClosedRange<CGFloat>, height: CGFloat
    ) {
        typealias M = Metrics
        let roomWidth = room.upperBound - room.lowerBound
        let titleWidth = max(0, titleWidth).rounded(.up)
        let shown = statusWidth.map { max(0, $0).rounded(.up) }
        let wanted = max(M.height, max(titleWidth, shown ?? 0) + 2 * M.padding)
        let width = min(wanted, roomWidth)
        let x = min(max((centerX - width / 2).rounded(), room.lowerBound), room.upperBound - width)
        capsule = CGRect(x: x, y: ((height - M.height) / 2).rounded(), width: width, height: M.height)
        let top = capsule.minY + ((M.height - M.titleHeight - M.statusHeight) / 2).rounded()
        let inner = max(0, width - 2 * M.padding)
        let name = min(titleWidth, inner)
        title = CGRect(x: (capsule.midX - name / 2).rounded(), y: top, width: name, height: M.titleHeight)
        // As wide as the widest status, cut only by the room: a crossfade
        // between two words never stretches either.
        status = shown.map {
            let line = min(max($0, reservedStatusWidth.rounded(.up)), max(0, roomWidth - 2 * M.padding))
            return CGRect(x: (capsule.midX - line / 2).rounded(), y: top + M.titleHeight, width: line, height: M.statusHeight)
        }
    }
}
