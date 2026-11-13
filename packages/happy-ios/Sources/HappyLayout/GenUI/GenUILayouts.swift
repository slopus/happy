import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Frames for Gen UI render documents (task_375 `genui/RENDER.md`). The
// document carries no dimensions: a box says what it is (`role`) and how
// its children relate (`gap`), and every number for that lives here. The
// views measure their content and apply these frames; nothing here knows
// UIKit. Roles, gaps and shapes come in as the document's raw names, so an
// unknown one already fell back to its default when the document was read.

public enum GenUIMetrics {
    /// A card: the chat's result card.
    public static let cardPadding: CGFloat = 16
    public static let cardRadius: CGFloat = 10
    /// A notice: its tone's soft well.
    public static let noticePadding: CGFloat = 12
    public static let noticeRadius: CGFloat = 8
    /// Under a section's hairline, before its heading.
    public static let sectionRule: CGFloat = 16
    /// An `item` row's leading column, by its `leading`, and the room after it.
    public static let leadingGap: CGFloat = 12
    /// Glyphs: a `leading` icon's box (header, row, notice) and an `inline` one's.
    public static let leadingIcon: CGFloat = 20
    public static let inlineIcon: CGFloat = 14
    /// Buttons: in a card's actions, and chips.
    public static let buttonHeight: CGFloat = 40
    public static let chipHeight: CGFloat = 36
    public static let buttonRadius: CGFloat = 10
    public static let buttonPaddingH: CGFloat = 16
    public static let chipPaddingH: CGFloat = 14
    public static let buttonGap: CGFloat = 8
    public static let buttonIcon: CGFloat = 16
    public static let buttonIconGap: CGFloat = 6
    /// A pill.
    public static let pillHeight: CGFloat = 22
    public static let pillPaddingH: CGFloat = 8
    public static let pillIcon: CGFloat = 12
    public static let pillIconGap: CGFloat = 4
    public static let pillMaxText: CGFloat = 160
    /// A progress bar's track.
    public static let bar: CGFloat = 6
    /// A step marker and its rail.
    public static let marker: CGFloat = 20
    public static let rail: CGFloat = 1.5
    /// A sparkline's box.
    public static let spark: CGFloat = 30
    /// Pictures: a mosaic's seams, corners, a thumbnail, the tallest a figure goes.
    public static let mosaicGap: CGFloat = 2
    public static let imageRadius: CGFloat = 8
    public static let coverRadius: CGFloat = 10
    public static let thumb: CGFloat = 40
    public static let thumbRadius: CGFloat = 6
    public static let figureMaxHeight: CGFloat = 420
    /// The carousel: between cards, and how much of the next one shows.
    public static let carouselGap: CGFloat = 12
    public static let carouselPeek: CGFloat = 80
    /// Below this width of its own a `switch` draws `compact`: every phone
    /// (SPEC.md's "wide" is 560pt or more).
    public static let regularWidth: CGFloat = 560

    public static func leading(_ kind: String) -> CGFloat {
        switch kind {
        case "icon": leadingIcon
        case "thumb": thumb
        case "number": 22
        default: 0
        }
    }

    /// A box's padding by role.
    public static func padding(role: String) -> LayoutInsets {
        switch role {
        case "card": LayoutInsets(top: cardPadding, left: cardPadding, bottom: cardPadding, right: cardPadding)
        case "notice": LayoutInsets(top: noticePadding, left: noticePadding, bottom: noticePadding, right: noticePadding)
        default: .zero
        }
    }

    /// Height over width for a picture of `shape`.
    public static func ratio(_ shape: String) -> CGFloat {
        switch shape {
        case "square": 1
        case "portrait": 4.0 / 3.0
        default: 3.0 / 4.0
        }
    }

    /// What a box's child is, for the one gap the document leaves to it.
    public enum Neighbour: Equatable, Sendable {
        /// Words: a text, or a row or column of them.
        case text
        /// A drawing or picture: image, spark, bar, plot, grid, code.
        case graphic
        case other
    }

