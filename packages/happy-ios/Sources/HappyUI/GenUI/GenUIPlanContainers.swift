#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// `box`: children in a column or a row. Its role picks the surface and
/// padding (a card, a notice's well, a section's hairline), a card's
/// actions, a mosaic's tiles, or an item row's shared leading column.
final class GenUIBoxElement: GenUIElement {
    private let box: GenUIBox
    private let children: [GenUIElement]
    private let rule: Bool
    private let hairline: CGFloat
    /// An item row's leading column: its width, and whether the first
    /// child fills it (else the column is left empty).
    private let leadingWidth: CGFloat
    private let leadingChild: Bool

    init(key: String, _ box: GenUIBox, _ nodes: [GenUINode], context: GenUIPlanContext, place: GenUIPlace) {
        self.box = box
        var inner = place
        if box.role == .card {
            inner.inCard = true
            inner.bleed = GenUIMetrics.cardPadding
        }
        let itemRow = box.role == .item && box.direction == .row && box.leading != .none
        children = nodes.enumerated().map { index, node in
            var place = inner
            place.first = index == 0
            return GenUIElements.make(node, context: context, place: place)
        }
        leadingWidth = itemRow ? GenUIMetrics.leading(box.leading.rawValue) : 0
        leadingChild = itemRow && children.first?.isLeading == true
        rule = box.role == .section && !place.first
        hairline = context.hairline
        super.init(key: key)
    }

    private var row: Bool { box.direction == .row }

    private var padding: LayoutInsets {
        var padding = GenUIMetrics.padding(role: box.role.rawValue)
        if rule { padding.top += GenUIMetrics.sectionRule }
        // A leading column no child fills is left empty.
        if leadingWidth > 0, !leadingChild { padding.left += leadingWidth + GenUIMetrics.leadingGap }
        return padding
    }

    /// The layout's children, the first held to the leading column when it fills one.
    private var entries: [GenUIBoxLayout.Child] {
        var entries = children.map(\.child)
        if leadingWidth > 0, leadingChild, let first = children.first {
            let width = leadingWidth
            entries[0] = GenUIBoxLayout.Child(
                measure: { _ in CGSize(width: width, height: first.measure(width).height) }, baseline: { _ in first.baseline(width) }, minWidth: width, fills: false
            )
        }
        return entries
    }

    private var gaps: [CGFloat] {
        let divided = box.divide != .none
        return zip(children, children.dropFirst()).enumerated().map { index, pair in
            if index == 0, leadingWidth > 0, leadingChild { return GenUIMetrics.leadingGap }
            return GenUIMetrics.gap(box.gap.rawValue, role: box.role.rawValue, row: row, divided: divided, between: pair.0.neighbour, and: pair.1.neighbour)
        }
    }

    private func layout(_ width: CGFloat) -> GenUIBoxLayout {
        if box.role == .mosaic {
            let ratio = GenUIMetrics.ratio(children.lazy.compactMap { ($0 as? GenUIImageElement)?.shape }.first?.rawValue ?? "landscape")
            let mosaic = GenUIMosaicLayout(width: width, count: children.count, ratio: ratio)
            var layout = GenUIBoxLayout(width: width, row: false, gaps: [], children: [])
            layout.frames = children.indices.map { mosaic.tiles.indices.contains($0) ? mosaic.tiles[$0] : .zero }
            layout.size = mosaic.size
            return layout
        }
        if box.role == .actions, row {
            let inner = max(0, width - padding.horizontal)
            let sizes = children.map { $0.measure(inner) }
            let actions = GenUIActionsLayout(width: inner, widths: sizes.map(\.width), heights: sizes.map(\.height))
            var layout = GenUIBoxLayout(width: width, row: false, gaps: [], children: [])
            layout.frames = actions.frames.map { $0.offsetBy(dx: padding.left, dy: padding.top) }
            layout.size = CGSize(width: width, height: actions.size.height + padding.vertical)
            return layout
        }
        let lineGap = GenUIMetrics.gap(box.gap.rawValue, role: box.role.rawValue, row: false, divided: false, between: .text, and: .text)
        return GenUIBoxLayout(
            width: width, padding: padding, row: row, gaps: gaps, lineGap: box.gap == .inline ? GenUIMetrics.buttonGap : lineGap,
            align: GenUIBoxLayout.Align(rawValue: box.align.rawValue) ?? .stretch, justify: GenUIBoxLayout.Justify(rawValue: box.justify.rawValue) ?? .start,
            equal: row && box.equal, wrap: row && box.wrap, children: entries
        )
    }

