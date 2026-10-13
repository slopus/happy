import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// AgentInput.tsx on an iPhone: the card with the rows around it.
///
///     8 ┌ status row: ● connection text ─────────────────── 16 ┐ ← top
///       ├ card (AgentInputCardLayout) ─────────────────────────┤ ← cardOffset
///       └──────────────────────────────────────────────────────┘
///         usage row:                  52% week   12% context ◔  (18 in)
///     8
///
/// The status and usage rows fade while the reader is back in history and
/// keep their space. The suggestion list floats above the composer, outside
/// its bounds (`autocomplete(rows:border:)`). In a window wider than 700
/// points the card is the flat panel (`AgentInputDesktopLayout`) and the
/// rest stays.
///
/// Frames are in the composer's bounds; the card's own content is in
/// `cardLayout` or `desktopLayout`, in the card's bounds.
public struct AgentInputLayout: Equatable, Sendable {
    public enum Metrics {
        /// `CONTAINER_TOP_PADDING` and the container's bottom padding.
        public static let containerPaddingTop: CGFloat = 8
        public static let containerPaddingBottom: CGFloat = 8
        /// `paddingHorizontal: screenWidth > 700 ? 12 : 8`.
        public static let containerPaddingH: CGFloat = 8
        public static let containerPaddingHWide: CGFloat = 12

        // AgentInputStatusRow
        public static let statusPaddingH: CGFloat = 16
        public static let statusPaddingBottom: CGFloat = 4
        public static let statusMinHeight: CGFloat = 20
        public static let statusDotSize: CGFloat = 6
        /// Optically centres the dot on the 11pt text.
        public static let statusDotMarginTop: CGFloat = 1
        public static let statusDotGap: CGFloat = 4

        // AgentInputUsageRow
        /// 10pt shell inset + 8pt action inset: the gauge lines up with the
        /// effort label's right edge.
        public static let usagePaddingH: CGFloat = 18
        public static let usagePaddingTop: CGFloat = 6
        public static let usageMinHeight: CGFloat = 18
        public static let usageGap: CGFloat = 10
        public static let usageGaugeGap: CGFloat = 5
        public static let usageGaugeSize: CGFloat = 14
        public static let usageGaugeStroke: CGFloat = 2.5
        /// The context tap target's hitSlop: top, left, bottom, right.
        public static let usageContextSlop = LayoutInsets(top: 12, left: 10, bottom: 14, right: 14)
        /// The week text's padded menu trigger (`padding: 10, margin: -10`).
        public static let usageWeekSlop: CGFloat = 10

        // AgentInputAutocomplete
        public static let autocompleteMarginBottom: CGFloat = 8
        public static let autocompletePaddingH: CGFloat = 8
        public static let autocompleteMaxHeight: CGFloat = 320
        public static let autocompleteRowHeight: CGFloat = 48
        public static let autocompleteRadius: CGFloat = 24

        /// AnimatedFade: 180ms in, 140ms out.
        public static let fadeInDuration: Double = 0.18
        public static let fadeOutDuration: Double = 0.14
    }

    /// What sits between the rows, without its width (the layout supplies
    /// it).
    public enum Panel: Equatable, Sendable {
        /// The compact mobile card.
        case card(AgentInputCardLayout.Input)
        /// The flat panel of a window wider than 700 points.
        case desktop(AgentInputDesktopLayout.Input)
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        /// The container's side padding (8 on a phone).
        public var paddingH: CGFloat
        /// `layout.maxWidth` for the inner container.
        public var maxContentWidth: CGFloat
        /// happy-app's `screenWidth`, the window's, which the 700-point
        /// rules read; nil takes the composer's own width.
        public var screenWidth: CGFloat?
        /// The status row's text, measured; nil hides the row.
        public var statusText: CGSize?
        public var panel: Panel
        /// The usage row's week and context texts; both nil hides the row.
        public var usageWeek: CGSize?
        public var usageContext: CGSize?

