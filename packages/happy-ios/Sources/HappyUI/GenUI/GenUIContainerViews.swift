#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// `box`: children in a column or a row. Its role picks the surface and
/// padding (a card, a notice's well, a section's hairline), a card's
/// actions, a mosaic's tiles, or an item row's shared leading column.
final class GenUIBoxView: GenUIElementView {
    private let box: GenUIBox
    private let children: [GenUIElementView]
    private let rule: GenUIHairline?
    private var dividers: [GenUIHairline] = []
    /// An item row's leading column: its width, and whether the first
    /// child fills it (else the column is left empty).
    private let leadingWidth: CGFloat
    private let leadingChild: Bool

    init(key: String, _ box: GenUIBox, _ nodes: [GenUINode], context: GenUIContext, place: GenUIPlace) {
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
        rule = box.role == .section && !place.first ? GenUIHairline() : nil
        super.init(key: key)
        switch box.role {
        case .card:
            backgroundColor = UIColor(Palette.cardFill)
            layer.cornerRadius = GenUIMetrics.cardRadius
            layer.cornerCurve = .continuous
            layer.borderWidth = 1
            layer.borderColor = UIColor(Palette.divider).cgColor
            clipsToBounds = true
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GenUIBoxView, _) in
                view.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: view.traitCollection).cgColor
            }
        case .notice:
            backgroundColor = UIColor((box.tone ?? .neutral).fill)
            layer.cornerRadius = GenUIMetrics.noticeRadius
            layer.cornerCurve = .continuous
        case .mosaic:
            layer.cornerRadius = GenUIMetrics.imageRadius
            layer.cornerCurve = .continuous
            clipsToBounds = true
        default:
            break
        }
        rule.map(addSubview)
        if box.direction == .column, box.divide != .none {
            dividers = children.dropFirst().map { _ in GenUIHairline() }
            dividers.forEach(addSubview)
        }
        children.forEach(addSubview)
    }

    private var row: Bool { box.direction == .row }

    private var padding: LayoutInsets {
        var padding = GenUIMetrics.padding(role: box.role.rawValue)
        if rule != nil { padding.top += GenUIMetrics.sectionRule }
        // A leading column no child fills is left empty.
        if leadingWidth > 0, !leadingChild { padding.left += leadingWidth + GenUIMetrics.leadingGap }
        return padding
    }

    /// The layout's children: the views, the first held to the leading
    /// column when it fills one.
    private var entries: [(view: GenUIElementView?, child: GenUIBoxLayout.Child)] {
        var entries: [(GenUIElementView?, GenUIBoxLayout.Child)] = children.map { ($0, $0.child) }
        if leadingWidth > 0, leadingChild, let first = children.first {
            let width = leadingWidth
            entries[0].1 = GenUIBoxLayout.Child(
                measure: { _ in CGSize(width: width, height: first.measure(width).height) }, baseline: { _ in first.baseline(width) }, minWidth: width, fills: false
            )
        }
        return entries
    }

    private func gaps(_ entries: [(view: GenUIElementView?, child: GenUIBoxLayout.Child)]) -> [CGFloat] {
        let divided = box.divide != .none
        return zip(entries, entries.dropFirst()).enumerated().map { index, pair in
            if index == 0, leadingWidth > 0, leadingChild { return GenUIMetrics.leadingGap }
            return GenUIMetrics.gap(
                box.gap.rawValue, role: box.role.rawValue, row: row, divided: divided,
                between: pair.0.view?.neighbour ?? .other, and: pair.1.view?.neighbour ?? .other
            )
        }
    }

    private func layout(_ width: CGFloat) -> (GenUIBoxLayout, [GenUIElementView?]) {
        let entries = entries
        let views = entries.map(\.view)
        let gaps = gaps(entries)
        if box.role == .mosaic {
            let ratio = GenUIMetrics.ratio(children.lazy.compactMap { ($0 as? GenUIImageView)?.shape }.first?.rawValue ?? "landscape")
            let mosaic = GenUIMosaicLayout(width: width, count: children.count, ratio: ratio)
            var layout = GenUIBoxLayout(width: width, row: false, gaps: [], children: [])
            layout.frames = children.indices.map { mosaic.tiles.indices.contains($0) ? mosaic.tiles[$0] : .zero }
            layout.size = mosaic.size
            return (layout, views)
        }
        if box.role == .actions, row {
            let inner = max(0, width - padding.horizontal)
            let sizes = children.map { $0.measure(inner) }
            let actions = GenUIActionsLayout(width: inner, widths: sizes.map(\.width), heights: sizes.map(\.height))
            var layout = GenUIBoxLayout(width: width, row: false, gaps: [], children: [])
            layout.frames = actions.frames.map { $0.offsetBy(dx: padding.left, dy: padding.top) }
            layout.size = CGSize(width: width, height: actions.size.height + padding.vertical)
            return (layout, views)
        }
        let lineGap = GenUIMetrics.gap(box.gap.rawValue, role: box.role.rawValue, row: false, divided: false, between: .text, and: .text)
        let layout = GenUIBoxLayout(
            width: width, padding: padding, row: row, gaps: gaps, lineGap: box.gap == .inline ? GenUIMetrics.buttonGap : lineGap,
            align: GenUIBoxLayout.Align(rawValue: box.align.rawValue) ?? .stretch, justify: GenUIBoxLayout.Justify(rawValue: box.justify.rawValue) ?? .start,
            equal: row && box.equal, wrap: row && box.wrap, children: entries.map(\.child)
        )
        return (layout, views)
    }

    override func natural(_ width: CGFloat) -> CGSize {
        let (layout, views) = layout(width)
        guard !children.isEmpty, layout.size.height > padding.vertical || box.role == .card else { return CGSize(width: 0, height: 0) }
        // As wide as its content when nothing in it spreads or fills.
        let inner = max(0, width - padding.horizontal)
        let spreads = box.role != .plain || box.equal || box.justify != .start || children.contains(where: \.grows)
        let contentWidth: CGFloat
        if spreads {
            contentWidth = inner
        } else if row {
            contentWidth = min(inner, layout.frames.map(\.maxX).max().map { $0 - padding.left } ?? 0)
        } else {
            contentWidth = min(inner, zip(views, layout.frames).map { view, frame in view.map { $0.measure(inner).width } ?? frame.width }.max() ?? 0)
        }
        return CGSize(width: contentWidth + padding.horizontal, height: layout.size.height)
    }

    override func baseline(_ width: CGFloat) -> CGFloat { layout(width).0.baseline }

    override var minWidth: CGFloat {
        let mins = entries.map(\.child.minWidth)
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

    override func layoutSubviews() {
        super.layoutSubviews()
        let (layout, views) = layout(bounds.width)
        var placed: [(GenUIElementView, CGRect)] = []
        for (view, frame) in zip(views, layout.frames) {
            guard let view else { continue }
            view.isHidden = frame.height <= 0
            placed.append((view, frame))
        }
        // A step's rail runs on to the next step's marker.
        for (index, (view, frame)) in placed.enumerated() {
            var frame = frame
            if row, let marker = view as? GenUIMarkerView, marker.hasRail {
                frame.size.height = bounds.height - frame.minY + extendBottom
            }
            if !row {
                let next = placed[(index + 1)...].first { $0.1.height > 0 }
                view.extendBottom = next.map { $0.1.minY - frame.maxY } ?? 0
            }
            view.setLayoutFrame(frame)
        }
        rule?.setLayoutFrame(CGRect(x: 0, y: 0, width: bounds.width, height: hairline))
        if !dividers.isEmpty {
            let inner = bounds.width - padding.horizontal
            let insets = children.map { box.divide == .inset ? $0.dividerInset : 0 }
            let frames = GenUIDividers.frames(placed.map(\.1).map { $0.offsetBy(dx: -padding.left, dy: 0) }, insets: insets, width: inner, hairline: hairline)
            for (index, divider) in dividers.enumerated() {
                divider.isHidden = index >= frames.count
                if index < frames.count { divider.setLayoutFrame(frames[index].offsetBy(dx: padding.left, dy: 0)) }
            }
        }
    }
}