    override func natural(_ width: CGFloat) -> CGSize {
        let layout = layout(width)
        guard !children.isEmpty, layout.size.height > padding.vertical || box.role == .card else { return .zero }
        // As wide as its content when nothing in it spreads or fills.
        let inner = max(0, width - padding.horizontal)
        let spreads = box.role != .plain || box.equal || box.justify != .start || children.contains(where: \.grows)
        let contentWidth: CGFloat
        if spreads {
            contentWidth = inner
        } else if row {
            contentWidth = min(inner, layout.frames.map(\.maxX).max().map { $0 - padding.left } ?? 0)
        } else {
            contentWidth = min(inner, children.map { $0.measure(inner).width }.max() ?? 0)
        }
        return CGSize(width: contentWidth + padding.horizontal, height: layout.size.height)
    }

    override func baseline(_ width: CGFloat) -> CGFloat { layout(width).baseline }

    override var minWidth: CGFloat {
        let mins = entries.map(\.minWidth)
        return (row && !box.wrap ? mins.reduce(0, +) + CGFloat(max(0, mins.count - 1)) * 8 : mins.max() ?? 0) + padding.horizontal
    }

    override var grows: Bool { box.grow }

    override var neighbour: GenUIMetrics.Neighbour {
        if box.role != .plain { return .other }
        return children.allSatisfy { $0.neighbour == .text } ? .text : .other
    }

    override var dividerInset: CGFloat {
        if leadingWidth > 0 { return leadingWidth + GenUIMetrics.leadingGap }
        return box.role == .item ? 0 : (children.count == 1 ? children[0].dividerInset : 0)
    }

    private var surface: GenUIMark {
        switch box.role {
        case .card: .surface(GenUISurface(fill: Palette.cardFill, border: Palette.divider, borderWidth: 1, radius: GenUIMetrics.cardRadius, clips: true))
        case .notice: .surface(GenUISurface(fill: (box.tone ?? .neutral).fill, radius: GenUIMetrics.noticeRadius))
        case .mosaic: .surface(GenUISurface(radius: GenUIMetrics.imageRadius, clips: true))
        default: .group
        }
    }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let layout = layout(frame.width)
        let width = frame.width
        var placed = GenUIPlaced(key: key, frame: frame, mark: surface)
        if rule { placed.children.append(GenUIPlaced(key: "\(key).rule", frame: CGRect(x: 0, y: 0, width: width, height: hairline), mark: .hairline)) }
        if !row, box.divide != .none {
            let insets = children.map { box.divide == .inset ? $0.dividerInset : 0 }
            let lines = GenUIDividers.frames(layout.frames.map { $0.offsetBy(dx: -padding.left, dy: 0) }, insets: insets, width: width - padding.horizontal, hairline: hairline)
            for (index, line) in lines.enumerated() {
                placed.children.append(GenUIPlaced(key: "\(key).divider-\(index)", frame: line.offsetBy(dx: padding.left, dy: 0), mark: .hairline))
            }
        }
        let shown = zip(children, layout.frames).filter { $0.1.height > 0 }
        for (index, (child, childFrame)) in shown.enumerated() {
            var childFrame = childFrame
            // A step's rail runs on to the next step's marker.
            if row, child.hasRail { childFrame.size.height = frame.height - childFrame.minY + below }
            let next = row ? 0 : shown.dropFirst(index + 1).first.map { $0.1.minY - childFrame.maxY } ?? 0
            placed.children.append(child.place(childFrame, below: next))
        }
        return placed
    }
}