    /// The distance between two neighbours of a box: `gap` is how they
    /// relate, `role` the box's. Only `related` looks at what the
    /// neighbours are: a title and its detail sit close, a value and its
    /// sparkline or a cover and its title need air.
    public static func gap(_ gap: String, role: String, row: Bool, divided: Bool, between before: Neighbour, and after: Neighbour) -> CGFloat {
        if row {
            switch gap {
            case "none": return 0
            case "inline": return role == "header" || role == "notice" ? 10 : 8
            case "blocks": return 16
            default: return 8
            }
        }
        switch gap {
        case "none": return 0
        case "inline": return 8
        case "tight": return 2
        case "related": return before == .graphic || after == .graphic ? 8 : 2
        case "labeled": return 8
        case "heading": return 10
        case "items": return divided ? 22 : 16
        case "blocks": return 18
        default: return 0
        }
    }
}

/// Children in a column or a row: the frames a `box` gives them.
public struct GenUIBoxLayout: Equatable, Sendable {
    public struct Child {
        /// The child's natural size when offered a width: no wider than the
        /// offer, and as narrow as its content when it doesn't fill.
        public var measure: (CGFloat) -> CGSize
        /// Its first baseline from its top, at a width.
        public var baseline: (CGFloat) -> CGFloat
        /// The narrowest it reads at, for an `equal` row deciding to wrap.
        public var minWidth: CGFloat
        /// Takes what a row has left.
        public var grow: Bool
        /// Takes the column's width when the column stretches.
        public var fills: Bool
        /// Keeps its natural width in a row that is short of room; the
        /// others give way.
        public var fixed: Bool

        public init(
            measure: @escaping (CGFloat) -> CGSize, baseline: @escaping (CGFloat) -> CGFloat = { _ in 0 }, minWidth: CGFloat = 0, grow: Bool = false,
            fills: Bool = true, fixed: Bool = false
        ) {
            self.measure = measure
            self.baseline = baseline
            self.minWidth = minWidth
            self.grow = grow
            self.fills = fills
            self.fixed = fixed
        }

        /// A fixed size, like a glyph.
        public static func fixed(_ size: CGSize, baseline: CGFloat? = nil) -> Child {
            Child(measure: { _ in size }, baseline: { _ in baseline ?? size.height }, minWidth: size.width, fills: false)
        }
    }

    public enum Align: String, Equatable, Sendable { case start, center, end, baseline, stretch }
    public enum Justify: String, Equatable, Sendable { case start, between, end }

    public var frames: [CGRect]
    public var size: CGSize
    /// The first line's baseline, from the top.
    public var baseline: CGFloat

    /// `gaps[i]` is the distance after child `i`; `lineGap` the distance
    /// between the lines of a row that wraps.
    public init(
        width: CGFloat, padding: LayoutInsets = .zero, row: Bool, gaps: [CGFloat], lineGap: CGFloat = 0,
        align: Align = .stretch, justify: Justify = .start, equal: Bool = false, wrap: Bool = false, children: [Child]
    ) {
        let inner = max(0, width - padding.horizontal)
        let gap = { (index: Int) in gaps.indices.contains(index) ? gaps[index] : 0 }
        var frames: [CGRect]
        var height: CGFloat
        var baseline: CGFloat = 0
        if !row {
            (frames, height, baseline) = Self.column(inner, gap, align, children)
        } else if equal {
            (frames, height, baseline) = Self.equalRow(inner, gap, lineGap, align, wrap, children)
        } else if wrap {
            (frames, height, baseline) = Self.flow(inner, gap, lineGap, align, children)
        } else {
            (frames, height, baseline) = Self.line(inner, gap, align, justify, children)
        }
        self.frames = frames.map { $0.offsetBy(dx: padding.left, dy: padding.top) }
        size = CGSize(width: width, height: height + padding.vertical)
        self.baseline = baseline + padding.top
    }

    public static func == (a: GenUIBoxLayout, b: GenUIBoxLayout) -> Bool {
        a.frames == b.frames && a.size == b.size && a.baseline == b.baseline
    }

    /// One under another; a child with nothing to show takes no room and no gap.
    private static func column(_ width: CGFloat, _ gap: (Int) -> CGFloat, _ align: Align, _ children: [Child]) -> ([CGRect], CGFloat, CGFloat) {
        var frames: [CGRect] = []
        var y: CGFloat = 0
        var baseline: CGFloat?
        var previous: Int?
        for (index, child) in children.enumerated() {
            let natural = child.measure(width)
            let childWidth = align == .stretch && child.fills ? width : min(width, natural.width)
            let size = childWidth == natural.width ? natural : child.measure(childWidth)
            guard size.height > 0 else {
                frames.append(CGRect(x: 0, y: y, width: childWidth, height: 0))
                continue
            }
            if let previous { y += gap(previous) }
            let x: CGFloat = switch align {
            case .center: (width - childWidth) / 2
            case .end: width - childWidth
            default: 0
            }
            frames.append(CGRect(x: x, y: y, width: childWidth, height: size.height))
            if baseline == nil { baseline = y + child.baseline(childWidth) }
            y += size.height
            previous = index
        }
        return (frames, y, baseline ?? 0)
    }

