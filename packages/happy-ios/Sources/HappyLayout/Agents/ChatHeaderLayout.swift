import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's title in the navigation bar: its name, and what the
/// agent is doing in grey under it while it is. The bar centres the view;
/// the lines are centred in it, the pair centred on the bar's 44. The
/// status's line is kept when the agent is idle, so its work starting and
/// stopping never moves the name.
///
///          Pineapple poem
///             Working
public struct ChatHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        /// The name's line and the status's, touching.
        public static let titleHeight: CGFloat = 22
        public static let statusHeight: CGFloat = 16
    }

    public var size: CGSize
    /// The name's line.
    public var title: CGRect
    public var status: CGRect?

    /// Single-line measured widths. The second line always keeps its
    /// height; `reservedStatusWidth` also keeps its width across changes.
    public init(titleWidth: CGFloat, statusWidth: CGFloat?, maxWidth: CGFloat, reservedStatusWidth: CGFloat = 0) {
        typealias M = Metrics
        let maxWidth = max(0, maxWidth)
        let titleWidth = min(max(0, titleWidth).rounded(.up), maxWidth)
        let statusWidth = statusWidth.map { min(max(0, $0, reservedStatusWidth).rounded(.up), maxWidth) }
        let width = max(titleWidth, statusWidth ?? 0)
        let height = ChatTitleLayout.height
        size = CGSize(width: width, height: height)
        let lines = M.titleHeight + M.statusHeight
        let top = ((height - lines) / 2).rounded()
        title = CGRect(x: ((width - titleWidth) / 2).rounded(), y: top, width: titleWidth, height: M.titleHeight)
        status = statusWidth.map { CGRect(x: ((width - $0) / 2).rounded(), y: top + M.titleHeight, width: $0, height: M.statusHeight) }
    }
}