/// `grid`: a table whose columns are sized together; a header row and
/// hairlines between rows when asked.
final class GenUIGridView: GenUIElementView {
    private let grid: GenUIGrid
    private let cells: [GenUIElementView]
    private var rules: [GenUIHairline] = []

    init(key: String, _ grid: GenUIGrid, _ nodes: [GenUINode], context: GenUIContext, place: GenUIPlace) {
        self.grid = grid
        // A cell's text aligns with its column, whatever its own `align`.
        cells = nodes.enumerated().map { index, node in
            var place = place
            place.columnEnd = grid.columns[index % grid.columns.count].align == .end
            return GenUIElements.make(node, context: context, place: place)
        }
        super.init(key: key)
        let rows = (cells.count + grid.columns.count - 1) / max(1, grid.columns.count)
        let lines = max(0, grid.divide ? rows - 1 : (grid.header && rows > 1 ? 1 : 0))
        rules = (0..<lines).map { _ in GenUIHairline() }
        rules.forEach(addSubview)
        cells.forEach(addSubview)
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

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(bounds.width)
        for (cell, frame) in zip(cells, layout.cells) { cell.setLayoutFrame(frame) }
        for (index, rule) in rules.enumerated() where index + 1 < layout.rows.count {
            rule.setLayoutFrame(CGRect(x: 0, y: layout.rows[index + 1].minY, width: bounds.width, height: hairline))
        }
    }
}