    /// Side by side in one line. Natural widths when they fit, what is
    /// left going to the children that grow, or spread by `justify`; when
    /// they don't, the `fixed` keep theirs and of the rest the widest give
    /// way first.
    private static func line(_ width: CGFloat, _ gap: (Int) -> CGFloat, _ align: Align, _ justify: Justify, _ children: [Child]) -> ([CGRect], CGFloat, CGFloat) {
        let count = children.count
        guard count > 0 else { return ([], 0, 0) }
        let gaps = (0..<count - 1).map(gap)
        let room = max(0, width - gaps.reduce(0, +))
        let natural = children.map { $0.measure(room).width }
        var widths = natural
        var lead: CGFloat = 0
        var spread: CGFloat = 0
        let total = natural.reduce(0, +)
        if total <= room {
            let extra = room - total
            let growing = children.indices.filter { children[$0].grow }
            if !growing.isEmpty {
                for index in growing { widths[index] += extra / CGFloat(growing.count) }
            } else if justify == .between, count > 1 {
                spread = extra / CGFloat(count - 1)
            } else if justify == .end {
                lead = extra
            }
        } else {
            let fixed = children.indices.filter { children[$0].fixed }
            let held = fixed.map { natural[$0] }.reduce(0, +)
            let others = children.indices.filter { !children[$0].fixed }
            for (index, share) in zip(others, fairShares(others.map { natural[$0] }, max(0, room - held))) { widths[index] = share }
        }
        let sizes = children.indices.map { children[$0].measure(widths[$0]) }
        let (ys, height, baseline) = cross(sizes.map(\.height), children.indices.map { children[$0].baseline(widths[$0]) }, align)
        var x = lead
        var frames: [CGRect] = []
        for index in children.indices {
            let stretch = align == .stretch && children[index].fills
            frames.append(CGRect(x: x, y: ys[index], width: widths[index], height: stretch ? height : sizes[index].height))
            x += widths[index] + (index < count - 1 ? gaps[index] + spread : 0)
        }
        return (frames, height, baseline)
    }

    /// Equal shares; a row that wraps puts as many on a line as leave each
    /// one its `minWidth`, one that doesn't keeps them all on one line.
    private static func equalRow(_ width: CGFloat, _ gap: (Int) -> CGFloat, _ lineGap: CGFloat, _ align: Align, _ wrap: Bool, _ children: [Child]) -> ([CGRect], CGFloat, CGFloat) {
        let count = children.count
        guard count > 0 else { return ([], 0, 0) }
        let spacing = gap(0)
        let need = children.map(\.minWidth).max() ?? 0
        var perLine = count
        if wrap {
            while perLine > 1, (width - spacing * CGFloat(perLine - 1)) / CGFloat(perLine) < need { perLine -= 1 }
        }
        let share = max(0, (width - spacing * CGFloat(perLine - 1)) / CGFloat(perLine))
        var frames: [CGRect] = []
        var y: CGFloat = 0
        var baseline: CGFloat?
        for start in stride(from: 0, to: count, by: perLine) {
            let members = Array(children[start..<min(count, start + perLine)])
            let sizes = members.map { $0.measure(share) }
            let (ys, height, lineBaseline) = cross(sizes.map(\.height), members.map { $0.baseline(share) }, align)
            if start > 0 { y += lineGap }
            for (offset, member) in members.enumerated() {
                let stretch = align == .stretch && member.fills
                frames.append(CGRect(x: CGFloat(offset) * (share + spacing), y: y + ys[offset], width: share, height: stretch ? height : sizes[offset].height))
            }
            if baseline == nil { baseline = y + lineBaseline }
            y += height
        }
        return (frames, y, baseline ?? 0)
    }

