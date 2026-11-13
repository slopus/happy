import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A line, area or bar `plot`: the legend on top, then tick labels in a
/// column at the leading edge, the plot beside them at about 16:9, and
/// category labels under each band's middle. The daemon has placed the ticks; this
/// only scales them to the width.
public struct GenUIPlotLayout: Equatable, Sendable {
    public enum Metrics {
        /// The plot's height over the chart's width.
        public static let aspect: CGFloat = 9.0 / 16.0
        public static let maxPlotHeight: CGFloat = 260
        public static let axisGap: CGFloat = 8
        public static let labelGap: CGFloat = 6
        public static let legendGap: CGFloat = 12
        public static let legendItemGap: CGFloat = 16
        public static let legendLineGap: CGFloat = 6
        public static let legendDot: CGFloat = 8
        public static let legendDotGap: CGFloat = 6
        public static let legendRow: CGFloat = 18
    }

    public var plot: CGRect
    /// One per tick, right-aligned against the plot.
    public var tickLabels: [CGRect]
    /// One per category, centred under its band.
    public var categoryLabels: [CGRect]
    public var legend: [CGRect]
    public var size: CGSize

    /// `fractions` place the ticks (0 at the foot); `tickLabelWidth` is the
    /// widest tick label; `legend` each legend entry's size.
    public init(width: CGFloat, fractions: [Double], tickLabelWidth: CGFloat, categories: Int, labelLine: CGFloat, legend: [CGSize]) {
        typealias M = Metrics
        // The legend first, as the other platforms draw it: what the lines
        // are before the lines.
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        for size in legend {
            let w = min(size.width, width)
            if x > 0, x + w > width {
                x = 0
                y += M.legendRow + M.legendLineGap
            }
            frames.append(CGRect(x: x, y: y, width: w, height: M.legendRow))
            x += w + M.legendItemGap
        }
        self.legend = frames
        let axisWidth = ceil(tickLabelWidth)
        let top = (frames.last.map { $0.maxY + M.legendGap } ?? 0) + labelLine / 2
        let plotHeight = min(M.maxPlotHeight, (width * M.aspect).rounded())
        let plot = CGRect(x: axisWidth + M.axisGap, y: top, width: max(0, width - axisWidth - M.axisGap), height: plotHeight)
        self.plot = plot
        tickLabels = fractions.map { fraction in
            let y = top + plotHeight * (1 - CGFloat(fraction))
            return CGRect(x: 0, y: y - labelLine / 2, width: axisWidth, height: labelLine)
        }
        let band = categories > 0 ? plot.width / CGFloat(categories) : 0
        let labelY = plot.maxY + M.labelGap
        categoryLabels = (0..<categories).map { CGRect(x: plot.minX + band * CGFloat($0), y: labelY, width: band, height: labelLine) }
        size = CGSize(width: width, height: labelY + labelLine)
    }

    /// The x of category `index`'s middle.
    public func center(_ index: Int, of count: Int) -> CGFloat {
        guard count > 0 else { return plot.midX }
        return plot.minX + plot.width / CGFloat(count) * (CGFloat(index) + 0.5)
    }

    /// A bar group in category `index`: `series` bars side by side, or one
    /// stacked bar, in the middle 64% of the band.
    public func bars(_ index: Int, of count: Int, series: Int, stacked: Bool) -> [CGRect] {
        guard count > 0, series > 0 else { return [] }
        let band = plot.width / CGFloat(count)
        let group = min(band * 0.64, stacked ? 40 : CGFloat(series) * 28)
        let x0 = plot.minX + band * CGFloat(index) + (band - group) / 2
        if stacked { return Array(repeating: CGRect(x: x0, y: plot.minY, width: group, height: plot.height), count: series) }
        let gap: CGFloat = series > 1 ? 3 : 0
        let bar = (group - gap * CGFloat(series - 1)) / CGFloat(series)
        return (0..<series).map { CGRect(x: x0 + CGFloat($0) * (bar + gap), y: plot.minY, width: bar, height: plot.height) }
    }
}

/// A donut: the ring centred at the top, its centre text in the hole, and
/// a legend row per slice under it (name, value, share).
public struct GenUIDonutLayout: Equatable, Sendable {
    public enum Metrics {
        public static let maxDiameter: CGFloat = 188
        public static let thickness: CGFloat = 26
        public static let legendGap: CGFloat = 18
        public static let legendRow: CGFloat = 32
    }

    public var ring: CGRect
    /// The centre's value and its label, in the hole.
    public var total: CGRect
    public var totalLabel: CGRect
    public var rows: [CGRect]
    public var size: CGSize

    public init(width: CGFloat, rows count: Int, totalLine: CGFloat, labelLine: CGFloat) {
        typealias M = Metrics
        let diameter = min(M.maxDiameter, width)
        ring = CGRect(x: (width - diameter) / 2, y: 0, width: diameter, height: diameter)
        let block = totalLine + labelLine
        total = CGRect(x: ring.minX + M.thickness, y: ring.midY - block / 2, width: max(0, diameter - 2 * M.thickness), height: totalLine)
        totalLabel = CGRect(x: total.minX, y: total.maxY, width: total.width, height: labelLine)
        let top = ring.maxY + M.legendGap
        rows = (0..<count).map { CGRect(x: 0, y: top + CGFloat($0) * M.legendRow, width: width, height: M.legendRow) }
        size = CGSize(width: width, height: rows.last?.maxY ?? ring.maxY)
    }
}
