#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// A view over one slot's bitmap that the screen makes: a thumbnail, a
/// checkbox, a chart. `kind` says which, `key` what it shows, `frame`
/// where, in the slot's coordinates.
struct CardOverlay: Equatable, Sendable {
    var kind: String
    var key: String
    var frame: CGRect
    var radius: CGFloat = 0
}

/// One slot of a card list as worked out off the main thread: its size,
/// its part of a card, its drawing, the views over it and how VoiceOver
/// reads it. `revision` changes exactly when something it shows does
/// (`CardItems.revise`), so an unchanged row is never touched.
struct CardItem: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case row
        case heading
        case note
    }

    var id: String
    var kind: Kind
    var size: CGSize
    /// The row's part of its card, filled under the drawing; nil for a
    /// heading or a note.
    var card: CGRect?
    var place = CardPlace.alone
    var drawing: CardDrawing
    /// A finger lights it and a tap opens it.
    var opens = false
    var overlays: [CardOverlay] = []
    var accessibilityLabel = ""
    var accessibilityValue: String?
    var revision: UInt64 = 0

    /// Everything but the revision, which is the list's own.
    func sameContent(_ other: CardItem) -> Bool {
        var other = other
        other.revision = revision
        return self == other
    }
}

enum CardItems {
    /// `next` with each item's revision kept where its content is the same
    /// as the previous item of its ID, and a new one where it isn't. Off
    /// the main thread, in a screen's derivation.
    nonisolated static func revise(_ next: [CardItem], previous: [String: CardItem], counter: inout UInt64) -> [CardItem] {
        next.map { item in
            var item = item
            if let old = previous[item.id], old.sameContent(item) {
                item.revision = old.revision
            } else {
                counter += 1
                item.revision = counter
            }
            return item
        }
    }

    /// A heading over a card.
    nonisolated static func heading(_ id: String, _ text: String, width: CGFloat, maxWidth: CGFloat, afterCard: Bool, dark: Bool, displayScale: CGFloat) -> CardItem {
        let layout = CardHeadingLayout(width: width, maxWidth: maxWidth, afterCard: afterCard)
        var drawing = CardDrawing(dark: dark, displayScale: displayScale)
        let font = CardFont(.medium, CardListMetrics.headingSize)
        drawing.text(text.uppercased(), font, Palette.settingsSecondary, layout.label, kern: CardListMetrics.headingSize * 0.02)
        var item = CardItem(id: id, kind: .heading, size: layout.size, drawing: drawing)
        item.accessibilityLabel = text
        return item
    }

    /// A quiet line in place of rows: an empty list, a search that found nothing.
    nonisolated static func note(_ id: String, _ text: String, width: CGFloat, maxWidth: CGFloat, scale: CGFloat, dark: Bool, displayScale: CGFloat) -> CardItem {
        let font = CardFont(.regular, CardListMetrics.noteSize, scale: scale)
        let layout = CardNoteLayout(width: width, maxWidth: maxWidth, text: CardText.measurable(text, font: font, maxLines: 0, scale: displayScale))
        var drawing = CardDrawing(dark: dark, displayScale: displayScale)
        let paragraph = layout.text
        drawing.text(text, font, Palette.settingsSecondary, paragraph, wraps: true)
        var item = CardItem(id: id, kind: .note, size: layout.size, drawing: drawing)
        item.accessibilityLabel = text
        return item
    }
}

/// Uses UltraView's display queue for the drawing.
private struct CardNodeDrawing: Drawing {
    let drawing: CardDrawing
    func draw(in context: CGContext, bounds: CGRect) { drawing.draw(in: context, bounds: bounds) }
}

@MainActor
final class CardListRow: ListRow {
    let identity: String
    let revision: UInt64
    let item: CardItem
    let node: NodeRow
    weak var owner: CardListView?
    var measuresAsynchronously: Bool { true }

    init(item: CardItem, owner: CardListView) {
        identity = item.id
        revision = item.revision
        self.item = item
        self.owner = owner
        let drawing = CardNodeDrawing(drawing: item.drawing)
        let height = item.size.height
        node = NodeRow(identity: item.id, revision: item.revision) {
            var style = Style()
            style.height = .points(height)
            let root = UltraNode(style: style)
            root.drawing = drawing
            return root
        }
    }

