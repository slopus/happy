#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// `plot`: a chart whose ticks, labels and colours the daemon computed.
/// Line, area and bar share a value axis with light gridlines; a donut
/// shows its centre text in the hole and a legend row per slice. Only
/// scaling and drawing happen here.
final class GenUIPlotView: GenUIElementView {
    private let plot: GenUIPlot
    private let tickStrings: [NSAttributedString]
    private let legendStrings: [NSAttributedString]

    private var labelLine: CGFloat { ChatTextStyles.genuiAxis.lineHeight ?? 14 }

    init(key: String, _ plot: GenUIPlot) {
        self.plot = plot
        tickStrings = (plot.y?.ticks ?? []).map {
            genuiString($0.label, ChatTextStyles.genuiAxis, GenUIColors.axisLabel, alignment: .right, tabular: true)
        }
        legendStrings = plot.legend.map { genuiString($0.label, ChatTextStyles.genuiCaption, Palette.cardDetail, truncates: true) }
        super.init(key: key)
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityLabel = plot.summary
        accessibilityTraits = .image
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GenUIPlotView, _) in view.setNeedsDisplay() }
    }

    static func color(_ color: GenUIPlot.Color) -> ColorToken {
        switch color {
        case .muted: GenUIColors.muted
        case .index(let index): GenUIColors.series(index)
        // A name the theme doesn't know steps back rather than vanishing.
        case .named(let name): GenUIColors.theme?.ink[name] ?? GenUIColors.muted
        }
    }

    private func layout(_ width: CGFloat) -> GenUIPlotLayout {
        typealias M = GenUIPlotLayout.Metrics
        return GenUIPlotLayout(
            width: width,
            fractions: (plot.y?.ticks ?? []).map { plot.y?.fraction($0.value) ?? 0 },
            tickLabelWidth: tickStrings.map { $0.size().width }.max() ?? 0,
            categories: plot.x.count,
            labelLine: labelLine,
            legend: legendStrings.map { CGSize(width: M.legendDot + M.legendDotGap + ceil($0.size().width), height: M.legendRow) }
        )
    }

    private func donut(_ width: CGFloat) -> GenUIDonutLayout {
        GenUIDonutLayout(
            width: width, rows: plot.legend.count, totalLine: ChatTextStyles.genuiDonutTotal.lineHeight ?? 28,
            labelLine: ChatTextStyles.genuiCaption.lineHeight ?? 18
        )
    }

    override func natural(_ width: CGFloat) -> CGSize {
        CGSize(width: width, height: plot.kind == .donut ? donut(width).size.height : layout(width).size.height)
    }

    override var minWidth: CGFloat { 200 }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        if plot.kind == .donut { drawDonut() } else { drawAxes(context) }
    }

    // MARK: Line, area, bar

    private func y(_ value: Double, in frame: CGRect) -> CGFloat {
        frame.maxY - frame.height * CGFloat(plot.y?.fraction(value) ?? 0)
    }

    private func value(_ series: Int, _ index: Int) -> Double? {
        let values = plot.series[series].values
        return values.indices.contains(index) ? values[index] : nil
    }

    private func drawAxes(_ context: CGContext) {
        let layout = layout(bounds.width)
        let frame = layout.plot
        let count = plot.x.count
        let scale = window?.screen.scale ?? traitCollection.displayScale
        let hairline = 1 / max(scale, 1)
        // Gridlines, the foot a shade stronger.
        for (tick, (label, labelFrame)) in zip(plot.y?.ticks ?? [], zip(tickStrings, layout.tickLabels)) {
            let y = (self.y(tick.value, in: frame) * scale).rounded() / scale + hairline / 2
            let foot = tick.value == plot.y?.min
            UIColor(foot ? Palette.divider : GenUIColors.grid).setStroke()
            let line = UIBezierPath()
            line.move(to: CGPoint(x: frame.minX, y: y))
            line.addLine(to: CGPoint(x: frame.maxX, y: y))
            line.lineWidth = foot ? 1 : hairline
            line.stroke()
            label.draw(in: labelFrame)
        }
        // Category labels, thinned to every nth when they would touch.
        let widest = plot.x.map { genuiString($0, ChatTextStyles.genuiAxis, GenUIColors.axisLabel).size().width }.max() ?? 0
        let band = count > 0 ? frame.width / CGFloat(count) : 0
        let every = max(1, Int(ceil((widest + 6) / max(band, 1))))
        for (index, labelFrame) in layout.categoryLabels.enumerated() where index % every == 0 {
            genuiString(plot.x[index], ChatTextStyles.genuiAxis, GenUIColors.axisLabel, alignment: .center, truncates: every == 1)
                .draw(in: labelFrame.insetBy(dx: every > 1 ? -band : 0, dy: 0))
        }
        context.saveGState()
        context.clip(to: frame.insetBy(dx: -6, dy: -6))
        if plot.kind == .bar { drawBars(layout, count: count) } else { drawLines(context, layout, count: count) }
        context.restoreGState()
        typealias M = GenUIPlotLayout.Metrics
        for (index, entry) in layout.legend.enumerated() {
            UIColor(Self.color(plot.legend[index].color)).setFill()
            let dot = CGRect(x: entry.minX, y: entry.midY - M.legendDot / 2, width: M.legendDot, height: M.legendDot)
            UIBezierPath(roundedRect: dot, cornerRadius: plot.kind == .bar ? 2 : M.legendDot / 2).fill()
            let line = ChatTextStyles.genuiCaption.lineHeight ?? 18
            legendStrings[index].draw(in: CGRect(x: dot.maxX + M.legendDotGap, y: entry.midY - line / 2, width: max(0, entry.width - M.legendDot - M.legendDotGap), height: line))
        }
    }

    private func drawBars(_ layout: GenUIPlotLayout, count: Int) {
        let series = plot.series.count
        let zero = min(max(0, plot.y?.min ?? 0), plot.y?.max ?? 0)
        for index in 0..<count {
            let slots = layout.bars(index, of: count, series: series, stacked: plot.stacked)
            var positive = zero
            var negative = zero
            for s in 0..<series {
                guard let value = value(s, index) else { continue }
                let from: Double
                let to: Double
                if plot.stacked {
                    if value >= 0 { from = positive; positive += value; to = positive } else { from = negative; negative += value; to = negative }
                } else {
                    from = zero
                    to = value
                }
                let top = y(max(from, to), in: layout.plot)
                let bottom = y(min(from, to), in: layout.plot)
                guard bottom - top > 0.5 else { continue }
                let bar = CGRect(x: slots[s].minX, y: top, width: slots[s].width, height: bottom - top)
                // Only the end away from zero is rounded, and only on a stack's last piece.
                let last = !plot.stacked || !((s + 1)..<series).contains { later in
                    guard let next = self.value(later, index) else { return false }
                    return next != 0 && (next >= 0) == (value >= 0)
                }
                let radius = last ? min(4, bar.width / 2, bar.height) : 0
                let corners: UIRectCorner = to >= from ? [.topLeft, .topRight] : [.bottomLeft, .bottomRight]
                UIColor(Self.color(plot.series[s].color)).setFill()
                UIBezierPath(roundedRect: bar, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius)).fill()
            }
        }
    }

    private func drawLines(_ context: CGContext, _ layout: GenUIPlotLayout, count: Int) {
        guard count > 0 else { return }
        var base = Array(repeating: 0.0, count: count)
        var strokes: [(UIBezierPath, [CGPoint], ColorToken)] = []
        for s in plot.series.indices {
            let tops: [Double?] = (0..<count).map { index in value(s, index).map { (plot.stacked ? base[index] : 0) + $0 } }
            let points: [CGPoint?] = tops.enumerated().map { index, top in top.map { CGPoint(x: layout.center(index, of: count), y: y($0, in: layout.plot)) } }
            let color = Self.color(plot.series[s].color)
            // A gap breaks the line into runs.
            var runs: [[CGPoint]] = [[]]
            for point in points {
                if let point { runs[runs.count - 1].append(point) } else if !(runs.last?.isEmpty ?? true) { runs.append([]) }
            }
            let line = UIBezierPath()
            for run in runs where !run.isEmpty {
                line.move(to: run[0])
                run.dropFirst().forEach(line.addLine)
                if plot.kind == .area, run.count > 1 {
                    let wash = UIBezierPath()
                    wash.move(to: run[0])
                    run.dropFirst().forEach(wash.addLine)
                    let floorValue = plot.y.map { min(max(0, $0.min), $0.max) } ?? 0
                    if plot.stacked {
                        let xs = Set(run.map(\.x))
                        for index in (0..<count).reversed() where xs.contains(layout.center(index, of: count)) {
                            wash.addLine(to: CGPoint(x: layout.center(index, of: count), y: y(base[index] == 0 ? floorValue : base[index], in: layout.plot)))
                        }
                    } else {
                        wash.addLine(to: CGPoint(x: run[run.count - 1].x, y: y(floorValue, in: layout.plot)))
                        wash.addLine(to: CGPoint(x: run[0].x, y: y(floorValue, in: layout.plot)))
                    }
                    wash.close()
                    context.saveGState()
                    wash.addClip()
                    let ink = UIColor(color)
                    if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [ink.withAlphaComponent(0.22).cgColor, ink.withAlphaComponent(0.04).cgColor] as CFArray, locations: [0, 1]) {
                        context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: layout.plot.minY), end: CGPoint(x: 0, y: layout.plot.maxY), options: [])
                    }
                    context.restoreGState()
                }
            }
            strokes.append((line, points.compactMap { $0 }, color))
            if plot.stacked { base = (0..<count).map { tops[$0] ?? base[$0] } }
        }
        for (line, points, color) in strokes {
            UIColor(color).setStroke()
            line.lineWidth = 2
            line.lineJoinStyle = .round
            line.lineCapStyle = .round
            line.stroke()
            guard points.count <= 16 else { continue }
            for point in points {
                UIColor(Palette.cardFill).setFill()
                UIBezierPath(ovalIn: CGRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8)).fill()
                UIColor(color).setFill()
                UIBezierPath(ovalIn: CGRect(x: point.x - 2.75, y: point.y - 2.75, width: 5.5, height: 5.5)).fill()
            }
        }
    }

    // MARK: Donut

    private func drawDonut() {
        let layout = donut(bounds.width)
        let slices = plot.slices.filter { $0.value > 0 }
        let total = slices.map(\.value).reduce(0, +)
        let ring = layout.ring
        let thickness = GenUIDonutLayout.Metrics.thickness
        let radius = ring.width / 2 - thickness / 2
        let center = CGPoint(x: ring.midX, y: ring.midY)
        if total <= 0 {
            UIColor(GenUIColors.grid).setStroke()
            let empty = UIBezierPath(arcCenter: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: true)
            empty.lineWidth = thickness
            empty.stroke()
        } else {
            // Slices clockwise from twelve o'clock, a 2pt seam between them.
            let seam = slices.count > 1 ? 2 / radius : 0
            var angle = -CGFloat.pi / 2
            for slice in slices {
                let sweep = CGFloat(slice.value / total) * .pi * 2
                let arc = UIBezierPath(arcCenter: center, radius: radius, startAngle: angle + seam / 2, endAngle: angle + sweep - seam / 2, clockwise: true)
                arc.lineWidth = thickness
                UIColor(Self.color(slice.color)).setStroke()
                arc.stroke()
                angle += sweep
            }
        }
        if let centre = plot.center {
            genuiString(centre.value, ChatTextStyles.genuiDonutTotal, Palette.cardTitle, alignment: .center, truncates: true, tabular: true).draw(in: layout.total)
            genuiString(centre.label, ChatTextStyles.genuiCaption, Palette.genuiTertiary, alignment: .center, truncates: true).draw(in: layout.totalLabel)
        }
        // The legend: dot, name, value, share; a hairline between rows.
        let scale = window?.screen.scale ?? traitCollection.displayScale
        let hairline = 1 / max(scale, 1)
        let line = ChatTextStyles.genuiValue.lineHeight ?? 20
        let shareWidth: CGFloat = 44
        let dot = GenUIPlotLayout.Metrics.legendDot
        for (index, row) in layout.rows.enumerated() {
            let entry = plot.legend[index]
            if index > 0 {
                UIColor(Palette.divider).setFill()
                UIRectFill(CGRect(x: 18, y: row.minY, width: row.width - 18, height: hairline))
            }
            UIColor(Self.color(entry.color)).setFill()
            UIBezierPath(ovalIn: CGRect(x: 0, y: row.midY - dot / 2 - 1, width: dot + 2, height: dot + 2)).fill()
            let textY = row.midY - line / 2
            if let share = entry.share {
                genuiString(share, ChatTextStyles.genuiCaption, Palette.genuiTertiary, alignment: .right, tabular: true)
                    .draw(in: CGRect(x: row.maxX - shareWidth, y: textY + 1, width: shareWidth, height: line))
            }
            var amountWidth: CGFloat = 0
            if let value = entry.value {
                let amount = genuiString(value, ChatTextStyles.genuiValue, Palette.cardTitle, alignment: .right, tabular: true)
                amountWidth = ceil(amount.size().width)
                amount.draw(in: CGRect(x: row.maxX - shareWidth - 12 - amountWidth, y: textY, width: amountWidth, height: line))
            }
            genuiString(entry.label, ChatTextStyles.genuiBody, Palette.cardTitle, truncates: true)
                .draw(in: CGRect(x: 18, y: row.midY - 11, width: max(0, row.width - 18 - shareWidth - 24 - amountWidth), height: 22))
        }
    }
}
#endif
