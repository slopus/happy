import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// ChatHeaderView's title on a phone: a glass capsule as tall as the
/// controls beside it, hugging its text up to `maxWidth`, the text centred.
///
///     ┌ 14 ─────── title (one line) ─────── 14 ┐  44
///     │       subtitle  4  [≈ +12 -3]          │
///     └────────────────────────────────────────┘
///
/// The subtitle gives way to the line changes, which never shrink. Frames
/// are in the capsule's own space.
public struct ChatHeaderTitleLayout: Equatable, Sendable {
    public enum Metrics {
        /// MOBILE_GLASS_CONTROL_SIZE.
        public static let height: CGFloat = 44
        /// mobileTitlePillGlass's paddingHorizontal.
        public static let paddingH: CGFloat = 14
        /// subtitleRow's gap.
        public static let rowGap: CGFloat = 4
        /// The header's paddingHorizontal, the controls either side and
        /// MOBILE_TITLE_PILL_GAP: `resolveTitlePillInset` on a phone, where
        /// both controls are 44 wide.
        public static let headerPaddingH: CGFloat = 16
        public static let controlSize: CGFloat = 44
        public static let pillGap: CGFloat = 14
        /// The session avatar in the right control.
        public static let avatarSize: CGFloat = 28
    }

    public var size: CGSize
    public var title: CGRect
    public var subtitle: CGRect?
    public var changes: CGRect?

    public init(maxWidth: CGFloat, title: Measurable, subtitle: Measurable?, changes: CGSize?) {
        typealias M = Metrics
        let inner = max(0, maxWidth - 2 * M.paddingH)
        let titleSize = title.size(fitting: inner)
        let titleWidth = min(titleSize.width, inner)

        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var subtitleSize: CGSize?
        var changesSize: CGSize?
        if subtitle != nil || changes != nil {
            if let changes {
                changesSize = changes
                rowWidth = changes.width
                rowHeight = changes.height
            }
            if let subtitle {
                let room = max(0, inner - rowWidth - (changes == nil ? 0 : M.rowGap))
                let measured = subtitle.size(fitting: room)
                let size = CGSize(width: min(measured.width, room), height: measured.height)
                subtitleSize = size
                rowWidth += size.width + (changes == nil ? 0 : M.rowGap)
                rowHeight = max(rowHeight, size.height)
            }
        }

        let contentWidth = max(titleWidth, rowWidth)
        let contentHeight = titleSize.height + rowHeight
        size = CGSize(width: contentWidth + 2 * M.paddingH, height: M.height)
        let top = (M.height - contentHeight) / 2
        self.title = CGRect(x: (size.width - titleWidth) / 2, y: top, width: titleWidth, height: titleSize.height)

        let rowTop = top + titleSize.height
        var x = (size.width - rowWidth) / 2
        if let subtitleSize {
            self.subtitle = CGRect(x: x, y: rowTop + (rowHeight - subtitleSize.height) / 2, width: subtitleSize.width, height: subtitleSize.height)
            x += subtitleSize.width + M.rowGap
        }
        if let changesSize {
            self.changes = CGRect(x: x, y: rowTop + (rowHeight - changesSize.height) / 2, width: changesSize.width, height: changesSize.height)
        }
    }

    /// How wide the capsule may grow in a header `headerWidth` wide: the
    /// same inset from both edges, clearing the wider control, so it stays
    /// centred on the header.
    public static func maxWidth(headerWidth: CGFloat) -> CGFloat {
        typealias M = Metrics
        return max(0, headerWidth - 2 * (M.headerPaddingH + M.controlSize + M.pillGap))
    }
}

/// ChatHeaderView's scrim: MobileHeaderScrim's strong variant, its wash at
/// 0.80 while the conversation starts below the header and 0.96 once
/// content is scrolled under it, faded over 200 ms.
public enum ChatHeaderScrim {
    public static let restingOpacity: Float = 0.80
    public static let underlapOpacity: Float = 0.96
    public static let fadeDuration: TimeInterval = 0.2
}