    var trailingSwipeActions: [ListSwipeAction] { owner?.swipeActions?(identity) ?? [] }
    var leadingSwipeActions: [ListSwipeAction] { owner?.leadingSwipeActions?(identity) ?? [] }

    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { await node.prepare(width: width, environment: environment) }
    func makeView() -> ListRowView { CardListRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? CardListRowView)?.apply(self, transition: transition) }
}

/// A slot on screen: the card's part under the press fill, the drawing,
/// then the screen's views over it.
@MainActor
final class CardListRowView: ListRowView, UIContextMenuInteractionDelegate, UIGestureRecognizerDelegate {
    private(set) var row: CardListRow
    private let card = UIView()
    private let pressFill = UIView()
    private let content = UIView()
    private var drawingView: ListRowView
    private(set) var overlays: [String: UIView] = [:]
    private let tap = UITapGestureRecognizer()
    private var menuInteraction: UIContextMenuInteraction?
    private var pressed = false
    var identity: String { row.identity }
    override var isDisplayReady: Bool { drawingView.isDisplayReady }

    init(row: CardListRow) {
        self.row = row
        drawingView = row.node.makeView()
        super.init(frame: .zero)
        for view in [card, pressFill] {
            view.isUserInteractionEnabled = false
            view.layer.cornerCurve = .continuous
            addSubview(view)
        }
        pressFill.alpha = 0
        addSubview(content)
        content.addSubview(drawingView)
        drawingView.onDisplayReady = { [weak self] in self?.reportDisplayReady() }
        tap.addTarget(self, action: #selector(tapped))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        addGestureRecognizer(tap)
        applyRow()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ next: CardListRow, transition: ListTransition) {
        let previous = row
        row = next
        next.node.apply(to: drawingView, transition: transition)
        if previous.item.overlays != next.item.overlays || previous.identity != next.identity {
            for view in overlays.values { view.removeFromSuperview() }
            overlays = [:]
        }
        applyRow()
        setNeedsLayout()
    }

    /// The overlay the screen made for `key`, if it is on this row.
    func overlay(_ key: String) -> UIView? { overlays[key] }

    private func applyRow() {
        let item = row.item
        card.isHidden = item.card == nil
        pressFill.isHidden = item.card == nil
        var corners: CACornerMask = []
        if item.place.first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
        if item.place.last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
        for view in [card, pressFill] {
            view.layer.cornerRadius = corners.isEmpty ? 0 : CardListMetrics.radius
            view.layer.maskedCorners = corners
        }
        for overlay in item.overlays where overlays[overlay.key] == nil {
            guard let view = row.owner?.makeOverlay?(overlay, item.id) else { continue }
            overlays[overlay.key] = view
            content.addSubview(view)
        }
        tap.isEnabled = item.opens
        if row.owner?.menu != nil, item.kind == .row, menuInteraction == nil {
            let interaction = UIContextMenuInteraction(delegate: self)
            addInteraction(interaction)
            menuInteraction = interaction
        }
        applyColors()
        isAccessibilityElement = !item.accessibilityLabel.isEmpty
        accessibilityLabel = item.accessibilityLabel
        accessibilityValue = item.accessibilityValue
        accessibilityTraits = item.kind == .heading ? .header : item.opens ? .button : .staticText
        accessibilityIdentifier = item.id
        setPressed(false, animated: false)
    }

    private func applyColors() {
        card.backgroundColor = UIColor(Palette.groupedCard)
        pressFill.backgroundColor = UIColor(Palette.groupedCellHighlight)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.frame = bounds
        drawingView.frame = bounds
        let box = row.item.card.map { CGRect(x: $0.minX, y: 0, width: $0.width, height: bounds.height) } ?? .zero
        card.frame = box
        pressFill.frame = box
        for overlay in row.item.overlays {
            overlays[overlay.key]?.frame = overlay.frame
        }
    }

    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawingView.applyPreparation(preparation, width: width, environment: environment)
    }

    override func update(width: Double, transition: ListTransition) -> Double { row.item.size.height }

    // MARK: Touch