        public init(
            width: CGFloat,
            paddingH: CGFloat = Metrics.containerPaddingH,
            maxContentWidth: CGFloat = .greatestFiniteMagnitude,
            screenWidth: CGFloat? = nil,
            statusText: CGSize? = nil,
            panel: Panel,
            usageWeek: CGSize? = nil,
            usageContext: CGSize? = nil
        ) {
            self.width = width
            self.paddingH = paddingH
            self.maxContentWidth = maxContentWidth
            self.screenWidth = screenWidth
            self.statusText = statusText
            self.panel = panel
            self.usageWeek = usageWeek
            self.usageContext = usageContext
        }

        /// The compact card.
        public init(
            width: CGFloat,
            paddingH: CGFloat = Metrics.containerPaddingH,
            maxContentWidth: CGFloat = .greatestFiniteMagnitude,
            screenWidth: CGFloat? = nil,
            statusText: CGSize? = nil,
            card: AgentInputCardLayout.Input,
            usageWeek: CGSize? = nil,
            usageContext: CGSize? = nil
        ) {
            self.init(
                width: width, paddingH: paddingH, maxContentWidth: maxContentWidth, screenWidth: screenWidth,
                statusText: statusText, panel: .card(card), usageWeek: usageWeek, usageContext: usageContext
            )
        }
    }

    /// The status row: the dot and its text.
    public struct StatusRow: Equatable, Sendable {
        public var frame: CGRect
        public var dot: CGRect
        public var text: CGRect
    }

    /// The usage row under the card.
    public struct UsageRow: Equatable, Sendable {
        public var frame: CGRect
        public var week: CGRect?
        /// The context text and its gauge, one tap target.
        public var context: CGRect?
        public var contextText: CGRect?
        public var gauge: CGRect?
    }

    public var size: CGSize
    /// The inner container: the composer less its side padding.
    public var inner: CGRect
    public var status: StatusRow?
    /// The card or the panel.
    public var card: CGRect
    /// The compact card's content; nil for the panel.
    public var cardLayout: AgentInputCardLayout?
    /// The panel's content; nil for the compact card.
    public var desktopLayout: AgentInputDesktopLayout?
    public var usage: UsageRow?
    /// The window is wider than 700 points.
    public var isWide: Bool

    /// From the composer's top to the card's (`onActionAreaOffsetChange`).
    public var cardOffset: CGFloat { card.minY }

    /// The inner container's width, which is the card's: measure the card's
    /// text at this width.
    public static func innerWidth(width: CGFloat, paddingH: CGFloat, maxContentWidth: CGFloat) -> CGFloat {
        min(max(0, max(0, width) - 2 * paddingH), maxContentWidth)
    }

    /// `paddingHorizontal: screenWidth > 700 ? 12 : 8`.
    public static func paddingH(screenWidth: CGFloat) -> CGFloat {
        isWide(screenWidth: screenWidth) ? Metrics.containerPaddingHWide : Metrics.containerPaddingH
    }