/// `grid`: a table whose columns are sized together; a header row and
/// hairlines between rows when asked.
final class GenUIGridElement: GenUIElement {
    private let grid: GenUIGrid
    private let cells: [GenUIElement]
    private let hairline: CGFloat

    init(key: String, _ grid: GenUIGrid, _ nodes: [GenUINode], context: GenUIPlanContext, place: GenUIPlace) {
        self.grid = grid
        hairline = context.hairline
        // A cell's text aligns with its column, whatever its own `align`.
        cells = nodes.enumerated().map { index, node in
            var place = place
            place.columnEnd = grid.columns[index % grid.columns.count].align == .end
            return GenUIElements.make(node, context: context, place: place)
        }
        super.init(key: key)
    }

    private func layout(_ width: CGFloat) -> GenUIGridLayout {
        GenUIGridLayout(
            width: width, columns: grid.columns.map { GenUIGridLayout.Column(fills: $0.width == .fill, end: $0.align == .end) },
            count: cells.count, density: grid.density.rawValue, header: grid.header,
            natural: { [cells] in cells[$0].measure($1) }, fills: { [cells] in cells[$0].fills }
        )
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: layout(width).size.height) }
    override var minWidth: CGFloat { 200 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let layout = layout(frame.width)
        var placed = GenUIPlaced(key: key, frame: frame, mark: .group)
        let rows = layout.rows.count
        let lines = max(0, grid.divide ? rows - 1 : (grid.header && rows > 1 ? 1 : 0))
        for index in 0..<lines {
            placed.children.append(GenUIPlaced(key: "\(key).rule-\(index)", frame: CGRect(x: 0, y: layout.rows[index + 1].minY, width: frame.width, height: hairline), mark: .hairline))
        }
        for (cell, cellFrame) in zip(cells, layout.cells) { placed.children.append(cell.place(cellFrame, below: 0)) }
        return placed
    }
}

/// `scroll`: the carousel. Cards run out to the chat's edges (or the
/// card's), the next one peeking, a swipe settling on one card at a time.
final class GenUIScrollElement: GenUIElement {
    let shape: GenUIShape
    private let cards: [GenUIElement]
    private let bleed: CGFloat

    init(key: String, shape: GenUIShape, _ nodes: [GenUINode], context: GenUIPlanContext, place: GenUIPlace) {
        self.shape = shape
        bleed = place.bleed
        cards = nodes.map { GenUIElements.make($0, context: context, place: place) }
        super.init(key: key)
    }

    private func layout(_ width: CGFloat) -> GenUICarouselLayout {
        GenUICarouselLayout(viewport: width + 2 * bleed, inset: bleed, shape: shape.rawValue, count: cards.count) { [cards] width in
            cards.map { $0.measure(width).height }.max() ?? 0
        }
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: layout(width).cards.first?.height ?? 0) }
    override var minWidth: CGFloat { 240 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let layout = layout(frame.width)
        let viewport = frame.insetBy(dx: -bleed, dy: 0)
        var placed = GenUIPlaced(key: key, frame: viewport, mark: .scroll(GenUIScrollMark(contentSize: CGSize(width: layout.contentWidth, height: frame.height), stops: layout.stops)))
        for (card, cardFrame) in zip(cards, layout.cards) {
            placed.children.append(card.place(CGRect(x: cardFrame.minX, y: 0, width: cardFrame.width, height: card.measure(cardFrame.width).height), below: 0))
        }
        return placed
    }
}

/// `switch`: `compact` below `GenUIMetrics.regularWidth` of its own width,
/// `regular` from it; either alone when the other is missing.
final class GenUISwitchElement: GenUIElement {
    private let compact: GenUIElement?
    private let regular: GenUIElement?