/// ChatHeaderView without glass (a tablet): the title over the workspace or
/// branch and the line changes, at the start of the header's row rather
/// than in a capsule. The row is the navigation bar's width held to
/// `maxWidth` (`layout.headerMaxWidth`) and centred, 16 in from its sides;
/// the column is centred top to bottom in the title view.
///
/// UIKit insets a title view inside the bar, so the row is placed from the
/// bar's frame as the title view sees it, then clipped to the title view,
/// where its touches land. The title and its row are measured to what is
/// left after clipping.
public struct ChatPlainHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        /// The header's `content` paddingHorizontal.
        public static let paddingH: CGFloat = 16
        /// subtitleRow's gap.
        public static let rowGap: CGFloat = 4
    }

    /// The column the title and its row take, in the title view.
    public var column: CGRect
    /// In the column, as are `subtitle` and `changes`.
    public var title: CGRect
    public var subtitle: CGRect?
    public var changes: CGRect?

    /// `bar` is the navigation bar's frame in the title view's coordinates
    /// (the view's own bounds when it has no bar); `size` is the title
    /// view's.
    public init(bar: CGRect, size: CGSize, maxWidth: CGFloat, title: Measurable, subtitle: Measurable?, changes: CGSize?) {
        typealias M = Metrics
        let (x, width) = Self.row(bar: bar, size: size, maxWidth: maxWidth)
        let titleSize = title.size(fitting: width)

        var subtitleSize: CGSize?
        var rowHeight: CGFloat = 0
        if let subtitle {
            let size = subtitle.size(fitting: Self.subtitleWidth(textWidth: width, changes: changes))
            subtitleSize = size
            rowHeight = size.height
        }
        if let changes { rowHeight = max(rowHeight, changes.height) }

        let height = titleSize.height + rowHeight
        column = CGRect(x: x, y: (size.height - height) / 2, width: width, height: height)
        self.title = CGRect(origin: .zero, size: titleSize)
        let rowTop = titleSize.height
        var rowX: CGFloat = 0
        if let subtitleSize {
            self.subtitle = CGRect(x: rowX, y: rowTop + (rowHeight - subtitleSize.height) / 2, width: subtitleSize.width, height: subtitleSize.height)
            rowX += subtitleSize.width + M.rowGap
        }
        self.changes = changes.map { CGRect(x: rowX, y: rowTop + (rowHeight - $0.height) / 2, width: $0.width, height: $0.height) }
    }

    /// Where the column starts in the title view and what it has across:
    /// the bar's row held to `maxWidth`, 16 in from its sides, clipped to
    /// the view. The title is measured to this width.
    private static func row(bar: CGRect, size: CGSize, maxWidth: CGFloat) -> (x: CGFloat, width: CGFloat) {
        typealias M = Metrics
        let barWidth = max(0, bar.width)
        let row = min(barWidth, max(0, maxWidth))
        let start = bar.minX + (barWidth - row) / 2 + M.paddingH
        let end = start + max(0, row - 2 * M.paddingH)
        let viewWidth = max(0, size.width)
        let x = min(max(start, 0), viewWidth)
        return (x, max(0, min(end, viewWidth) - x))
    }

    /// What the title is measured to, for measuring it ahead of the
    /// layout (off the main thread).
    public static func textWidth(bar: CGRect, size: CGSize, maxWidth: CGFloat) -> CGFloat {
        row(bar: bar, size: size, maxWidth: maxWidth).width
    }

    /// What the subtitle is measured to: the column less the line changes
    /// and the gap before them.
    public static func subtitleWidth(textWidth: CGFloat, changes: CGSize?) -> CGFloat {
        max(0, textWidth - (changes.map { $0.width + Metrics.rowGap } ?? 0))
    }
}