    /// Natural widths left to right, onto a new line when one is full.
    private static func flow(_ width: CGFloat, _ gap: (Int) -> CGFloat, _ lineGap: CGFloat, _ align: Align, _ children: [Child]) -> ([CGRect], CGFloat, CGFloat) {
        var lines: [[Int]] = []
        var x: CGFloat = 0
        var widths: [CGFloat] = []
        for child in children { widths.append(min(width, child.measure(width).width)) }
        for index in children.indices {
            if let last = lines.last?.last, x + gap(last) + widths[index] <= width {
                x += gap(last) + widths[index]
                lines[lines.count - 1].append(index)
            } else {
                lines.append([index])
                x = widths[index]
            }
        }
        var frames = Array(repeating: CGRect.zero, count: children.count)
        var y: CGFloat = 0
        var baseline: CGFloat?
        for (number, members) in lines.enumerated() {
            let sizes = members.map { children[$0].measure(widths[$0]) }
            let (ys, height, lineBaseline) = cross(sizes.map(\.height), members.map { children[$0].baseline(widths[$0]) }, align == .stretch ? .start : align)
            if number > 0 { y += lineGap }
            var x: CGFloat = 0
            for (offset, index) in members.enumerated() {
                frames[index] = CGRect(x: x, y: y + ys[offset], width: widths[index], height: sizes[offset].height)
                x += widths[index] + gap(index)
            }
            if baseline == nil { baseline = y + lineBaseline }
            y += height
        }
        return (frames, y, baseline ?? 0)
    }

    /// Where each child of a line sits across it, the line's height and baseline.
    private static func cross(_ heights: [CGFloat], _ baselines: [CGFloat], _ align: Align) -> ([CGFloat], CGFloat, CGFloat) {
        let tallest = heights.max() ?? 0
        switch align {
        case .baseline:
            let ascent = baselines.max() ?? 0
            let ys = baselines.map { ascent - $0 }
            let height = zip(ys, heights).map { $0 + $1 }.max() ?? 0
            return (ys, height, ascent)
        case .center:
            let ys = heights.map { (tallest - $0) / 2 }
            return (ys, tallest, zip(ys, baselines).map { $0 + $1 }.max() ?? 0)
        case .end:
            let ys = heights.map { tallest - $0 }
            return (ys, tallest, zip(ys, baselines).map { $0 + $1 }.max() ?? 0)
        case .start, .stretch:
            // The line's baseline is its lowest first baseline: a glyph's
            // middle sits above the words beside it.
            return (heights.map { _ in 0 }, tallest, baselines.max() ?? 0)
        }
    }

    /// `room` shared out so nobody gets more than they need and the rest
    /// split evenly: the narrow keep their width, the widest give way.
    public static func fairShares(_ needs: [CGFloat], _ room: CGFloat) -> [CGFloat] {
        var shares = Array(repeating: CGFloat(0), count: needs.count)
        var left = room
        var waiting = needs.count
        for index in needs.indices.sorted(by: { needs[$0] < needs[$1] }) {
            let share = min(needs[index], max(0, left) / CGFloat(waiting))
            shares[index] = share
            left -= share
            waiting -= 1
        }
        return shares
    }
}

/// A card's `actions`: side by side in equal shares when every label fits
/// its share, else full width one under another, the first on top.
public struct GenUIActionsLayout: Equatable, Sendable {
    public var frames: [CGRect]
    public var size: CGSize

    /// `widths` are the buttons' natural widths, padding included; `heights` their heights.
    public init(width: CGFloat, widths: [CGFloat], heights: [CGFloat]) {
        typealias M = GenUIMetrics
        let count = widths.count
        guard count > 0 else {
            frames = []
            size = CGSize(width: width, height: 0)
            return
        }
        let share = (width - M.buttonGap * CGFloat(count - 1)) / CGFloat(count)
        let tallest = heights.max() ?? M.buttonHeight
        if count <= 3, widths.allSatisfy({ $0 <= share }) {
            frames = (0..<count).map { CGRect(x: CGFloat($0) * (share + M.buttonGap), y: 0, width: share, height: tallest) }
            size = CGSize(width: width, height: tallest)
        } else {
            var y: CGFloat = 0
            frames = heights.map { height in
                defer { y += height + M.buttonGap }
                return CGRect(x: 0, y: y, width: width, height: height)
            }
            size = CGSize(width: width, height: y - M.buttonGap)
        }
    }
}

