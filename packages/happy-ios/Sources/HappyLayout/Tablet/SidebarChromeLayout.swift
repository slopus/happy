import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home's bar at the foot of the iPad's sidebar (docs/IPAD.md): settings
/// at the bottom left, and compose at the bottom right as the column's one
/// prominent action, a pill that says what it does. Both are held off the
/// floating sidebar's edges and its foot by `side` and `bottom`, or the
/// safe area where that is more. The list keeps clear of `bar`.
///
/// `composeWidth` is the pill's measured width, nil where nothing can be
/// started (a Happy CLI home with no computer); it is held to what is left
/// beside settings.
public struct SidebarBottomBarLayout: Equatable, Sendable {
    public enum Metrics {
        public static let side: CGFloat = GroupedSidebarMetrics.side
        public static let bottom: CGFloat = 16
        /// Both controls' height: settings is a circle this wide.
        public static let height: CGFloat = 48
        /// The least room between settings and the pill.
        public static let spacing: CGFloat = 12
    }

    public var settings: CGRect
    public var compose: CGRect?
    /// Everything the bar covers, for the list's bottom inset.
    public var bar: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, composeWidth: CGFloat?) {
        typealias M = Metrics
        let top = size.height - max(safeArea.bottom, M.bottom) - M.height
        let settings = CGRect(x: M.side, y: top, width: M.height, height: M.height)
        let compose = composeWidth.map { measured in
            let room = max(0, size.width - 2 * M.side - M.height - M.spacing)
            let width = min(measured.rounded(.up), room)
            return CGRect(x: size.width - M.side - width, y: top, width: width, height: M.height)
        }
        self.settings = settings
        self.compose = compose
        bar = compose.map { settings.union($0) } ?? settings
    }
}

/// Home's search as the iPad's sidebar has it: a field at the top of the
/// list that scrolls with it and passes under the bar, as Telegram's chat
/// list keeps its own, instead of a button in the header. The list starts
/// under it (`listTop`).
///
/// `chromeTop` is the bar's foot, `scrolled` how far the list is read
/// down from its rest (negative under a pull). The field fades as it goes
/// under the bar. While search is open (`pinned`) it stays at its rest,
/// whatever the list did, and Cancel (`cancelWidth`, measured) takes room
/// at its right.
public struct SidebarSearchLayout: Equatable, Sendable {
    public enum Metrics {
        public static let side: CGFloat = GroupedSidebarMetrics.side
        /// From the bar's foot to the field at rest.
        public static let top: CGFloat = 8
        public static let height: CGFloat = 36
        /// From the field to the list's top; the grouped list pads its
        /// first card by its own `GroupedSidebarMetrics.contentTop` again.
        public static let gap: CGFloat = 4
        /// Between the field and Cancel.
        public static let cancelSpacing: CGFloat = 8
    }

    public var field: CGRect
    public var cancel: CGRect?
    public var alpha: CGFloat
    public var listTop: CGFloat

    public init(width: CGFloat, chromeTop: CGFloat, scrolled: CGFloat, pinned: Bool, cancelWidth: CGFloat?) {
        typealias M = Metrics
        let rest = chromeTop + M.top
        listTop = rest + M.height + M.gap
        let y = pinned ? rest : rest - scrolled
        let cancelRoom = cancelWidth.map { $0.rounded(.up) + M.cancelSpacing } ?? 0
        field = CGRect(x: M.side, y: y, width: max(0, width - 2 * M.side - cancelRoom), height: M.height)
        cancel = cancelWidth.map { measured in
            CGRect(x: width - M.side - measured.rounded(.up), y: y, width: measured.rounded(.up), height: M.height)
        }
        // As much of it shows as is still below the bar's foot.
        alpha = pinned ? 1 : min(1, max(0, (y + M.height - chromeTop) / M.height))
    }
}
