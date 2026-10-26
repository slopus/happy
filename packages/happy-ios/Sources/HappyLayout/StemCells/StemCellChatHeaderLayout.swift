import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's header, as Telegram's chat header on iOS 26: floating
/// glass over the transcript, which scrolls under it. In home's 52-tall row
/// under the status bar (`HomeHeaderLayout`), the back button is a 44 glass
/// circle 16 in, where home's account picture is, and the name is centred
/// in a glass capsule, 16 in on either side of it, with its status under it
/// in grey when there is one:
///
///     ( ‹ )        ( Pineapple poem )
///                  (    Working     )
///
/// The capsule keeps 8 clear of the circle on both sides, so it stays
/// centred. A scrim reaches 8 below the row; the transcript starts at the
/// row's foot.
public struct StemCellChatHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let rowHeight: CGFloat = HomeHeaderLayout.Metrics.contentHeight
        public static let padding: CGFloat = HomeHeaderLayout.Metrics.paddingHorizontal
        public static let control: CGFloat = HomeHeaderLayout.Metrics.controlSize
        /// Between the circle and the capsule.
        public static let gap: CGFloat = 8
        /// The capsule: 44 with the name alone, 48 with its status.
        public static let pillHeight: CGFloat = 44
        public static let pillHeightWithStatus: CGFloat = 48
        public static let pillPadding: CGFloat = 16
        /// The name's line and the status's, touching.
        public static let titleHeight: CGFloat = 22
        public static let statusHeight: CGFloat = 16
        public static let backdropOverhang: CGFloat = HomeHeaderLayout.Metrics.backdropOverhang
    }

    public var back: CGRect
    public var pill: CGRect
    /// In the screen, inside the capsule.
    public var title: CGRect
    public var status: CGRect?
    public var backdrop: CGRect
    /// The transcript's top inset.
    public var listTop: CGFloat
    /// The widest the name may be.
    public var titleMaxWidth: CGFloat

    /// `titleWidth` and `statusWidth` are their single lines' widths; no
    /// status, no second line.
    public init(width: CGFloat, safeTop: CGFloat, titleWidth: CGFloat, statusWidth: CGFloat?) {
        typealias M = Metrics
        let width = max(0, width)
        let rowTop = safeTop
        back = CGRect(x: M.padding, y: rowTop + (M.rowHeight - M.control) / 2, width: M.control, height: M.control)
        let side = M.padding + M.control + M.gap
        let pillMax = max(0, width - 2 * side)
        titleMaxWidth = max(0, pillMax - 2 * M.pillPadding)
        let titleWidth = min(titleWidth.rounded(.up), titleMaxWidth)
        let statusMax = titleMaxWidth
        let statusWidth = statusWidth.map { min($0.rounded(.up), statusMax) }
        let inner = max(titleWidth, statusWidth ?? 0)
        let height = statusWidth == nil ? M.pillHeight : M.pillHeightWithStatus
        let pillWidth = min(pillMax, inner + 2 * M.pillPadding)
        pill = CGRect(x: ((width - pillWidth) / 2).rounded(), y: rowTop + (M.rowHeight - height) / 2, width: pillWidth, height: height)
        let lines = M.titleHeight + (statusWidth == nil ? 0 : M.statusHeight)
        let top = pill.minY + ((height - lines) / 2).rounded()
        title = CGRect(x: (pill.midX - titleWidth / 2).rounded(), y: top, width: titleWidth, height: M.titleHeight)
        let midX = pill.midX
        status = statusWidth.map { CGRect(x: (midX - $0 / 2).rounded(), y: top + M.titleHeight, width: $0, height: M.statusHeight) }
        backdrop = CGRect(x: 0, y: 0, width: width, height: rowTop + M.rowHeight + M.backdropOverhang)
        listTop = rowTop + M.rowHeight
    }
}