    /// `screenWidth > 700`: the wide container padding, the suggestion
    /// list's sides and, on a phone or tablet, the flat panel
    /// (`compactMobileComposer` false).
    public static func isWide(screenWidth: CGFloat) -> Bool {
        screenWidth > 700
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let innerWidth = Self.innerWidth(width: width, paddingH: input.paddingH, maxContentWidth: input.maxContentWidth)
        let innerX = (width - innerWidth) / 2
        var y = M.containerPaddingTop

        // [dot 6, 1 down] 4 [text], centred in a row at least 20 tall with 4
        // under it.
        if let text = input.statusText {
            let dotBox = M.statusDotSize + M.statusDotMarginTop
            let group = max(dotBox, text.height)
            let height = max(M.statusMinHeight, group + M.statusPaddingBottom)
            let groupY = y + (height - M.statusPaddingBottom - group) / 2
            let x = innerX + M.statusPaddingH
            let textX = x + M.statusDotSize + M.statusDotGap
            status = StatusRow(
                frame: CGRect(x: innerX, y: y, width: innerWidth, height: height),
                dot: CGRect(x: x, y: groupY + (group - dotBox) / 2 + M.statusDotMarginTop, width: M.statusDotSize, height: M.statusDotSize),
                text: CGRect(
                    x: textX,
                    y: groupY + (group - text.height) / 2,
                    width: min(text.width, max(0, innerX + innerWidth - M.statusPaddingH - textX)),
                    height: text.height
                )
            )
            y += height
        } else {
            status = nil
        }

        isWide = Self.isWide(screenWidth: input.screenWidth ?? width)
        let panelHeight: CGFloat
        switch input.panel {
        case .card(var cardInput):
            cardInput.width = innerWidth
            let layout = AgentInputCardLayout(cardInput)
            cardLayout = layout
            desktopLayout = nil
            panelHeight = layout.size.height
        case .desktop(var desktopInput):
            desktopInput.width = innerWidth
            let layout = AgentInputDesktopLayout(desktopInput)
            cardLayout = nil
            desktopLayout = layout
            panelHeight = layout.size.height
        }
        card = CGRect(x: innerX, y: y, width: innerWidth, height: panelHeight)
        y += card.height

        // Right-aligned: [week] 10 [context 5 gauge].
        if input.usageWeek != nil || input.usageContext != nil {
            let contextHeight = input.usageContext.map { max($0.height, M.usageGaugeSize) } ?? 0
            let content = max(input.usageWeek?.height ?? 0, contextHeight)
            let height = max(M.usageMinHeight, M.usagePaddingTop + content)
            let top = y + M.usagePaddingTop
            let inner = height - M.usagePaddingTop
            var right = innerX + innerWidth - M.usagePaddingH
            var row = UsageRow(frame: CGRect(x: innerX, y: y, width: innerWidth, height: height))
            if let text = input.usageContext {
                let groupWidth = text.width + M.usageGaugeGap + M.usageGaugeSize
                let group = CGRect(x: right - groupWidth, y: top + (inner - contextHeight) / 2, width: groupWidth, height: contextHeight)
                row.context = group
                row.contextText = CGRect(x: group.minX, y: group.minY + (contextHeight - text.height) / 2, width: text.width, height: text.height)
                row.gauge = CGRect(x: group.maxX - M.usageGaugeSize, y: group.minY + (contextHeight - M.usageGaugeSize) / 2, width: M.usageGaugeSize, height: M.usageGaugeSize)
                right = group.minX - M.usageGap
            }
            if let text = input.usageWeek {
                row.week = CGRect(x: right - text.width, y: top + (inner - text.height) / 2, width: text.width, height: text.height)
            }
            usage = row
            y += height
        } else {
            usage = nil
        }

        y += M.containerPaddingBottom
        inner = CGRect(x: innerX, y: M.containerPaddingTop, width: innerWidth, height: y - M.containerPaddingTop - M.containerPaddingBottom)
        size = CGSize(width: width, height: y)
    }

    /// The suggestion list: above the composer (`bottom: '100%'`), 8 over
    /// the inner container and 8 in from its sides (none past 700 wide),
    /// sized for `rows` 48pt rows up to 320 inside a `border` rim. Its
    /// bottom edge is the composer's top.
    public func autocomplete(rows: Int, border: CGFloat) -> CGRect {
        typealias M = Metrics
        let list = CGFloat(max(0, rows)) * M.autocompleteRowHeight + 2 * max(0, border)
        let height = min(M.autocompleteMaxHeight, list)
        let bottom = inner.minY - M.autocompleteMarginBottom
        let paddingH = isWide ? 0 : M.autocompletePaddingH
        return CGRect(
            x: inner.minX + paddingH,
            y: bottom - height,
            width: max(0, inner.width - 2 * paddingH),
            height: height
        )
    }
}

