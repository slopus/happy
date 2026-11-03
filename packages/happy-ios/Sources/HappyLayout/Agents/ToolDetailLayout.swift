import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The head of a Happy Agent tool call's screen (desktop's
/// `ToolCallPreview` heading): its glyph in a rounded tile, what kind of
/// call it is over the tool's own name, and how it stands in a pill at the
/// end, all inside a card. The pill keeps its width; the words take what
/// is left and centre on the tile.
public struct ToolDetailHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 14
        public static let tile: CGFloat = 36
        public static let tileRadius: CGFloat = 10
        public static let glyph: CGFloat = 18
        public static let gap: CGFloat = 12
        public static let lineGap: CGFloat = 2
        public static let pillPaddingH: CGFloat = 10
        public static let pillPaddingV: CGFloat = 4
        public static let radius: CGFloat = 14
    }

    public var size: CGSize
    public var tile: CGRect
    public var glyph: CGRect
    public var title: CGRect
    public var subtitle: CGRect?
    public var pill: CGRect
    public var pillText: CGRect

    /// `pillText` is the status's one-line size; the spinner, when the
    /// call runs, takes `pillLead` before it inside the pill.
    public init(width: CGFloat, title: Measurable, subtitle: Measurable?, pillText: CGSize, pillLead: CGFloat = 0) {
        typealias M = Metrics
        let width = max(0, width)
        let pillSize = CGSize(width: pillText.width + pillLead + 2 * M.pillPaddingH, height: pillText.height + 2 * M.pillPaddingV)
        let textX = M.padding + M.tile + M.gap
        let textWidth = max(0, width - M.padding - pillSize.width - M.gap - textX)
        let titleSize = title.size(fitting: textWidth)
        let subtitleSize = subtitle.map { $0.size(fitting: textWidth) }
        let textHeight = titleSize.height + (subtitleSize.map { $0.height + M.lineGap } ?? 0)
        let inner = max(M.tile, textHeight, pillSize.height)
        let height = inner + 2 * M.padding
        let top = M.padding
        tile = CGRect(x: M.padding, y: top + (inner - M.tile) / 2, width: M.tile, height: M.tile)
        glyph = CGRect(x: tile.midX - M.glyph / 2, y: tile.midY - M.glyph / 2, width: M.glyph, height: M.glyph)
        let textTop = top + (inner - textHeight) / 2
        self.title = CGRect(x: textX, y: textTop, width: titleSize.width, height: titleSize.height)
        self.subtitle = subtitleSize.map { CGRect(x: textX, y: textTop + titleSize.height + M.lineGap, width: $0.width, height: $0.height) }
        pill = CGRect(x: width - M.padding - pillSize.width, y: top + (inner - pillSize.height) / 2, width: pillSize.width, height: pillSize.height)
        self.pillText = CGRect(x: pill.minX + M.pillPaddingH + pillLead, y: pill.minY + M.pillPaddingV, width: pillText.width, height: pillText.height)
        size = CGSize(width: width, height: height)
    }
}

/// One labelled value of a tool call's arguments or result, as a settings
/// row reads: a value that fits on one line beside its label sits at the
/// row's end; anything longer (a block of text, a list, nested fields)
/// goes under its label, the row's width.
public struct ToolFieldLayout: Equatable, Sendable {
    public enum Metrics {
        public static let gap: CGFloat = 12
        public static let stackedGap: CGFloat = 4
    }

    public var size: CGSize
    public var label: CGRect
    public var value: CGRect
    public var stacked: Bool

    /// `inline` says the value may sit beside its label; `oneLine` is its
    /// width on a single line, which decides whether it does.
    public init(width: CGFloat, label: Measurable, value: Measurable, inline: Bool, oneLine: CGFloat) {
        typealias M = Metrics
        let width = max(0, width)
        let labelSize = label.size(fitting: width)
        let besideWidth = width - labelSize.width - M.gap
        if inline, oneLine <= besideWidth {
            let valueSize = value.size(fitting: besideWidth)
            let height = max(labelSize.height, valueSize.height)
            self.label = CGRect(x: 0, y: (height - labelSize.height) / 2, width: labelSize.width, height: labelSize.height)
            self.value = CGRect(x: width - valueSize.width, y: (height - valueSize.height) / 2, width: valueSize.width, height: valueSize.height)
            stacked = false
            size = CGSize(width: width, height: height)
        } else {
            let valueHeight = value.height(fitting: width)
            self.label = CGRect(x: 0, y: 0, width: labelSize.width, height: labelSize.height)
            self.value = CGRect(x: 0, y: labelSize.height + M.stackedGap, width: width, height: valueHeight)
            stacked = true
            size = CGSize(width: width, height: labelSize.height + M.stackedGap + valueHeight)
        }
    }
}

/// Fields in a card: each row inset, a hairline between rows from the
/// rows' leading edge to the card's end, as a grouped table draws them.
public struct ToolFieldsCardLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 14
        public static let paddingV: CGFloat = 11
        public static let radius: CGFloat = 12
        public static let separator: CGFloat = 0.5
    }

    public var size: CGSize
    /// Each row's frame, its padding left out.
    public var rows: [CGRect]
    public var separators: [CGRect]

    /// `rows` measures each row at the inner width.
    public init(width: CGFloat, rows: [Measurable], separator: CGFloat = Metrics.separator) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - 2 * M.paddingH)
        var y: CGFloat = 0
        var frames: [CGRect] = []
        var lines: [CGRect] = []
        for (index, row) in rows.enumerated() {
            if index > 0 {
                lines.append(CGRect(x: M.paddingH, y: y, width: width - M.paddingH, height: separator))
            }
            let height = row.height(fitting: inner)
            frames.append(CGRect(x: M.paddingH, y: y + M.paddingV, width: inner, height: height))
            y += height + 2 * M.paddingV
        }
        self.rows = frames
        separators = lines
        size = CGSize(width: width, height: y)
    }
}
