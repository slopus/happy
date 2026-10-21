import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Settings › Usage (components/usage/UsagePanel.tsx, UsageChart.tsx and
// UsageBar.tsx, iOS values). Each section is its own block in the page's
// grouped list; RN's margins do not collapse, so neither do these.

/// Today / Last 7 days / Last 30 days: equal buttons in a rounded card.
///
///     ╭─ 16 from every edge, 8 padding ─────────────────────────────╮
///     │ [  Today  ] 8 [ Last 7 days ] 8 [ Last 30 days ]            │
///     ╰─────────────────────────────────────────────────────────────╯
public struct UsagePeriodSelectorLayout: Equatable, Sendable {
    public enum Metrics {
        public static let margin: CGFloat = 16
        public static let padding: CGFloat = 8
        public static let gap: CGFloat = 8
        public static let buttonPaddingVertical: CGFloat = 8
        public static let buttonPaddingHorizontal: CGFloat = 12
        public static let cornerRadius: CGFloat = 20
        public static let buttonCornerRadius: CGFloat = 8
    }

    public var size: CGSize
    public var card: CGRect
    /// In the card's coordinates.
    public var buttons: [CGRect]
    /// In each button's coordinates.
    public var labels: [CGRect]

    public init(width: CGFloat, labels: [Measurable]) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - M.margin * 2)
        let count = CGFloat(max(1, labels.count))
        let buttonWidth = max(0, (cardWidth - M.padding * 2 - M.gap * (count - 1)) / count)
        let textWidth = max(0, buttonWidth - M.buttonPaddingHorizontal * 2)
        let sizes = labels.map { $0.size(fitting: textWidth) }
        let buttonHeight = (sizes.map(\.height).max() ?? 0) + M.buttonPaddingVertical * 2
        buttons = sizes.indices.map { index in
            CGRect(x: M.padding + CGFloat(index) * (buttonWidth + M.gap), y: M.padding, width: buttonWidth, height: buttonHeight)
        }
        self.labels = sizes.map { size in
            CGRect(x: (buttonWidth - size.width) / 2, y: (buttonHeight - size.height) / 2, width: size.width, height: size.height)
        }
        card = CGRect(x: M.margin, y: M.margin, width: cardWidth, height: buttonHeight + M.padding * 2)
        size = CGSize(width: width, height: card.maxY + M.margin)
    }
}

/// Total Tokens / Total Cost: label left, value right, in a card.
public struct UsageStatsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let margin: CGFloat = 16
        public static let padding: CGFloat = 16
        public static let gap: CGFloat = 12
        public static let cornerRadius: CGFloat = 20
    }

    public struct Row {
        public var label: Measurable
        public var value: Measurable

        public init(label: Measurable, value: Measurable) {
            self.label = label
            self.value = value
        }
    }

    public var size: CGSize
    public var card: CGRect
    /// In the card's coordinates.
    public var labels: [CGRect]
    public var values: [CGRect]

    public init(width: CGFloat, rows: [Row]) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - M.margin * 2)
        let inner = max(0, cardWidth - M.padding * 2)
        var y = M.padding
        var labels: [CGRect] = []
        var values: [CGRect] = []
        for (index, row) in rows.enumerated() {
            let value = row.value.size(fitting: inner)
            let label = row.label.size(fitting: max(0, inner - value.width))
            let height = max(value.height, label.height)
            labels.append(CGRect(x: M.padding, y: y + (height - label.height) / 2, width: label.width, height: label.height))
            values.append(CGRect(x: cardWidth - M.padding - value.width, y: y + (height - value.height) / 2, width: value.width, height: value.height))
            y += height + (index < rows.count - 1 ? M.gap : 0)
        }
        self.labels = labels
        self.values = values
        card = CGRect(x: M.margin, y: M.margin, width: cardWidth, height: y + M.padding)
        size = CGSize(width: width, height: card.maxY + M.margin)
    }
}

