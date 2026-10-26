import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The glass bar of settings and the screens around it, as a
/// conversation's header is (`StemCellChatHeaderLayout`): in home's 52-tall
/// row under the status bar, back (or close) is a 44 glass circle where
/// home's picture is, the title is centred in a glass capsule, and the
/// actions share one glass capsule at the right, as home's do
/// (`HomeHeaderLayout.actions`), split by hairlines:
///
///     ( ‹ )        ( Appearance )        ( ⌕ │ ▦ )
///
/// The first screen of a sheet closes from a glass circle at the right
/// (`SheetCloseLayout`): the row drops so the circle is as far from the
/// sheet's top as from its side, and the actions go left of it.
///
/// The title's capsule keeps 8 clear of whatever is beside it, on both
/// sides alike, so it stays centred. Searching, a field in a glass capsule
/// takes the row, with a glass circle at the right that ends the search.
/// A scrim reaches 8 below the row; what scrolls starts at the row's foot.
public struct StemCellsGlassBarLayout: Equatable, Sendable {
    public enum Metrics {
        public static let rowHeight: CGFloat = StemCellChatHeaderLayout.Metrics.rowHeight
        public static let padding: CGFloat = StemCellChatHeaderLayout.Metrics.padding
        public static let control: CGFloat = StemCellChatHeaderLayout.Metrics.control
        public static let border: CGFloat = HomeHeaderLayout.Metrics.controlBorder
        public static let divider: CGFloat = HomeHeaderLayout.Metrics.actionDividerHeight
        public static let gap: CGFloat = StemCellChatHeaderLayout.Metrics.gap
        public static let pillHeight: CGFloat = StemCellChatHeaderLayout.Metrics.pillHeight
        public static let pillPadding: CGFloat = StemCellChatHeaderLayout.Metrics.pillPadding
        public static let titleHeight: CGFloat = StemCellChatHeaderLayout.Metrics.titleHeight
        public static let backdropOverhang: CGFloat = StemCellChatHeaderLayout.Metrics.backdropOverhang
        /// The search field inside its capsule.
        public static let fieldInset: CGFloat = 12
        /// How far a sheet's row drops, for its close circle to sit
        /// `SheetCloseLayout.inset` from the sheet's top.
        public static let sheetDrop: CGFloat = SheetCloseLayout.inset - (rowHeight - control) / 2

        /// The height the bar adds to its screen's safe area.
        public static func span(closes: Bool) -> CGFloat { rowHeight + (closes ? sheetDrop : 0) }
    }

    /// Back; nil for a screen without it.
    public var leading: CGRect?
    /// A sheet's close circle, at the right; nil elsewhere.
    public var close: CGRect?
    /// The actions' capsule, rim included; nil without actions.
    public var actions: CGRect?
    /// Each action, in the screen.
    public var buttons: [CGRect]
    /// Between neighbouring actions.
    public var dividers: [CGRect]
    public var pill: CGRect?
    public var title: CGRect?
    /// Searching: the field's capsule, the field in it, and the circle
    /// that ends the search.
    public var searchPill: CGRect?
    public var field: CGRect?
    public var cancel: CGRect?
    public var backdrop: CGRect
    /// Where what scrolls under the bar starts.
    public var contentTop: CGFloat
    /// The widest the title may be.
    public var titleMaxWidth: CGFloat

    /// `titleWidth` is the title's single line's width, nil for none;
    /// `hairline` is one device pixel.
    public init(width: CGFloat, safeTop: CGFloat, hairline: CGFloat, hasLeading: Bool, actions count: Int, titleWidth: CGFloat?, searching: Bool = false, closes: Bool = false) {
        typealias M = Metrics
        let width = max(0, width)
        let rowTop = safeTop + (closes ? M.sheetDrop : 0)
        let circle = { (x: CGFloat) in CGRect(x: x, y: rowTop + (M.rowHeight - M.control) / 2, width: M.control, height: M.control) }
        backdrop = CGRect(x: 0, y: 0, width: width, height: rowTop + M.rowHeight + M.backdropOverhang)
        contentTop = rowTop + M.rowHeight
        guard !searching else {
            let cancel = circle(width - M.padding - M.control)
            let searchPill = CGRect(x: M.padding, y: cancel.minY, width: max(0, cancel.minX - M.gap - M.padding), height: M.control)
            self.cancel = cancel
            self.searchPill = searchPill
            field = searchPill.insetBy(dx: M.fieldInset, dy: 0)
            buttons = []
            dividers = []
            titleMaxWidth = 0
            return
        }
        leading = hasLeading ? circle(M.padding) : nil
        let close = closes ? circle(width - M.padding - M.control) : nil
        self.close = close
        let end = close.map { $0.minX - M.gap } ?? width - M.padding
        var buttons: [CGRect] = []
        var dividers: [CGRect] = []
        if count > 0 {
            let n = CGFloat(count)
            let capsule = CGSize(width: 2 * M.border + n * M.control + (n - 1) * hairline, height: 2 * M.border + M.control)
            let actions = CGRect(x: end - capsule.width, y: rowTop + (M.rowHeight - capsule.height) / 2, width: capsule.width, height: capsule.height)
            let y = actions.minY + M.border
            var x = actions.minX + M.border
            for index in 0..<count {
                if index > 0 {
                    dividers.append(CGRect(x: x, y: y + (M.control - M.divider) / 2, width: hairline, height: M.divider))
                    x += hairline
                }
                buttons.append(CGRect(x: x, y: y, width: M.control, height: M.control))
                x += M.control
            }
            self.actions = actions
        }
        self.buttons = buttons
        self.dividers = dividers
        // As wide a margin on both sides as the wider of the two needs.
        let left = M.padding + M.control + M.gap
        let right = (actions?.minX ?? close?.minX).map { width - $0 + M.gap } ?? left
        let side = max(left, right)
        let pillMax = max(0, width - 2 * side)
        titleMaxWidth = max(0, pillMax - 2 * M.pillPadding)
        guard let titleWidth else { return }
        let text = min(titleWidth.rounded(.up), titleMaxWidth)
        let pillWidth = min(pillMax, text + 2 * M.pillPadding)
        let pill = CGRect(x: ((width - pillWidth) / 2).rounded(), y: rowTop + (M.rowHeight - M.pillHeight) / 2, width: pillWidth, height: M.pillHeight)
        self.pill = pill
        title = CGRect(x: (pill.midX - text / 2).rounded(), y: pill.minY + ((M.pillHeight - M.titleHeight) / 2).rounded(), width: text, height: M.titleHeight)
    }
}
