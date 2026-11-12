import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Desktop's `UsageActivityGrid`: one cell a day. The year keeps week
/// columns, Monday at the top, starting on its first day's weekday with the
/// cells above it blank, a month's name over the column holding its 1st
/// (and over the first column), and Mon, Wed and Fri beside the rows. The
/// strip is one row with no labels. Everything here is in the plot's
/// space, which scrolls; the weekdays are in their own column, which
/// doesn't.
public struct UsageGridLayout: Equatable, Sendable {
    public enum Variant: Equatable, Sendable { case year, strip }

    public struct Month: Equatable, Sendable {
        /// Which of the `monthStarts` it is.
        public var index: Int
        public var frame: CGRect
    }

    public var variant: Variant
    /// Where the first day sits in its week: Monday is 0.
    public var offset: Int
    public var count: Int
    public var columns: Int
    public var cells: [CGRect]
    /// The months whose names fit, each over its column.
    public var months: [Month]
    /// Mon, Wed and Fri, in the weekday column's space.
    public var weekdays: [CGRect]
    /// What scrolls: the weeks, and the last month's name past them.
    public var plot: CGSize

    public static let weekdayRows = [0, 2, 4]

    /// `monthStarts` are the days (by index) that start a month's label,
    /// the first day among them; `monthWidths` their names' widths.
    public init(count: Int, firstWeekday: Int, variant: Variant, monthStarts: [Int] = [], monthWidths: [CGFloat] = [], weekdayWidth: CGFloat = 0) {
        typealias M = UsageMetrics
        self.variant = variant
        let count = max(0, count)
        self.count = count
        offset = variant == .year ? min(6, max(0, firstWeekday)) : 0
        let top: CGFloat = variant == .year ? M.monthRow + M.monthGap : 0
        let offset = offset
        func position(_ index: Int) -> (column: Int, row: Int) {
            variant == .year ? ((index + offset) / 7, (index + offset) % 7) : (index, 0)
        }
        columns = count == 0 ? 0 : position(count - 1).column + 1
        cells = (0..<count).map { index in
            let (column, row) = position(index)
            return CGRect(x: CGFloat(column) * M.step, y: top + CGFloat(row) * M.step, width: M.cell, height: M.cell)
        }
        let rows = variant == .year ? 7 : 1
        let weeks = columns == 0 ? 0 : CGFloat(columns) * M.step - M.gap
        var months: [Month] = []
        if variant == .year {
            let starts = monthStarts.filter { (0..<count).contains($0) }
            for (index, start) in starts.enumerated() {
                let column = position(start).column
                // A name needs three columns of room; the earlier gives way.
                if index + 1 < starts.count, position(starts[index + 1]).column - column < M.monthMinColumns { continue }
                let width = monthWidths.indices.contains(index) ? monthWidths[index] : 0
                months.append(Month(index: index, frame: CGRect(x: CGFloat(column) * M.step, y: 0, width: width, height: M.monthRow)))
            }
        }
        self.months = months
        weekdays = variant == .year ? Self.weekdayRows.map { CGRect(x: 0, y: top + CGFloat($0) * M.step, width: weekdayWidth, height: M.cell) } : []
        plot = CGSize(width: max(weeks, months.map(\.frame.maxX).max() ?? 0), height: columns == 0 ? 0 : top + CGFloat(rows) * M.step - M.gap)
    }

    /// The day under `point` in the plot, the gap after a cell counting as
    /// that cell's; nil off the days.
    public func day(at point: CGPoint) -> Int? {
        typealias M = UsageMetrics
        let top: CGFloat = variant == .year ? M.monthRow + M.monthGap : 0
        guard point.x >= 0, point.y >= top else { return nil }
        let column = Int(point.x / M.step)
        let row = Int((point.y - top) / M.step)
        let index: Int
        switch variant {
        case .year:
            guard row < 7 else { return nil }
            index = column * 7 + row - offset
        case .strip:
            guard row == 0 else { return nil }
            index = column
        }
        return (0..<count).contains(index) ? index : nil
    }
}

/// A grid in a box `width` wide: the year's weekday column, then the weeks
/// in a viewport that scrolls sideways when they don't fit and opens on
/// today, at their end. `top` is where it starts in the box.
public struct UsageGridFrame: Equatable, Sendable {
    public var weekdays: CGRect
    public var viewport: CGRect
    /// The viewport's offset that shows today.
    public var offset: CGFloat
    public var height: CGFloat

    public init(grid: UsageGridLayout, width: CGFloat, weekdayWidth: CGFloat, top: CGFloat = 0) {
        let column = grid.variant == .year ? weekdayWidth + UsageMetrics.weekdayGap : 0
        weekdays = CGRect(x: 0, y: top, width: grid.variant == .year ? weekdayWidth : 0, height: grid.plot.height)
        // Too narrow for every week, it shows whole ones: no sliver of a
        // cell at its leading edge.
        let room = max(0, width - column)
        let whole = max(0, ((room + UsageMetrics.gap) / UsageMetrics.step).rounded(.down) * UsageMetrics.step - UsageMetrics.gap)
        viewport = CGRect(x: column, y: top, width: grid.plot.width <= room ? grid.plot.width : whole, height: grid.plot.height)
        offset = max(0, grid.plot.width - viewport.width)
        height = grid.plot.height
    }
}