/// Hairlines between a column's children, in the middle of each gap.
public enum GenUIDividers {
    /// `insets[i]` is where the line above child `i` starts.
    public static func frames(_ frames: [CGRect], insets: [CGFloat], width: CGFloat, hairline: CGFloat) -> [CGRect] {
        let shown = frames.indices.filter { frames[$0].height > 0 }
        return zip(shown, shown.dropFirst()).map { above, below in
            let y = ((frames[above].maxY + frames[below].minY) / 2 - hairline / 2)
            let x = insets.indices.contains(below) ? insets[below] : 0
            return CGRect(x: x, y: y, width: max(0, width - x), height: hairline)
        }
    }
}

/// A `grid`: cells in row-major order, columns sized together. An `auto`
/// column is as wide as its widest cell, `fill` columns share the rest.
public struct GenUIGridLayout: Equatable, Sendable {
    public struct Column: Equatable, Sendable {
        public var fills: Bool
        public var end: Bool

        public init(fills: Bool, end: Bool = false) {
            self.fills = fills
            self.end = end
        }
    }

    public var cells: [CGRect]
    /// The rows, top to bottom, each its full width.
    public var rows: [CGRect]
    public var size: CGSize

    public static func spacing(density: String) -> (column: CGFloat, row: CGFloat, head: CGFloat) {
        density == "pairs" ? (16, 5, 4) : (12, 10, 6)
    }

    /// `natural(i, w)` is cell `i`'s natural size offered `w`; `fills(i)`
    /// whether it takes its column's width (text) or keeps its own (a pill).
    public init(width: CGFloat, columns: [Column], count: Int, density: String, header: Bool, natural: (Int, CGFloat) -> CGSize, fills: (Int) -> Bool) {
        let spacing = Self.spacing(density: density)
        let n = max(1, columns.count)
        let room = max(0, width - spacing.column * CGFloat(n - 1))
        var widths = (0..<n).map { column in
            columns.indices.contains(column) && columns[column].fills ? 0 : stride(from: column, to: count, by: n).map { natural($0, room).width }.max() ?? 0
        }
        let fillCount = columns.filter(\.fills).count
        let autos = widths.reduce(0, +)
        let fillMin: CGFloat = fillCount > 0 ? 64 * CGFloat(fillCount) : 0
        if autos > room - fillMin {
            let scale = max(0, room - fillMin) / max(1, autos)
            widths = widths.map { $0 * scale }
        }
        let left = room - widths.reduce(0, +)
        if fillCount > 0 {
            for column in 0..<n where columns.indices.contains(column) && columns[column].fills { widths[column] = left / CGFloat(fillCount) }
        } else if left > 0 {
            // No fill column: the last takes the slack.
            widths[n - 1] += left
        }
        var xs: [CGFloat] = []
        var x: CGFloat = 0
        for w in widths {
            xs.append(x)
            x += w + spacing.column
        }
        var cells = Array(repeating: CGRect.zero, count: count)
        var rows: [CGRect] = []
        var y: CGFloat = 0
        for (rowIndex, start) in stride(from: 0, to: count, by: n).enumerated() {
            let pad = header && rowIndex == 0 ? spacing.head : spacing.row
            let members = Array(start..<min(count, start + n))
            let sizes = members.map { index -> CGSize in
                let column = index - start
                let natural = natural(index, widths[column])
                return CGSize(width: fills(index) ? widths[column] : min(widths[column], natural.width), height: natural.height)
            }
            let height = (sizes.map(\.height).max() ?? 0) + 2 * pad
            for (offset, index) in members.enumerated() {
                let column = index - start
                let size = sizes[offset]
                let end = columns.indices.contains(column) && columns[column].end
                let cellX = xs[column] + (end ? widths[column] - size.width : 0)
                cells[index] = CGRect(x: cellX, y: y + (height - size.height) / 2, width: size.width, height: size.height)
            }
            rows.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        self.cells = cells
        self.rows = rows
        size = CGSize(width: width, height: y)
    }
}

/// A `mosaic`: 1 full width, 2 side by side, 3 one large beside two
/// stacked, 4 two by two, 5 two over three.
public struct GenUIMosaicLayout: Equatable, Sendable {
    public var tiles: [CGRect]
    public var size: CGSize

