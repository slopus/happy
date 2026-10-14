import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// WorktreeTabStrip.tsx: a checkout's chats as tabs in a capsule under the
/// session screen's header, then a hairline and `+`.
///
///     10
///     16 ┌ border ─ 4 [tab] 2 [tab] 2 … 4 ─ scrolls ─┬ hairline ┬─ + 40 ┐ 16
///        └ 40 tall, round ──────────────────────────┴──────────┴───────┘
///     6
///
/// The capsule is held to `layout.headerMaxWidth` and centred, like the
/// header's row above it. A tab is 32 tall and round, 10 in at each side,
/// its name then, 6 after it, a 7pt dot; it grows to its name, up to 200.
public struct WorktreeTabStripLayout: Equatable, Sendable {
    public enum Metrics {
        public static let pillHeight: CGFloat = 40
        public static let gapAbove: CGFloat = 10
        public static let gapBelow: CGFloat = 6
        /// `WORKTREE_TAB_STRIP_HEIGHT`: what the strip costs the layout.
        public static let height: CGFloat = pillHeight + gapAbove + gapBelow
        public static let paddingH: CGFloat = 16
        /// The glass capsule's rim; off glass it is a hairline.
        public static let glassBorder: CGFloat = 1
        public static let tabsPaddingH: CGFloat = 4
        public static let tabGap: CGFloat = 2
        public static let tabHeight: CGFloat = pillHeight - 8
        public static let tabPaddingH: CGFloat = 10
        public static let tabMaxWidth: CGFloat = 200
        public static let dotGap: CGFloat = 6
        public static let dotSize: CGFloat = 7
        public static let dividerHeight: CGFloat = 20
        public static let addWidth: CGFloat = 40
        public static let addIconSize: CGFloat = 20
        public static let addHitSlop: CGFloat = 8
        /// TAB_SCROLL_MARGIN: room either side of a tab scrolled to.
        public static let scrollMargin: CGFloat = 8
        /// `tabPressed` and `addButtonPressed`.
        public static let pressedOpacity: CGFloat = 0.55
    }

    public struct Tab {
        public var label: Measurable
        /// The blocked or unread dot.
        public var dot: Bool

        public init(label: Measurable, dot: Bool) {
            self.label = label
            self.dot = dot
        }
    }

    public struct TabFrame: Equatable, Sendable {
        /// In the scrolling content.
        public var frame: CGRect
        /// In the tab.
        public var label: CGRect
        public var dot: CGRect?
    }

    public var size: CGSize
    public var pill: CGRect
    /// Inside the rim, in the pill: the scroller, the hairline and `+` are
    /// clipped to it.
    public var inner: CGRect
    /// In `inner`.
    public var scroller: CGRect
    public var contentWidth: CGFloat
    public var tabs: [TabFrame]
    public var divider: CGRect?
    public var add: CGRect?

    /// `border` is the rim: 1 on glass, a hairline off it.
    public init(width: CGFloat, maxWidth: CGFloat, border: CGFloat, hairline: CGFloat, tabs input: [Tab], showsAdd: Bool) {
        typealias M = Metrics
        let width = max(0, width)
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxWidth)
        size = CGSize(width: width, height: M.height)
        pill = CGRect(x: column.x + M.paddingH, y: M.gapAbove, width: max(0, column.width - 2 * M.paddingH), height: M.pillHeight)
        inner = CGRect(x: border, y: border, width: max(0, pill.width - 2 * border), height: max(0, pill.height - 2 * border))
        let trailing = showsAdd ? hairline + M.addWidth : 0
        scroller = CGRect(x: 0, y: 0, width: max(0, inner.width - trailing), height: inner.height)
        if showsAdd {
            divider = CGRect(x: scroller.maxX, y: (inner.height - M.dividerHeight) / 2, width: hairline, height: M.dividerHeight)
            add = CGRect(x: scroller.maxX + hairline, y: 0, width: M.addWidth, height: inner.height)
        } else {
            divider = nil
            add = nil
        }

        var x = M.tabsPaddingH
        let tabY = (inner.height - M.tabHeight) / 2
        tabs = input.map { tab in
            let dotWidth = tab.dot ? M.dotGap + M.dotSize : 0
            let labelRoom = M.tabMaxWidth - 2 * M.tabPaddingH - dotWidth
            let measured = tab.label.size(fitting: labelRoom)
            let labelWidth = min(measured.width, labelRoom)
            let frame = CGRect(x: x, y: tabY, width: M.tabPaddingH + labelWidth + dotWidth + M.tabPaddingH, height: M.tabHeight)
            x = frame.maxX + M.tabGap
            return TabFrame(
                frame: frame,
                label: CGRect(x: M.tabPaddingH, y: (M.tabHeight - measured.height) / 2, width: labelWidth, height: measured.height),
                dot: tab.dot
                    ? CGRect(x: M.tabPaddingH + labelWidth + M.dotGap, y: (M.tabHeight - M.dotSize) / 2, width: M.dotSize, height: M.dotSize)
                    : nil
            )
        }
        contentWidth = (tabs.last?.frame.maxX ?? 0) + M.tabsPaddingH
    }

    /// `scrollToTab`: the smallest scroll that brings a tab into view with
    /// 8 to spare, or nil when it is in view already. The strip is never
    /// re-centred under a finger for a tab already on screen.
    public static func revealOffset(tab: CGRect, offset: CGFloat, viewport: CGFloat, contentWidth: CGFloat) -> CGFloat? {
        let left = tab.minX - Metrics.scrollMargin
        let right = tab.maxX + Metrics.scrollMargin
        if left >= offset && right <= offset + viewport { return nil }
        let target = left < offset ? left : right - viewport
        return min(max(0, target), max(0, contentWidth - viewport))
    }
}
