import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The System Monitor's card rows, each in its slot's coordinates (the
// list's width, the row's height), in the readable column (`CardColumn`).
// A resource's card opens with its reading, then a row per detail; the
// processes' card with the filter and sort, then a row per process.
//
//     |16| [tile] CPU ……………………………… 26.1% |16|
//     |16| Apple M3 Max ……………………………………………… |16|
//     |16| ╱╲__╱╲_ chart ……………………………………… |16|
//     |16| ▂▅▃▇ per-core bars …………………………… |16|

private func pixel(_ value: CGFloat, _ scale: CGFloat) -> CGFloat {
    (value * max(1, scale)).rounded() / max(1, scale)
}

/// A resource's reading: its tile and name with the value at the line's
/// end, the subtitle under them, then its chart and bars when it has them.
public struct MonitorSummaryLayout: Equatable, Sendable {
    public var size: CGSize
    public var card: CGRect
    public var tile: CGRect
    public var title: CGRect
    public var value: CGRect
    public var subtitle: CGRect
    public var chart: CGRect?
    public var bars: CGRect?
    public var separator: CGRect?

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, title: Measurable, value: Measurable, subtitle: Measurable, chart: Bool, bars: Bool, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = MonitorMetrics
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let left = column.x + CardListMetrics.inset
        let right = column.maxX - CardListMetrics.inset
        let top = M.padding
        tile = CGRect(x: left, y: top, width: M.tile, height: M.tile)
        let textX = tile.maxX + M.tileGap
        let valueSize = value.size(fitting: max(0, right - textX))
        self.value = CGRect(x: right - valueSize.width, y: pixel(top + (M.tile - valueSize.height) / 2, scale), width: valueSize.width, height: valueSize.height)
        let titleWidth = max(0, self.value.minX - CardListMetrics.trailingGap - textX)
        let titleSize = title.size(fitting: titleWidth)
        self.title = CGRect(x: textX, y: pixel(top + (M.tile - titleSize.height) / 2, scale), width: titleWidth, height: titleSize.height)
        let subtitleSize = subtitle.size(fitting: max(0, right - left))
        self.subtitle = CGRect(x: left, y: top + M.tile + M.subtitleGap, width: max(0, right - left), height: subtitleSize.height)
        var y = self.subtitle.maxY
        if chart {
            self.chart = CGRect(x: left, y: y + M.chartGap, width: max(0, right - left), height: M.chartHeight)
            y = self.chart!.maxY
        }
        if bars {
            self.bars = CGRect(x: left, y: y + M.barsGap, width: max(0, right - left), height: M.barsHeight)
            y = self.bars!.maxY
        }
        let height = pixel(y + M.padding, scale)
        size = CGSize(width: max(0, width), height: height)
        card = CGRect(x: column.x, y: 0, width: column.width, height: height)
        separator = place.last ? nil : CGRect(x: left, y: height - hairline, width: max(0, column.maxX - left), height: hairline)
    }
}

/// One detail of a resource: its label and value on one line, with a
/// meter under them, and a quieter note under that, when it has them.
public struct MonitorDetailLayout: Equatable, Sendable {
    public var size: CGSize
    public var card: CGRect
    /// A dot before the label (a chart's line it names).
    public var dot: CGRect?
    public var label: CGRect
    public var value: CGRect
    public var meter: CGRect?
    public var note: CGRect?
    public var separator: CGRect?

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, dot: Bool = false, label: Measurable, value: Measurable, meter: Bool, note: Measurable? = nil, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = MonitorMetrics
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let left = column.x + CardListMetrics.inset
        let right = column.maxX - CardListMetrics.inset
        let valueSize = value.size(fitting: max(0, right - left))
        var labelX = left
        if dot { labelX += M.statusDot + M.statusGap }
        let labelWidth = max(0, right - valueSize.width - CardListMetrics.trailingGap - labelX)
        let labelSize = label.size(fitting: labelWidth)
        let line = max(labelSize.height, valueSize.height)
        let noteSize = note?.size(fitting: max(0, right - left))
        var content = line
        if meter { content += M.meterGap + M.meterHeight }
        if let noteSize { content += M.noteGap + noteSize.height }
        let height = max(M.detailRow, pixel(content + 2 * M.detailPadding, scale))
        let top = pixel((height - content) / 2, scale)
        self.label = CGRect(x: labelX, y: pixel(top + (line - labelSize.height) / 2, scale), width: labelWidth, height: labelSize.height)
        self.value = CGRect(x: right - valueSize.width, y: pixel(top + (line - valueSize.height) / 2, scale), width: valueSize.width, height: valueSize.height)
        self.dot = dot ? CGRect(x: left, y: pixel(top + (line - M.statusDot) / 2, scale), width: M.statusDot, height: M.statusDot) : nil
        var y = top + line
        if meter {
            self.meter = CGRect(x: left, y: y + M.meterGap, width: max(0, right - left), height: M.meterHeight)
            y = self.meter!.maxY
        }
        if let noteSize {
            self.note = CGRect(x: left, y: y + M.noteGap, width: max(0, right - left), height: noteSize.height)
        }
        size = CGSize(width: max(0, width), height: height)
        card = CGRect(x: column.x, y: 0, width: column.width, height: height)
        separator = place.last ? nil : CGRect(x: left, y: height - hairline, width: max(0, column.maxX - left), height: hairline)
    }
}