/// "Usage over time": a card with the title, the Tokens/Cost toggle and
/// the chart, which scrolls sideways inside it.
public struct UsageChartSectionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginTop: CGFloat = 16
        public static let marginHorizontal: CGFloat = 16
        public static let cornerRadius: CGFloat = 20
        public static let titleMarginHorizontal: CGFloat = 16
        public static let titleMarginTop: CGFloat = 16
        public static let titleMarginBottom: CGFloat = 8
        public static let togglePadding: CGFloat = 16
        public static let toggleGap: CGFloat = 16
        public static let toggleButtonPaddingVertical: CGFloat = 6
        public static let toggleButtonPaddingHorizontal: CGFloat = 16
        public static let toggleButtonCornerRadius: CGFloat = 16
        public static let chartMarginVertical: CGFloat = 16
    }

    public var size: CGSize
    public var card: CGRect
    /// The rest are in the card's coordinates.
    public var title: CGRect
    public var toggles: [CGRect]
    /// In each toggle's coordinates.
    public var toggleLabels: [CGRect]
    public var chart: CGRect

    public init(width: CGFloat, title: Measurable, toggles: [Measurable], chartHeight: CGFloat) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - M.marginHorizontal * 2)
        let titleWidth = max(0, cardWidth - M.titleMarginHorizontal * 2)
        let titleHeight = title.height(fitting: titleWidth)
        self.title = CGRect(x: M.titleMarginHorizontal, y: M.titleMarginTop, width: titleWidth, height: titleHeight)

        let labelSizes = toggles.map { $0.size(fitting: cardWidth) }
        let buttonSizes = labelSizes.map {
            CGSize(width: $0.width + M.toggleButtonPaddingHorizontal * 2, height: $0.height + M.toggleButtonPaddingVertical * 2)
        }
        let rowWidth = buttonSizes.map(\.width).reduce(0, +) + M.toggleGap * CGFloat(max(0, buttonSizes.count - 1))
        let rowHeight = buttonSizes.map(\.height).max() ?? 0
        let rowY = self.title.maxY + M.titleMarginBottom + M.togglePadding
        var x = (cardWidth - rowWidth) / 2
        var frames: [CGRect] = []
        for size in buttonSizes {
            frames.append(CGRect(x: x, y: rowY + (rowHeight - size.height) / 2, width: size.width, height: size.height))
            x += size.width + M.toggleGap
        }
        self.toggles = frames
        toggleLabels = zip(labelSizes, buttonSizes).map { label, button in
            CGRect(x: (button.width - label.width) / 2, y: (button.height - label.height) / 2, width: label.width, height: label.height)
        }
        chart = CGRect(x: 0, y: rowY + rowHeight + M.togglePadding + M.chartMarginVertical, width: cardWidth, height: chartHeight)
        card = CGRect(x: M.marginHorizontal, y: M.marginTop, width: cardWidth, height: chart.maxY + M.chartMarginVertical)
        size = CGSize(width: width, height: card.maxY)
    }
}

/// The bars inside the chart's horizontal scroll. Each bar sits in a
/// 40-wide slot with 2 either side, bottom-aligned above a 40pt band for
/// the slanted date labels, with its value above it when there is room.
///
/// RN scales a bar against the whole chart height and lets the tallest one
/// run past the top; here bars scale to the room under the value labels.
public struct UsageChartLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 180
        public static let paddingHorizontal: CGFloat = 8
        public static let paddingBottom: CGFloat = 40
        public static let slotWidth: CGFloat = 40
        public static let slotMargin: CGFloat = 2
        public static let minBarHeight: CGFloat = 2
        public static let valueMarginBottom: CGFloat = 4
        /// A bar this short or shorter hides its value.
        public static let valueMinBarHeight: CGFloat = 20
        public static let labelWidth: CGFloat = 60
        /// The date label's bottom edge sits this far under the bars.
        public static let labelBottomOffset: CGFloat = 24
        public static let cornerRadius: CGFloat = 4
        /// RN draws at most the last 30 points.
        public static let maxBars = 30
    }

    public var contentSize: CGSize
    public var bars: [CGRect]
    /// nil where the value is hidden.
    public var values: [CGRect?]
    /// Unrotated; the view turns each by -45° about its centre.
    public var labels: [CGRect]

    /// `fractions` are each bar's value over the largest, in 0...1.
    public init(fractions: [CGFloat], value: CGSize, label: CGSize, height: CGFloat = Metrics.height) {
        typealias M = Metrics
        let baseline = height - M.paddingBottom
        let plot = max(0, baseline - value.height - M.valueMarginBottom)
        var bars: [CGRect] = []
        var values: [CGRect?] = []
        var labels: [CGRect] = []
        for (index, fraction) in fractions.enumerated() {
            let slotX = M.paddingHorizontal + CGFloat(index) * (M.slotWidth + M.slotMargin * 2) + M.slotMargin
            let barHeight = max(M.minBarHeight, plot * min(1, max(0, fraction)))
            let bar = CGRect(x: slotX, y: baseline - barHeight, width: M.slotWidth, height: barHeight)
            bars.append(bar)
            values.append(fraction > 0 && barHeight > M.valueMinBarHeight
                ? CGRect(x: bar.midX - value.width / 2, y: bar.minY - M.valueMarginBottom - value.height, width: value.width, height: value.height)
                : nil)
            labels.append(CGRect(
                x: bar.midX - M.labelWidth / 2,
                y: baseline + M.labelBottomOffset - label.height,
                width: M.labelWidth,
                height: label.height
            ))
        }
        self.bars = bars
        self.values = values
        self.labels = labels
        let contentWidth = M.paddingHorizontal * 2 + CGFloat(fractions.count) * (M.slotWidth + M.slotMargin * 2)
        contentSize = CGSize(width: contentWidth, height: height)
    }
}