/// `scroll`: the carousel. Cards run out to the chat's edges (or the
/// card's), the next one peeking, a swipe settling on one card at a time.
final class GenUIScrollView: GenUIElementView, UIScrollViewDelegate {
    let shape: GenUIShape
    private let scroll = UIScrollView()
    private let cards: [GenUIElementView]
    private let bleed: CGFloat

    init(key: String, shape: GenUIShape, _ nodes: [GenUINode], context: GenUIContext, place: GenUIPlace) {
        self.shape = shape
        bleed = place.bleed
        cards = nodes.map { GenUIElements.make($0, context: context, place: place) }
        super.init(key: key)
        scroll.showsHorizontalScrollIndicator = false
        scroll.decelerationRate = .fast
        scroll.alwaysBounceHorizontal = true
        scroll.delegate = self
        addSubview(scroll)
        cards.forEach(scroll.addSubview)
    }

    private func layout(_ width: CGFloat) -> GenUICarouselLayout {
        GenUICarouselLayout(viewport: width + 2 * bleed, inset: bleed, shape: shape.rawValue, count: cards.count) { [cards] width in
            cards.map { $0.measure(width).height }.max() ?? 0
        }
    }

    override func natural(_ width: CGFloat) -> CGSize { CGSize(width: width, height: layout(width).cards.first?.height ?? 0) }
    override var minWidth: CGFloat { 240 }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(bounds.width)
        scroll.frame = CGRect(x: -bleed, y: 0, width: bounds.width + 2 * bleed, height: bounds.height)
        scroll.contentSize = CGSize(width: layout.contentWidth, height: bounds.height)
        for (card, frame) in zip(cards, layout.cards) {
            card.setLayoutFrame(CGRect(x: frame.minX, y: 0, width: frame.width, height: card.measure(frame.width).height))
        }
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        targetContentOffset.pointee.x = layout(bounds.width).stop(proposed: targetContentOffset.pointee.x, velocity: velocity.x, current: scrollView.contentOffset.x)
    }
}

/// `switch`: `compact` on a phone, `regular` from `GenUIMetrics.regularWidth`;
/// either alone when the other is missing.
final class GenUISwitchView: GenUIElementView {
    private let compact: GenUIElementView?
    private let regular: GenUIElementView?

    init(key: String, compact: GenUINode?, regular: GenUINode?, context: GenUIContext, place: GenUIPlace) {
        self.compact = compact.map { GenUIElements.make($0, context: context, place: place) }
        self.regular = regular.map { GenUIElements.make($0, context: context, place: place) }
        super.init(key: key)
        self.compact.map(addSubview)
        self.regular.map(addSubview)
    }

    private func branch(_ width: CGFloat) -> GenUIElementView? {
        width < GenUIMetrics.regularWidth ? compact ?? regular : regular ?? compact
    }

    private var phoneBranch: GenUIElementView? { compact ?? regular }

