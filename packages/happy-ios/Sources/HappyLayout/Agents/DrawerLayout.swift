import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The phone's drawer: a panel from the leading edge over a dimmed screen,
/// the account's switcher at its top, the places under it, Settings at its
/// foot. Everything here is in the container's coordinates, the panel open;
/// `offset` slides it shut.
public struct DrawerLayout: Equatable, Sendable {
    public enum Metrics {
        /// The panel takes this much of the screen, at most `maxWidth`, so
        /// a strip of the screen it covers always shows beside it.
        public static let widthFraction: CGFloat = 0.84
        public static let maxWidth: CGFloat = 340
        /// The switcher's line, under the status bar, inset as the cards are.
        public static let headerTop: CGFloat = 12
        public static let headerHeight: CGFloat = 36
        public static let side: CGFloat = GroupedSidebarMetrics.side
        /// Between the switcher and the first card.
        public static let headerGap: CGFloat = 8
        /// The panel's corners on its open side.
        public static let radius: CGFloat = 24
        /// How far the screen dims with the panel open.
        public static let dim: CGFloat = 0.3
        /// A release faster than this (points a second) opens or shuts
        /// whatever the distance.
        public static let flick: CGFloat = 500
        public static let duration: Double = 0.3
    }

    /// The panel, open.
    public var panel: CGRect
    /// The account's switcher: its measured size, no wider than the panel allows.
    public var header: CGRect
    /// The places' list, under the header and above the foot.
    public var list: CGRect
    /// Settings' card at the foot, over the home indicator.
    public var footer: CGRect

    /// `header`: the switcher's own size. `footerHeight`: Settings' card
    /// with its room above and below, as its list lays it out.
    public init(size: CGSize, safeArea: LayoutInsets, header: CGSize, footerHeight: CGFloat, rightToLeft: Bool = false) {
        typealias M = Metrics
        let width = Self.width(for: size.width)
        let x = rightToLeft ? size.width - width : 0
        panel = CGRect(x: x, y: 0, width: width, height: size.height)
        // The panel's leading edge runs under the safe area; its content doesn't.
        let lead = rightToLeft ? safeArea.right : safeArea.left
        let contentX = x + (rightToLeft ? 0 : lead)
        let contentWidth = max(0, width - lead)
        let headerWidth = min(header.width, max(0, contentWidth - 2 * M.side))
        let headerX = rightToLeft ? contentX + contentWidth - M.side - headerWidth : contentX + M.side
        let headerY = safeArea.top + M.headerTop
        self.header = CGRect(x: headerX, y: headerY, width: headerWidth, height: M.headerHeight)
        let footerY = size.height - safeArea.bottom - footerHeight
        footer = CGRect(x: contentX, y: footerY, width: contentWidth, height: footerHeight)
        let listY = headerY + M.headerHeight + M.headerGap
        list = CGRect(x: contentX, y: listY, width: contentWidth, height: max(0, footerY - listY))
    }

    /// Settings' one card at the foot, as its grouped list lays it out:
    /// the row with the list's room above and below it.
    public static func footerHeight(width: CGFloat) -> CGFloat {
        typealias G = GroupedSidebarMetrics
        return SidebarLayout.layout([SidebarLayout.Row(kind: .row)], width: width, top: G.contentTop, bottom: G.contentBottom, style: .grouped).contentHeight
    }

    public static func width(for screen: CGFloat) -> CGFloat {
        min(Metrics.maxWidth, (screen * Metrics.widthFraction).rounded(.down))
    }

    /// How far the panel stands from open at `progress` (0 shut, 1 open):
    /// shut, wholly off the screen's leading edge.
    public static func offset(progress: CGFloat, width: CGFloat, rightToLeft: Bool = false) -> CGFloat {
        let shut = (1 - min(1, max(0, progress))) * width
        return rightToLeft ? shut : -shut
    }

    /// The progress a finger `translation` points along from where it
    /// began has moved the panel: toward the open side opens.
    public static func progress(from start: CGFloat, translation: CGFloat, width: CGFloat, rightToLeft: Bool = false) -> CGFloat {
        guard width > 0 else { return start }
        let along = rightToLeft ? -translation : translation
        return min(1, max(0, start + along / width))
    }

    /// Whether a finger let go at `progress`, moving at `velocity` along the
    /// opening direction, leaves the panel open.
    public static func settlesOpen(progress: CGFloat, velocity: CGFloat, rightToLeft: Bool = false) -> Bool {
        let along = rightToLeft ? -velocity : velocity
        if abs(along) > Metrics.flick { return along > 0 }
        return progress > 0.5
    }
}