    /// iOS's cell timings: the fill comes in quickly and leaves slowly.
    private func setPressed(_ pressed: Bool, animated: Bool) {
        self.pressed = pressed
        let alpha: CGFloat = pressed && row.item.opens ? 1 : 0
        guard pressFill.alpha != alpha else { return }
        guard animated else { pressFill.layer.removeAllAnimations(); pressFill.alpha = alpha; return }
        UIView.animate(withDuration: alpha > 0 ? RowHighlight.fadeIn : RowHighlight.fadeOut, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.pressFill.alpha = alpha
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        if row.item.opens { setPressed(true, animated: true) }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesMoved(touches, with: event)
        if pressed, let touch = touches.first, !bounds.insetBy(dx: -10, dy: -10).contains(touch.location(in: self)) { setPressed(false, animated: true) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        setPressed(false, animated: true)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        setPressed(false, animated: true)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var target = touch.view
        while let view = target, view !== self {
            if view is UIControl || view is UITextView { return false }
            target = view.superview
        }
        return true
    }

    @objc private func tapped() {
        guard row.item.opens else { return }
        row.owner?.onSelect?(row.identity)
    }

    override func accessibilityActivate() -> Bool {
        guard row.item.opens else { return false }
        row.owner?.onSelect?(row.identity)
        return true
    }

    // MARK: Menu

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let menu = row.owner?.menu?(row.identity) else { return nil }
        return UIContextMenuConfiguration(identifier: row.identity as NSString, previewProvider: nil) { _ in menu }
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? {
        guard let box = row.item.card, window != nil else { return nil }
        let parameters = UIPreviewParameters()
        parameters.visiblePath = UIBezierPath(roundedRect: CGRect(x: box.minX, y: 0, width: box.width, height: bounds.height), cornerRadius: CardListMetrics.radius)
        parameters.backgroundColor = UIColor(Palette.groupedCard)
        return UITargetedPreview(view: self, parameters: parameters)
    }
}

/// The screens' card lists on UltraList: only the rows near the screen
/// mounted, each drawn off the main thread, a change applying only the
/// rows whose revision moved. Like home's list it rides inside a scroll
/// view that never scrolls under a finger (`SidebarListEdge`), so the
/// bar's soft edge and the indicator follow it. A pull past the top
/// asks for a refresh when the screen takes one.
@MainActor
final class CardListView: UIView {
    let list = UltraListView(engineMode: .keyframe)
    let edge = SidebarListEdge()
    private let spinner = UIActivityIndicatorView(style: .medium)

    var onSelect: ((String) -> Void)?
    var swipeActions: ((String) -> [ListSwipeAction])?
    var leadingSwipeActions: ((String) -> [ListSwipeAction])?
    /// What a hold on a row offers; nil for none.
    var menu: ((String) -> UIMenu?)?
    /// Makes the view an overlay asks for on the row `id`.
    var makeOverlay: ((CardOverlay, _ id: String) -> UIView?)?
    /// Set to let a pull past the top refresh.
    var onRefresh: (() -> Void)?
    var onScroll: (() -> Void)?

    private(set) var items: [CardItem] = []
    private var rows: [String: CardListRow] = [:]
    private var tops: [CGFloat] = []
    private(set) var contentInsets = UIEdgeInsets.zero
    private var refreshRoom: CGFloat = 0
    /// Pulled this far past the top, a release refreshes.
    static let refreshPull: CGFloat = 64
    static let refreshRoomHeight: CGFloat = 44

    /// The refresh asked for is under way: the spinner holds its room.
    var refreshing = false {
        didSet {
            guard refreshing != oldValue else { return }
            if refreshing { spinner.startAnimating() } else { spinner.stopAnimating() }
            refreshRoom = refreshing ? Self.refreshRoomHeight : 0
            applyInsets(animated: true)
            placeSpinner()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        list.accessibilityIdentifier = "card-list"
        list.swipeActions.allowsFullSwipe = false
        list.onScroll = { [weak self] _ in self?.scrolled() }
        list.onVisibleWindowChanged = { [weak self] in self?.mirror() }
        list.didEndDragging = { [weak self] in self?.released() }
        addSubview(edge)
        edge.addSubview(list)
        spinner.hidesWhenStopped = false
        spinner.alpha = 0
        addSubview(spinner)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        if edge.frame != bounds {
            edge.frame = bounds
            list.frame = CGRect(origin: edge.bounds.origin, size: bounds.size)
            list.applyChanges(newSize: bounds.size, transition: .none)
        }
        placeSpinner()
    }

    /// Shows `next`, worked out off the main thread at this list's width.
    /// Rows whose revision didn't move are kept as they are.
    func apply(_ next: [CardItem], animated: Bool) {
        let previousIDs = items.map(\.id)
        var shown: [any ListRow] = []
        var kept: [String: CardListRow] = [:]
        var touched = 0
        for item in next {
            let row: CardListRow
            if let existing = rows[item.id], existing.revision == item.revision { row = existing }
            else { row = CardListRow(item: item, owner: self); touched += 1 }
            shown.append(row)
            kept[item.id] = row
        }
        rows = kept
        items = next
        var y: CGFloat = 0
        tops = next.map { item in defer { y += item.size.height }; return y }
        let structural = previousIDs != next.map(\.id)
        let moves = animated && structural && !previousIDs.isEmpty && window != nil && !UIAccessibility.isReduceMotionEnabled
        ApplyPerf.measure(.screen) {
            list.applyChanges(items: shown, newSize: bounds.width > 0 ? bounds.size : nil, anchorMode: .automatic, transition: moves ? .easeInOut(0.25) : .none)
            return touched
        }
        edge.contentSize = CGSize(width: bounds.width, height: y)
        mirror()
    }

    /// The row view of `id`, if it is mounted.
    func rowView(_ id: String) -> CardListRowView? {
        list.loadedItemViews.lazy.compactMap { $0 as? CardListRowView }.first { $0.identity == id }
    }

    /// Where `id`'s slot is on screen, if it is mounted.
    func frame(of id: String) -> CGRect? {
        guard let index = items.firstIndex(where: { $0.id == id }), let frame = list.presentedFrame(at: index) else { return nil }
        return list.convert(frame, to: self)
    }

    // MARK: Place

    /// Room under the bar and above the bottom; the indicator's the same.
    func setInsets(_ insets: UIEdgeInsets) {
        guard insets != contentInsets else { return }
        let atTop = isAtTop
        contentInsets = insets
        edge.verticalScrollIndicatorInsets = insets
        applyInsets(animated: false, keepsTop: atTop)
    }

    private func applyInsets(animated: Bool, keepsTop: Bool = true) {
        let top = contentInsets.top + refreshRoom
        edge.contentInset = UIEdgeInsets(top: top, left: 0, bottom: contentInsets.bottom, right: 0)
        list.applyChanges(newSize: bounds.width > 0 ? bounds.size : nil, newInsets: .init(top: top, bottom: contentInsets.bottom), anchorMode: keepsTop ? .automatic : .preserveVisibleContent, compensatesInsetChange: keepsTop, transition: animated && window != nil ? .easeInOut(0.3) : .none)
        mirror()
    }

    /// The list's place as a scroll view's `contentOffset.y`: `-top` at
    /// rest at its top, less under a pull.
    var contentOffsetY: CGFloat {
        let top = contentInsets.top + refreshRoom
        for index in list.loadedIndexRange where tops.indices.contains(index) {
            guard let frame = list.settledFrame(at: index) else { continue }
            return tops[index] - frame.minY
        }
        return -top
    }

    var isAtTop: Bool { contentOffsetY <= -(contentInsets.top + refreshRoom) + 1 }

    func scrollToTop(animated: Bool) { list.scrollToTop(animated: animated) }

    private func scrolled() {
        mirror()
        placeSpinner()
        onScroll?()
    }

    private func mirror() {
        let offset = contentOffsetY
        guard abs(edge.contentOffset.y - offset) > 0.01 else { return }
        edge.contentOffset.y = offset
        list.frame.origin = edge.bounds.origin
    }

    // MARK: Refresh

    /// How far past its top the list is pulled.
    private var pull: CGFloat { max(0, -(contentOffsetY + contentInsets.top + refreshRoom)) }

    private func placeSpinner() {
        guard onRefresh != nil else { spinner.alpha = 0; return }
        let room = refreshing ? Self.refreshRoomHeight : pull
        let side = spinner.intrinsicContentSize
        spinner.frame = CGRect(x: ((bounds.width - side.width) / 2).rounded(), y: (contentInsets.top + (room - side.height) / 2).rounded(), width: side.width, height: side.height)
        spinner.alpha = refreshing ? 1 : min(1, pull / Self.refreshPull)
        if !refreshing {
            if pull > 8 { spinner.startAnimating() } else { spinner.stopAnimating() }
        }
    }

    private func released() {
        guard let onRefresh, !refreshing, pull >= Self.refreshPull else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        refreshing = true
        onRefresh()
    }
}
#endif