/// The day's callout over a tapped cell: its date, its total, then up to
/// three models with what each spent. Centred over the cell, kept inside
/// `bounds`, and under the cell when there is no room above it.
public struct UsageCalloutLayout: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public var id: CGRect
        public var value: CGRect
    }

    /// In the container's space.
    public var frame: CGRect
    /// The rest in the callout's own.
    public var title: CGRect
    public var total: CGRect
    public var models: [Line]

    public init(cell: CGRect, bounds: CGRect, title: CGSize, total: CGSize, models: [(id: CGSize, value: CGSize)]) {
        typealias M = UsageMetrics
        let widest = ([title.width, total.width] + models.map { $0.id.width + M.calloutModelGap + $0.value.width }).max() ?? 0
        let width = min(M.calloutMaxWidth, widest + 2 * M.calloutPaddingX, max(0, bounds.width - 2 * M.calloutMargin))
        let inner = max(0, width - 2 * M.calloutPaddingX)
        let lines = 2 + models.count
        let height = 2 * M.calloutPaddingY + CGFloat(lines) * M.calloutLine + CGFloat(lines - 1) * M.calloutLineGap
        func line(_ index: Int) -> CGFloat { M.calloutPaddingY + CGFloat(index) * (M.calloutLine + M.calloutLineGap) }
        self.title = CGRect(x: M.calloutPaddingX, y: line(0), width: min(inner, title.width), height: M.calloutLine)
        self.total = CGRect(x: M.calloutPaddingX, y: line(1), width: min(inner, total.width), height: M.calloutLine)
        self.models = models.enumerated().map { index, model in
            let value = min(inner, model.value.width)
            let y = line(2 + index)
            return Line(
                id: CGRect(x: M.calloutPaddingX, y: y, width: max(0, min(model.id.width, inner - M.calloutModelGap - value)), height: M.calloutLine),
                value: CGRect(x: M.calloutPaddingX + inner - value, y: y, width: value, height: M.calloutLine)
            )
        }
        let x = min(max(cell.midX - width / 2, bounds.minX + M.calloutMargin), bounds.maxX - M.calloutMargin - width)
        let above = cell.minY - M.calloutGap - height
        let y = above >= bounds.minY + M.calloutMargin ? above : cell.maxY + M.calloutGap
        frame = CGRect(x: x.rounded(), y: y.rounded(), width: width, height: height)
    }
}

/// One account in its service's card: its name and plan, its last 30 days,
/// its plan's windows (each with when it starts over and what is left) and
/// how current they are, then one line per model. In the account's own
/// box, `width` wide; its height holds the card's padding above and below.
public struct UsageAccountLayout: Equatable, Sendable {
    public struct LimitSpec: Equatable, Sendable {
        public var label: CGSize
        public var resets: CGSize?
        public var gauge: CGSize
        public init(label: CGSize, resets: CGSize?, gauge: CGSize) {
            self.label = label
            self.resets = resets
            self.gauge = gauge
        }
    }

    public struct Limit: Equatable, Sendable {
        public var label: CGRect
        public var resets: CGRect?
        public var gauge: CGRect
    }

    public struct Model: Equatable, Sendable {
        public var id: CGRect
        public var totals: CGRect
        /// Too wide for one line: the totals under the model.
        public var stacked: Bool
    }

    public var name: CGRect
    public var plan: CGRect?
    /// The strip's box, `stripHeight` tall.
    public var strip: CGRect?
    public var limits: [Limit]
    public var notes: [CGRect]
    public var models: [Model]
    public var height: CGFloat

