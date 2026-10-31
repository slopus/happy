import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's title in the navigation bar, as Telegram heads a chat
/// on iOS 26: its name, and what the agent is doing in grey under it, on
/// one glass capsule as tall as the bar's buttons. The capsule hugs the
/// wider line with `padding` clear at each end; the lines are centred in
/// it, the pair centred on its 44. The status's line is kept when the agent
/// is idle, so its work starting and stopping never moves the name.
///
///        (   Pineapple poem   )
///        (      Working       )
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

    public var size: CGSize
    /// The glass, its ends round.
    public var capsule: CGRect
    /// The name's line.
    public var title: CGRect
    public var status: CGRect?

    /// Single-line measured widths. The second line always keeps its
    /// height; `reservedStatusWidth` also keeps its width across changes.
    /// `maxWidth` is the widest the capsule may be. Given `bounds`, the
    /// room the bar handed over, the capsule fits in it as well and is
    /// centred in it.
    public init(titleWidth: CGFloat, statusWidth: CGFloat?, maxWidth: CGFloat, reservedStatusWidth: CGFloat = 0, bounds: CGSize? = nil) {
        typealias M = Metrics
        let widest = min(max(0, maxWidth), bounds.map { max(0, $0.width) } ?? .greatestFiniteMagnitude)
        let room = max(0, widest - 2 * M.padding)
        let titleWidth = min(max(0, titleWidth).rounded(.up), room)
        let statusWidth = statusWidth.map { min(max(0, $0, reservedStatusWidth).rounded(.up), room) }
        let inner = max(titleWidth, statusWidth ?? 0)
        let width = min(inner + 2 * M.padding, max(widest, 0))
        let height = M.height
        let origin = bounds.map { CGPoint(x: (($0.width - width) / 2).rounded(), y: (($0.height - height) / 2).rounded()) } ?? .zero
        size = bounds ?? CGSize(width: width, height: height)
        capsule = CGRect(origin: origin, size: CGSize(width: width, height: height))
        let lines = M.titleHeight + M.statusHeight
        let top = origin.y + ((height - lines) / 2).rounded()
        let left = origin.x + M.padding
        title = CGRect(x: left + ((inner - titleWidth) / 2).rounded(), y: top, width: titleWidth, height: M.titleHeight)
        status = statusWidth.map { CGRect(x: left + ((inner - $0) / 2).rounded(), y: top + M.titleHeight, width: $0, height: M.statusHeight) }
    }
}