    override func natural(_ width: CGFloat) -> CGSize { branch(width)?.measure(width) ?? .zero }
    override func baseline(_ width: CGFloat) -> CGFloat { branch(width)?.baseline(width) ?? 0 }
    override var minWidth: CGFloat { phoneBranch?.minWidth ?? 0 }
    override var grows: Bool { phoneBranch?.grows ?? false }
    override var fills: Bool { phoneBranch?.fills ?? true }
    override var neighbour: GenUIMetrics.Neighbour { phoneBranch?.neighbour ?? .other }
    override var dividerInset: CGFloat { phoneBranch?.dividerInset ?? 0 }

    override var extendBottom: CGFloat {
        didSet { compact?.extendBottom = extendBottom; regular?.extendBottom = extendBottom }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let shown = branch(bounds.width)
        for view in [compact, regular].compactMap({ $0 }) {
            view.isHidden = view !== shown
            if view === shown { view.setLayoutFrame(bounds) }
        }
    }
}

/// `press`: its child, tappable. A list row's pressed ground runs to the
/// card's edges, a carousel card dims as a whole, anything else gets a
/// rounded ground just past its content. In a group, the chosen one keeps
/// a soft accent ground and the others dim and stop taking taps. Without
/// an action the child is drawn and nothing happens.
final class GenUIPressView: GenUIElementView, GenUIChoice {
    private let control = GenUIPressable()
    private let content: [GenUIElementView]
    private let role: GenUIPress.Role
    private let reach: CGFloat

    init(key: String, _ press: GenUIPress, _ nodes: [GenUINode], context: GenUIContext, place: GenUIPlace) {
        let views = nodes.map { GenUIElements.make($0, context: context, place: place) }
        content = views
        role = press.role
        reach = press.role == .item && place.inCard ? GenUIMetrics.cardPadding : 8
        super.init(key: key)
        control.layer.cornerRadius = switch press.role {
        case .item: place.inCard ? 0 : 8
        case .tile: GenUIMetrics.coverRadius
        case .plain: 8
        }
        control.layer.cornerCurve = .continuous
        if press.role == .tile { control.pressedColor = .clear }
        addSubview(control)
        for view in views {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        guard let action = press.action else {
            control.isEnabled = false
            return
        }
        control.accessibilityTraits = .button
        control.isAccessibilityElement = true
        control.accessibilityLabel = views.map { $0.accessibilityText }.joined(separator: ", ")
        control.addAction(UIAction { [weak context, key] _ in context?.activate(key, action, group: press.group) }, for: .touchUpInside)
        if press.role == .tile {
            control.addAction(UIAction { [weak self] _ in self?.dim(true) }, for: [.touchDown, .touchDragEnter])
            control.addAction(UIAction { [weak self] _ in self?.dim(false) }, for: [.touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel])
        }
        context.join(press.group, self)
    }

    private func dim(_ pressed: Bool) {
        for view in content { view.alpha = pressed ? 0.6 : 1 }
    }

    private var single: GenUIElementView? { content.count == 1 ? content[0] : nil }

    override func natural(_ width: CGFloat) -> CGSize {
        var height: CGFloat = 0
        var widest: CGFloat = 0
        for view in content {
            let size = view.measure(width)
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

    func show(chosen: Bool) {
        control.restingColor = chosen ? UIColor(GenUITone.accent.fill) : .clear
        control.isEnabled = false
        for view in content { view.alpha = chosen ? 1 : 0.4 }
        control.accessibilityTraits = chosen ? [.button, .selected] : [.button, .notEnabled]
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The pressed ground reaches past the content into the gaps around
        // it; a carousel card is pressed as itself.
        control.frame = role == .tile ? bounds : bounds.insetBy(dx: -reach, dy: -8)
        var y: CGFloat = 0
        for view in content {
            let height = view.measure(bounds.width).height
            view.setLayoutFrame(CGRect(x: 0, y: y, width: bounds.width, height: height))
            y += height
        }
    }
}

extension UIView {
    /// What VoiceOver reads for a view's labels, depth first.
    @MainActor
    var accessibilityText: String {
        if let label = self as? UILabel { return label.text ?? "" }
        if let label = accessibilityLabel, !label.isEmpty { return label }
        return subviews.map(\.accessibilityText).filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
#endif
