import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A conversation's header, as Telegram's chat header on iOS 26: floating
/// glass over the transcript, which scrolls under it. In home's 52-tall row
/// under the status bar (`HomeHeaderLayout`), the back button is a 44 glass
/// circle 16 in, where home's account picture is, and the name is centred
/// in a glass capsule that runs from 8 past the circle to 16 short of the
/// screen's right edge, with its status under it in grey when there is
/// one. The capsule opens the conversation's detail.
///
///     ( ‹ ) (       Pineapple poem       )
///           (          Working           )
///
/// Home's scrim (`HeaderScrimView`) reaches 8 below the row, as on every
/// glass bar, and on here past the capsule by the scrim's feather, as
/// home's reaches on over its stories (`backdropExtension`): what scrolls
/// under the header has faded and blurred out by the time it meets the
/// capsule, never cut along its edge. It comes in as the transcript
/// scrolls under it (`HeaderScrim.presence`). The transcript starts at the
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
    /// The glass bars' scrim, 8 below the row.
    public var backdrop: CGRect
    /// The scrim drawn here: `backdrop`, reaching the feather past the
    /// capsule as tall as it gets (with a status), so it never moves.
    public var scrim: CGRect
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
        let left = M.padding + M.control + M.gap
        let pillWidth = max(0, width - left - M.padding)
        titleMaxWidth = max(0, pillWidth - 2 * M.pillPadding)
        let titleWidth = min(titleWidth.rounded(.up), titleMaxWidth)
        let statusMax = titleMaxWidth
        let statusWidth = statusWidth.map { min($0.rounded(.up), statusMax) }
        let height = statusWidth == nil ? M.pillHeight : M.pillHeightWithStatus
        pill = CGRect(x: left, y: rowTop + (M.rowHeight - height) / 2, width: pillWidth, height: height)
        let lines = M.titleHeight + (statusWidth == nil ? 0 : M.statusHeight)
        let top = pill.minY + ((height - lines) / 2).rounded()
        title = CGRect(x: (pill.midX - titleWidth / 2).rounded(), y: top, width: titleWidth, height: M.titleHeight)
        let midX = pill.midX
        status = statusWidth.map { CGRect(x: (midX - $0 / 2).rounded(), y: top + M.titleHeight, width: $0, height: M.statusHeight) }
        backdrop = CGRect(x: 0, y: 0, width: width, height: rowTop + M.rowHeight + M.backdropOverhang)
        let tallest = rowTop + (M.rowHeight + M.pillHeightWithStatus) / 2
        scrim = CGRect(x: 0, y: 0, width: width, height: max(backdrop.height, tallest + HeaderScrim.rampPoints))
        listTop = rowTop + M.rowHeight
    }
}