/// One process: its name with its CPU over the last minute and its share
/// at the end of the line; who runs it and its state under them, its
/// memory at that line's end.
public struct MonitorProcessLayout: Equatable, Sendable {
    public var size: CGSize
    public var card: CGRect
    public var name: CGRect
    public var spark: CGRect
    public var cpu: CGRect
    public var meta: CGRect
    public var memory: CGRect
    public var separator: CGRect?

    /// `cpuWidth` is the widest a percentage gets ("100.0%"), so the
    /// sparklines stand in one column whatever the numbers.
    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, name: Measurable, cpu: CGSize, cpuWidth: CGFloat, meta: Measurable, memory: CGSize, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = MonitorMetrics
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let left = column.x + CardListMetrics.inset
        let right = column.maxX - CardListMetrics.inset
        let cpuColumn = max(cpuWidth, cpu.width)
        let sparkX = right - cpuColumn - M.sparkGap - M.sparkWidth
        let nameWidth = max(0, sparkX - CardListMetrics.trailingGap - left)
        let nameSize = name.size(fitting: nameWidth)
        let line1 = max(nameSize.height, cpu.height)
        let metaWidth = max(0, right - memory.width - CardListMetrics.trailingGap - left)
        let metaSize = meta.size(fitting: metaWidth)
        let line2 = max(metaSize.height, memory.height)
        let content = line1 + CardListMetrics.lineGap + line2
        let height = max(CardListMetrics.plainRow, pixel(content + 2 * CardListMetrics.padding, scale))
        let top = pixel((height - content) / 2, scale)
        self.name = CGRect(x: left, y: pixel(top + (line1 - nameSize.height) / 2, scale), width: nameWidth, height: nameSize.height)
        self.cpu = CGRect(x: right - cpu.width, y: pixel(top + (line1 - cpu.height) / 2, scale), width: cpu.width, height: cpu.height)
        spark = CGRect(x: sparkX, y: pixel(top + (line1 - M.sparkHeight) / 2, scale), width: M.sparkWidth, height: M.sparkHeight)
        let second = top + line1 + CardListMetrics.lineGap
        self.meta = CGRect(x: left, y: pixel(second + (line2 - metaSize.height) / 2, scale), width: metaWidth, height: metaSize.height)
        self.memory = CGRect(x: right - memory.width, y: pixel(second + (line2 - memory.height) / 2, scale), width: memory.width, height: memory.height)
        size = CGSize(width: max(0, width), height: height)
        card = CGRect(x: column.x, y: 0, width: column.width, height: height)
        separator = place.last ? nil : CGRect(x: left, y: height - hairline, width: max(0, column.maxX - left), height: hairline)
    }
}

/// The machine's own card: its name large, the status at the line's end
/// (a dot and its words), the system and uptime under it.
public struct MonitorHostLayout: Equatable, Sendable {
    public var size: CGSize
    public var card: CGRect
    public var title: CGRect
    public var meta: CGRect
    public var dot: CGRect
    public var status: CGRect

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, title: Measurable, titleLine: CGFloat, meta: Measurable, status: CGSize, scale: CGFloat = 1) {
        typealias M = MonitorMetrics
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let left = column.x + CardListMetrics.inset
        let right = column.maxX - CardListMetrics.inset
        let statusWidth = M.statusDot + M.statusGap + status.width
        let titleWidth = max(0, right - statusWidth - CardListMetrics.trailingGap - left)
        let titleSize = title.size(fitting: titleWidth)
        let metaSize = meta.size(fitting: max(0, right - left))
        let top = M.padding
        self.title = CGRect(x: left, y: top, width: titleWidth, height: titleSize.height)
        let line = min(titleLine, titleSize.height)
        self.status = CGRect(x: right - status.width, y: pixel(top + (line - status.height) / 2, scale), width: status.width, height: status.height)
        dot = CGRect(x: self.status.minX - M.statusGap - M.statusDot, y: pixel(top + (line - M.statusDot) / 2, scale), width: M.statusDot, height: M.statusDot)
        self.meta = CGRect(x: left, y: self.title.maxY + CardListMetrics.lineGap, width: max(0, right - left), height: metaSize.height)
        let height = pixel(self.meta.maxY + M.padding, scale)
        size = CGSize(width: max(0, width), height: height)
        card = CGRect(x: column.x, y: 0, width: column.width, height: height)
    }
}