    /// `ratio` is a tile's height over its width at the images' shape.
    public init(width: CGFloat, count: Int, ratio: CGFloat, gap: CGFloat = GenUIMetrics.mosaicGap) {
        func even(_ n: Int, y: CGFloat, height: CGFloat) -> [CGRect] {
            let tile = (width - gap * CGFloat(n - 1)) / CGFloat(n)
            return (0..<n).map { CGRect(x: CGFloat($0) * (tile + gap), y: y, width: tile, height: height) }
        }
        switch min(count, 5) {
        case ..<1:
            tiles = []
            size = CGSize(width: width, height: 0)
        case 1:
            let height = min(GenUIMetrics.figureMaxHeight, (width * ratio).rounded())
            tiles = [CGRect(x: 0, y: 0, width: width, height: height)]
            size = CGSize(width: width, height: height)
        case 2:
            let height = ((width - gap) / 2 * max(ratio, 1)).rounded()
            tiles = even(2, y: 0, height: height)
            size = CGSize(width: width, height: height)
        case 3:
            let large = ((width - gap) * 2 / 3).rounded()
            let small = width - gap - large
            let height = (large * ratio).rounded()
            let half = ((height - gap) / 2).rounded()
            tiles = [
                CGRect(x: 0, y: 0, width: large, height: height),
                CGRect(x: large + gap, y: 0, width: small, height: half),
                CGRect(x: large + gap, y: half + gap, width: small, height: height - half - gap),
            ]
            size = CGSize(width: width, height: height)
        case 4:
            let height = ((width - gap) / 2 * ratio).rounded()
            tiles = even(2, y: 0, height: height) + even(2, y: height + gap, height: height)
            size = CGSize(width: width, height: height * 2 + gap)
        default:
            let top = ((width - gap) / 2 * ratio).rounded()
            let bottom = ((width - 2 * gap) / 3).rounded()
            tiles = even(2, y: 0, height: top) + even(3, y: top + gap, height: bottom)
            size = CGSize(width: width, height: top + gap + bottom)
        }
    }
}

/// A `scroll`: cards running out past the column into `inset` on both
/// sides, the next one peeking, snapping one card at a time. The images'
/// shape sets the card width: a landscape card leaves a peek, a square
/// one about two thirds of the screen, a portrait one about half.
public struct GenUICarouselLayout: Equatable, Sendable {
    public var cardWidth: CGFloat
    public var cards: [CGRect]
    public var contentWidth: CGFloat
    public var stops: [CGFloat]

    public static func cardWidth(viewport: CGFloat, inset: CGFloat, shape: String, count: Int) -> CGFloat {
        let column = viewport - 2 * inset
        guard count > 1 else { return shape == "landscape" ? column : min(column, (column * 0.62).rounded()) }
        switch shape {
        case "square": return max(120, (column * 0.62).rounded())
        case "portrait": return max(120, (column * 0.6).rounded())
        default: return max(120, (column - GenUIMetrics.carouselPeek).rounded())
        }
    }

    /// `height` is a card's height at a width; every card is the tallest's.
    public init(viewport: CGFloat, inset: CGFloat, shape: String, count: Int, height: (CGFloat) -> CGFloat) {
        let cardWidth = Self.cardWidth(viewport: viewport, inset: inset, shape: shape, count: count)
        self.cardWidth = cardWidth
        let cardHeight = height(cardWidth)
        cards = (0..<count).map { CGRect(x: inset + CGFloat($0) * (cardWidth + GenUIMetrics.carouselGap), y: 0, width: cardWidth, height: cardHeight) }
        contentWidth = (cards.last?.maxX ?? 0) + inset
        let maxOffset = max(0, contentWidth - viewport)
        stops = cards.map { min(maxOffset, $0.minX - inset) }
    }

    /// The stop a swipe that would end at `proposed`, moving at `velocity`
    /// (points per millisecond, positive leftward), settles on: the next
    /// card in the swipe's direction, at most one away from `current`.
    public func stop(proposed: CGFloat, velocity: CGFloat, current: CGFloat) -> CGFloat {
        guard !stops.isEmpty else { return 0 }
        let start = stops.enumerated().min { abs($0.element - current) < abs($1.element - current) }?.offset ?? 0
        var index: Int
        if velocity > 0.2 {
            index = start + 1
        } else if velocity < -0.2 {
            index = start - 1
        } else {
            index = stops.enumerated().min { abs($0.element - proposed) < abs($1.element - proposed) }?.offset ?? start
        }
        return stops[min(stops.count - 1, max(0, index))]
    }
}
