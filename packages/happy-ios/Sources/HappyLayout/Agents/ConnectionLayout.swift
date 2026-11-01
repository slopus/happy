import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Settings › Connection: grouped cards in settings' inset style, each
/// with a quiet header over it and a footer under it. A row is one line, a
/// title on the left and its value on the right; a value too long for
/// what the title leaves is cut short, never wrapped. A chart row is its
/// title over a sparkline the card's width.
///
///     STATUS
///     ╭──────────────────────────────────╮
///     │ Type                      Tailcat │
///     │──────────────────────────────────│
///     │ Path               Relayed (DERP) │
///     ╰──────────────────────────────────╯
///     LAST 10 MINUTES
///     ╭──────────────────────────────────╮
///     │ Bytes per minute      peak 12 KB │
///     │ ▁ ▁ ▃ ▁ ▇ ▂ ▁ ▁ ▁ ▅              │
///     ╰──────────────────────────────────╯
public struct ConnectionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 20
        public static let side = SettingsLayout.Metrics.side
        public static let radius = SettingsLayout.Metrics.radius
        public static let cardGap: CGFloat = 24
        /// The header's start inside the card's edge, and its gap to the card.
        public static let headerInset: CGFloat = 16
        public static let headerGap: CGFloat = 6
        public static let rowInset: CGFloat = 16
        /// A one-line row is 44: the text 11 from its top and bottom.
        public static let rowPadding: CGFloat = 11
        public static let rowMinimum: CGFloat = 44
        public static let valueGap: CGFloat = 12
        /// A value is cut short no narrower than this share of the row.
        public static let valueShare: CGFloat = 0.5
        public static let chartGap: CGFloat = 10
        public static let chartHeight: CGFloat = 44
        public static let separator: CGFloat = 1 / 3
        public static let footerGap: CGFloat = 8
        public static let bottom: CGFloat = 32
    }

    public enum RowSpec {
        /// A title and a value, each one line (measured at its full
        /// width); nil for a row that is only its title (an action).
        case text(title: Measurable, value: Measurable?)
        /// A title, a caption at the end of its line, a sparkline under them.
        case chart(title: Measurable, caption: Measurable?)
    }

    public struct CardSpec {
        public var header: Measurable?
        public var rows: [RowSpec]
        public var footer: Measurable?
        public init(header: Measurable? = nil, rows: [RowSpec], footer: Measurable? = nil) {
            self.header = header; self.rows = rows; self.footer = footer
        }
    }

    /// One row: its box in its card's space, the rest in the box's own.
    public struct Row: Equatable, Sendable {
        public var box: CGRect
        public var title: CGRect
        public var value: CGRect?
        public var chart: CGRect?
        /// Under the row from the title's start; nil under a card's last row.
        public var separator: CGRect?
    }

    public struct Card: Equatable, Sendable {
        /// In the page's space, as the header and footer are.
        public var frame: CGRect
        public var header: CGRect?
        public var footer: CGRect?
        public var rows: [Row]
    }

    public var cards: [Card]
    public var contentHeight: CGFloat

    public init(width: CGFloat, cards specs: [CardSpec]) {
        typealias M = Metrics
        let cardWidth = max(0, width - 2 * M.side)
        let inner = max(0, cardWidth - 2 * M.rowInset)
        var y = M.top
        var cards: [Card] = []
        for (index, spec) in specs.enumerated() {
            if index > 0 { y += M.cardGap }
            var header: CGRect?
            if let text = spec.header {
                let size = text.size(fitting: max(0, cardWidth - 2 * M.headerInset))
                header = CGRect(x: M.side + M.headerInset, y: y, width: size.width, height: size.height)
                y += size.height + M.headerGap
            }
            var rows: [Row] = []
            var rowY: CGFloat = 0
            for spec in spec.rows {
                var row: Row
                switch spec {
                case .text(let titleText, let valueText):
                    let title = titleText.size(fitting: inner)
                    let value = valueText?.size(fitting: inner)
                    // The value gets what the title leaves, or its share if
                    // that is more; the title is cut to the rest.
                    let valueWidth = value.map { min($0.width, max(inner - title.width - M.valueGap, inner * M.valueShare)) } ?? 0
                    let titleWidth = min(title.width, value == nil ? inner : inner - valueWidth - M.valueGap)
                    let height = max(M.rowMinimum, max(title.height, value?.height ?? 0) + 2 * M.rowPadding)
                    row = Row(
                        box: CGRect(x: 0, y: rowY, width: cardWidth, height: height),
                        title: CGRect(x: M.rowInset, y: M.rowPadding, width: titleWidth, height: title.height),
                        value: value.map { CGRect(x: cardWidth - M.rowInset - valueWidth, y: M.rowPadding, width: valueWidth, height: $0.height) }
                    )
                case .chart(let titleText, let captionText):
                    let caption = captionText?.size(fitting: inner / 2)
                    let title = titleText.size(fitting: max(0, inner - (caption.map { $0.width + M.valueGap } ?? 0)))
                    let line = max(title.height, caption?.height ?? 0)
                    let chartY = M.rowPadding + line + M.chartGap
                    row = Row(
                        box: CGRect(x: 0, y: rowY, width: cardWidth, height: M.rowPadding + line + M.chartGap + M.chartHeight + M.rowPadding),
                        title: CGRect(x: M.rowInset, y: M.rowPadding, width: title.width, height: title.height),
                        value: caption.map { CGRect(x: cardWidth - M.rowInset - $0.width, y: M.rowPadding, width: $0.width, height: $0.height) },
                        chart: CGRect(x: M.rowInset, y: chartY, width: inner, height: M.chartHeight)
                    )
                }
                if !rows.isEmpty {
                    let above = rows[rows.count - 1].box
                    rows[rows.count - 1].separator = CGRect(x: M.rowInset, y: above.height - M.separator, width: cardWidth - M.rowInset, height: M.separator)
                }
                rows.append(row)
                rowY = row.box.maxY
            }
            let frame = CGRect(x: M.side, y: y, width: cardWidth, height: rowY)
            y = frame.maxY
            var footer: CGRect?
            if let text = spec.footer {
                let size = text.size(fitting: max(0, cardWidth - 2 * M.headerInset))
                footer = CGRect(x: M.side + M.headerInset, y: y + M.footerGap, width: size.width, height: size.height)
                y += M.footerGap + size.height
            }
            cards.append(Card(frame: frame, header: header, footer: footer, rows: rows))
        }
        self.cards = cards
        contentHeight = y + M.bottom
    }

}

/// A sparkline's bars: one per value, the same width, `gap` apart, the
/// tallest the whole height and the rest in proportion, from the bottom.
/// An empty value still shows as a `minimum` stub, so a quiet minute reads
/// as a minute.
public enum SparklineLayout {
    public static let gap: CGFloat = 4
    public static let minimum: CGFloat = 2

    public static func bars(_ values: [Int64], in size: CGSize, gap: CGFloat = SparklineLayout.gap, minimum: CGFloat = SparklineLayout.minimum) -> [CGRect] {
        guard !values.isEmpty, size.width > 0, size.height > 0 else { return [] }
        let count = CGFloat(values.count)
        let width = max(0, (size.width - gap * (count - 1)) / count)
        let peak = values.max() ?? 0
        return values.enumerated().map { index, value in
            let share = peak > 0 ? CGFloat(max(0, value)) / CGFloat(peak) : 0
            let height = max(minimum, (size.height * share).rounded())
            return CGRect(x: CGFloat(index) * (width + gap), y: size.height - height, width: width, height: height)
        }
    }
}