/// "By Model": a name and count over a thin bar, per model.
public struct UsageModelBarsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 16
        public static let rowMarginVertical: CGFloat = 8
        public static let labelMarginBottom: CGFloat = 4
        public static let trackHeight: CGFloat = 8
        public static let trackCornerRadius: CGFloat = 4
    }

    public struct Row {
        public var label: Measurable
        public var value: Measurable
        /// The fill's share of the track, 0...1.
        public var fraction: CGFloat

        public init(label: Measurable, value: Measurable, fraction: CGFloat) {
            self.label = label
            self.value = value
            self.fraction = fraction
        }
    }

    public var size: CGSize
    public var labels: [CGRect]
    public var values: [CGRect]
    public var tracks: [CGRect]
    public var fills: [CGRect]

    public init(width: CGFloat, rows: [Row]) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - M.padding * 2)
        var y = M.padding
        var labels: [CGRect] = []
        var values: [CGRect] = []
        var tracks: [CGRect] = []
        var fills: [CGRect] = []
        for row in rows {
            y += M.rowMarginVertical
            let value = row.value.size(fitting: inner)
            let label = row.label.size(fitting: max(0, inner - value.width))
            let lineHeight = max(label.height, value.height)
            labels.append(CGRect(x: M.padding, y: y, width: label.width, height: label.height))
            values.append(CGRect(x: M.padding + inner - value.width, y: y, width: value.width, height: value.height))
            y += lineHeight + M.labelMarginBottom
            let track = CGRect(x: M.padding, y: y, width: inner, height: M.trackHeight)
            tracks.append(track)
            fills.append(CGRect(x: track.minX, y: track.minY, width: inner * min(1, max(0, row.fraction)), height: M.trackHeight))
            y += M.trackHeight + M.rowMarginVertical
        }
        self.labels = labels
        self.values = values
        self.tracks = tracks
        self.fills = fills
        size = CGSize(width: width, height: y + M.padding)
    }
}

/// The page while loading (a spinner centred on the screen) or after a
/// failure (an icon over the message, near the top): UsagePanel.tsx
/// `loadingContainer` and `errorContainer`.
public struct UsageStatusLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 32
        public static let errorIconSize: CGFloat = 48
    }

    public static func spinner(size: CGSize, safeArea: LayoutInsets, spinner: CGSize) -> CGRect {
        let width = size.width - safeArea.horizontal
        let height = size.height - safeArea.vertical
        return CGRect(
            x: safeArea.left + (width - spinner.width) / 2,
            y: safeArea.top + (height - spinner.height) / 2,
            width: spinner.width,
            height: spinner.height
        )
    }

    public var icon: CGRect
    public var message: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, message: Measurable) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let inner = max(0, width - M.padding * 2)
        let top = safeArea.top + M.padding
        icon = CGRect(x: safeArea.left + (width - M.errorIconSize) / 2, y: top, width: M.errorIconSize, height: M.errorIconSize)
        let text = message.size(fitting: inner)
        self.message = CGRect(x: safeArea.left + (width - text.width) / 2, y: icon.maxY, width: text.width, height: text.height)
    }
}