    public init(width: CGFloat, name: CGSize, plan: CGSize?, stripHeight: CGFloat?, limits: [LimitSpec], notes: Int, models: [(id: CGSize, totals: CGSize)]) {
        typealias M = UsageMetrics
        var y = M.padding
        let planWidth = plan.map { min($0.width, width) } ?? 0
        let nameWidth = max(0, min(name.width, width - (plan == nil ? 0 : M.planGap + planWidth)))
        self.name = CGRect(x: 0, y: y + (M.nameLine - name.height) / 2, width: nameWidth, height: name.height)
        self.plan = plan.map { CGRect(x: nameWidth + M.planGap, y: y + (M.nameLine - $0.height) / 2, width: planWidth, height: $0.height) }
        y += M.nameLine
        strip = stripHeight.map { height in
            defer { y += M.itemGap + height }
            return CGRect(x: 0, y: y + M.itemGap, width: width, height: height)
        }
        if !limits.isEmpty || notes > 0 { y += M.itemGap }
        self.limits = limits.map { spec in
            defer { y += M.limitLine }
            func centred(_ size: CGSize) -> CGFloat { y + (M.limitLine - size.height) / 2 }
            let gaugeX = max(0, width - spec.gauge.width)
            let gauge = CGRect(x: gaugeX, y: centred(spec.gauge), width: spec.gauge.width, height: spec.gauge.height)
            let labelWidth = min(spec.label.width, max(0, gaugeX - M.gaugeGap))
            let resets = spec.resets.map { size in
                let x = max(M.labelColumn, labelWidth + M.labelGap)
                return CGRect(x: x, y: centred(size), width: max(0, min(size.width, gaugeX - M.gaugeGap - x)), height: size.height)
            }
            return Limit(label: CGRect(x: 0, y: centred(spec.label), width: labelWidth, height: spec.label.height), resets: resets, gauge: gauge)
        }
        self.notes = (0..<notes).map { _ in
            defer { y += M.limitLine }
            return CGRect(x: 0, y: y, width: width, height: M.limitLine)
        }
        if !models.isEmpty { y += M.itemGap + M.modelsGap }
        self.models = models.enumerated().map { index, model in
            if index > 0 { y += M.modelGap }
            let totals = min(model.totals.width, width)
            if model.id.width + M.modelIdGap + model.totals.width <= width {
                defer { y += M.modelLine }
                return Model(
                    id: CGRect(x: 0, y: y, width: model.id.width, height: M.modelLine),
                    totals: CGRect(x: width - totals, y: y, width: totals, height: M.modelLine), stacked: false
                )
            }
            defer { y += 2 * M.modelLine + M.modelGap }
            return Model(
                id: CGRect(x: 0, y: y, width: min(model.id.width, width), height: M.modelLine),
                totals: CGRect(x: width - totals, y: y + M.modelLine + M.modelGap, width: totals, height: M.modelLine), stacked: true
            )
        }
        height = y + M.padding
    }
}

/// The page: sections down a readable column, each a title (and a line
/// under it) over a card of blocks, hairlines between them.
public struct UsagePageLayout: Equatable, Sendable {
    public struct SectionSpec: Equatable, Sendable {
        public var title: CGFloat
        public var subtitle: CGFloat?
        /// Each block's height, its padding included.
        public var blocks: [CGFloat]
        public init(title: CGFloat, subtitle: CGFloat? = nil, blocks: [CGFloat]) {
            self.title = title
            self.subtitle = subtitle
            self.blocks = blocks
        }
    }

    public struct Section: Equatable, Sendable {
        public var title: CGRect
        public var subtitle: CGRect?
        public var card: CGRect
        /// In the card's space.
        public var blocks: [CGRect]
        public var separators: [CGRect]
    }

    public var sections: [Section]
    public var contentHeight: CGFloat

    /// What a block has across, inside the card's padding.
    public static func innerWidth(_ width: CGFloat) -> CGFloat {
        max(0, width - 2 * UsageMetrics.side - 2 * UsageMetrics.padding)
    }

    public init(width: CGFloat, sections specs: [SectionSpec]) {
        typealias M = UsageMetrics
        let inner = Self.innerWidth(width)
        let headerWidth = max(0, width - 2 * (M.side + M.headerInset))
        var y = M.top
        var sections: [Section] = []
        for (index, spec) in specs.enumerated() {
            if index > 0 { y += M.sectionGap }
            let title = CGRect(x: M.side + M.headerInset, y: y, width: headerWidth, height: spec.title)
            y = title.maxY
            let subtitle = spec.subtitle.map { height in
                defer { y += M.titleGap + height }
                return CGRect(x: M.side + M.headerInset, y: y + M.titleGap, width: headerWidth, height: height)
            }
            y += M.headerGap
            var blockY: CGFloat = 0
            var blocks: [CGRect] = []
            var separators: [CGRect] = []
            for (block, height) in spec.blocks.enumerated() {
                if block > 0 { separators.append(CGRect(x: M.padding, y: blockY, width: inner, height: M.separator)) }
                blocks.append(CGRect(x: M.padding, y: blockY, width: inner, height: height))
                blockY += height
            }
            let card = CGRect(x: M.side, y: y, width: max(0, width - 2 * M.side), height: blockY)
            sections.append(Section(title: title, subtitle: subtitle, card: card, blocks: blocks, separators: separators))
            y = card.maxY
        }
        self.sections = sections
        contentHeight = sections.isEmpty ? 0 : y + M.bottom
    }
}

/// Nothing to show: a title and a line, centred in what shows between the
/// bars.
public struct UsageEmptyLayout: Equatable, Sendable {
    public var title: CGRect
    public var body: CGRect

    public init(size: CGSize, insets: LayoutInsets, title: CGSize, body: CGSize) {
        typealias M = UsageMetrics
        let width = max(0, size.width - 2 * M.emptySide)
        let height = title.height + M.emptyGap + body.height
        let top = insets.top + max(0, (size.height - insets.top - insets.bottom - height) / 2)
        self.title = CGRect(x: M.emptySide, y: top.rounded(), width: width, height: title.height)
        self.body = CGRect(x: M.emptySide, y: (top + title.height + M.emptyGap).rounded(), width: width, height: body.height)
    }
}