    init(key: String, compact: GenUINode?, regular: GenUINode?, context: GenUIPlanContext, place: GenUIPlace) {
        self.compact = compact.map { GenUIElements.make($0, context: context, place: place) }
        self.regular = regular.map { GenUIElements.make($0, context: context, place: place) }
        super.init(key: key)
    }

    private func branch(_ width: CGFloat) -> GenUIElement? {
        width < GenUIMetrics.regularWidth ? compact ?? regular : regular ?? compact
    }

    private var phoneBranch: GenUIElement? { compact ?? regular }

    override func natural(_ width: CGFloat) -> CGSize { branch(width)?.measure(width) ?? .zero }
    override func baseline(_ width: CGFloat) -> CGFloat { branch(width)?.baseline(width) ?? 0 }
    override var minWidth: CGFloat { phoneBranch?.minWidth ?? 0 }
    override var grows: Bool { phoneBranch?.grows ?? false }
    override var fills: Bool { phoneBranch?.fills ?? true }
    override var neighbour: GenUIMetrics.Neighbour { phoneBranch?.neighbour ?? .other }
    override var dividerInset: CGFloat { phoneBranch?.dividerInset ?? 0 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        var placed = GenUIPlaced(key: key, frame: frame, mark: .group)
        if let shown = branch(frame.width) { placed.children = [shown.place(CGRect(origin: .zero, size: frame.size), below: below)] }
        return placed
    }
}

/// `press`: its child, tappable. A list row's pressed ground runs to the
/// card's edges, a carousel card dims as a whole, anything else gets a
/// rounded ground just past its content. Without an action the child is
/// drawn and nothing happens.
final class GenUIPressElement: GenUIElement {
    private let press: GenUIPress
    private let content: [GenUIElement]
    private let inCard: Bool

    init(key: String, _ press: GenUIPress, _ nodes: [GenUINode], context: GenUIPlanContext, place: GenUIPlace) {
        self.press = press
        content = nodes.map { GenUIElements.make($0, context: context, place: place) }
        inCard = place.inCard
        super.init(key: key)
    }

    private var single: GenUIElement? { content.count == 1 ? content[0] : nil }

    override func natural(_ width: CGFloat) -> CGSize {
        var height: CGFloat = 0
        var widest: CGFloat = 0
        for element in content {
            let size = element.measure(width)
            height += size.height
            widest = max(widest, size.width)
        }
        return CGSize(width: widest, height: height)
    }

    override func baseline(_ width: CGFloat) -> CGFloat { content.first?.baseline(width) ?? 0 }
    override var minWidth: CGFloat { content.map(\.minWidth).max() ?? 0 }
    override var grows: Bool { single?.grows ?? false }
    override var fills: Bool { single?.fills ?? true }
    override var neighbour: GenUIMetrics.Neighbour { single?.neighbour ?? .other }
    override var dividerInset: CGFloat { single?.dividerInset ?? 0 }

    override func place(_ frame: CGRect, below: CGFloat) -> GenUIPlaced {
        let bounds = CGRect(origin: .zero, size: frame.size)
        let reach = press.role == .item && inCard ? GenUIMetrics.cardPadding : 8
        let radius: CGFloat = switch press.role {
        case .item: inCard ? 0 : 8
        case .tile: GenUIMetrics.coverRadius
        case .plain: 8
        }
        var y: CGFloat = 0
        var children: [GenUIPlaced] = []
        for element in content {
            let height = element.measure(frame.width).height
            children.append(element.place(CGRect(x: 0, y: y, width: frame.width, height: height), below: 0))
            y += height
        }
        let label = children.flatMap { $0.flattened() }.compactMap { item -> String? in
            if case .text(let text) = item.placed.mark { return text.plain }
            return nil
        }.joined(separator: ", ")
        let mark = GenUIPressMark(
            action: press.action, role: press.role, group: press.group,
            ground: press.role == .tile ? bounds : bounds.insetBy(dx: -reach, dy: -8), radius: radius, label: label
        )
        return GenUIPlaced(key: key, frame: frame, mark: .press(mark), children: children)
    }
}
#endif
