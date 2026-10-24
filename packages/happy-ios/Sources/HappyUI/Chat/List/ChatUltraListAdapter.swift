#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// The existing row plans are immutable and measured off main. UltraView
/// rasterizes their static marks only for its prepared, bounded window.
private struct ChatNodeDrawing: Drawing {
    let plan: ChatRowPlan
    let dark: Bool
    let scale: CGFloat
    let y: CGFloat

    func draw(in context: CGContext, bounds: CGRect) {
        UITraitCollection(userInterfaceStyle: dark ? .dark : .light).performAsCurrent {
            drawMarks(in: context, bounds: bounds)
        }
    }

    private func drawMarks(in context: CGContext, bounds: CGRect) {
        context.translateBy(x: 0, y: -y)
        let visible = bounds.offsetBy(dx: 0, dy: y)
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        for item in plan.items {
            context.saveGState()
            switch item {
            case .box(let box):
                guard box.frame.intersects(visible) else { context.restoreGState(); continue }
                var corners: UIRectCorner = []
                if box.corners.contains(.layerMinXMinYCorner) { corners.insert(.topLeft) }
                if box.corners.contains(.layerMaxXMinYCorner) { corners.insert(.topRight) }
                if box.corners.contains(.layerMinXMaxYCorner) { corners.insert(.bottomLeft) }
                if box.corners.contains(.layerMaxXMaxYCorner) { corners.insert(.bottomRight) }
                let path = UIBezierPath(roundedRect: box.frame, byRoundingCorners: corners, cornerRadii: .init(width: box.radius, height: box.radius))
                context.setAlpha(box.alpha)
                if let fill = box.fill { context.setFillColor(UIColor(fill).cgColor); context.addPath(path.cgPath); context.fillPath() }
                if let border = box.border, box.borderWidth > 0 {
                    // CALayer's border lies inside the box.
                    context.addPath(path.cgPath); context.clip()
                    context.setStrokeColor(UIColor(border).cgColor); context.setLineWidth(box.borderWidth * 2)
                    context.addPath(path.cgPath); context.strokePath()
                }
            case .text(let text, let frame):
                guard frame.intersects(visible) else { context.restoreGState(); continue }
                context.clip(to: frame)
                text.draw(at: frame.origin, visibleRect: visible.intersection(frame))
            case .icon(let icon, let size, let frame, let tint):
                guard frame.intersects(visible) else { context.restoreGState(); continue }
                if let glyph = IconCatalog.glyph(for: icon) {
                    let layout = glyph.layout(size: size, scale: scale)
                    let box = layout.frame(centeredIn: frame, scale: scale)
                    context.translateBy(x: box.minX + layout.glyphOrigin.x, y: box.minY + layout.glyphOrigin.y)
                    context.scaleBy(x: layout.glyphScale, y: layout.glyphScale)
                    context.setFillColor(UIColor(tint).cgColor)
                    context.addPath(glyph.path.cgPath); context.fillPath()
                }
            default: break
            }
            context.restoreGState()
        }
    }
}

@MainActor
final class ChatUltraRow: ListRow {
    let identity: String
    let revision: UInt64
    let plan: ChatRowPlan
    let contentY: CGFloat
    let node: NodeRow
    /// The established native canvas handles exceptionally tall messages;
    /// rasterizing an entire multi-megabyte transcript would retain too much.
    let usesNativeDrawing: Bool
    weak var adapter: ChatUltraListAdapter?
    var measuresAsynchronously: Bool { true }

    init(identity: String, revision: UInt64, plan: ChatRowPlan, contentY: CGFloat, adapter: ChatUltraListAdapter, preparedNode: NodeRow? = nil) {
        self.identity = identity; self.revision = revision; self.plan = plan; self.contentY = contentY; self.adapter = adapter
        usesNativeDrawing = Self.requiresNativeDrawing(plan)
        if let preparedNode { node = preparedNode; return }
        let native = usesNativeDrawing
        let dark = adapter.list.traitCollection.userInterfaceStyle == .dark
        let scale = adapter.list.traitCollection.displayScale
        node = NodeRow(identity: identity, revision: revision, measurer: adapter.measurer) {
            var style = Style()
            style.height = .points(plan.size.height)
            let root = UltraNode(style: style)
            if native { return root }
            // Long messages exceed a single bitmap's pixel cap. Fixed
            // vertical tiles keep them drawable at every text size.
            var y: CGFloat = 0
            while y < plan.size.height {
                var tileStyle = Style()
                let height = min(512, plan.size.height - y)
                tileStyle.height = .points(height)
                tileStyle.flexShrink = 0
                let tile = UltraNode(style: tileStyle)
                tile.drawing = ChatNodeDrawing(plan: plan, dark: dark, scale: scale, y: y)
                root.addChild(tile)
                y += height
            }
            return root
        }
    }

    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { await node.prepare(width: width, environment: environment) }
    func makeView() -> ListRowView { ChatUltraRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? ChatUltraRowView)?.apply(self, transition: transition) }

    private static func requiresNativeDrawing(_ plan: ChatRowPlan) -> Bool {
        guard plan.size.height <= 4096 else { return true }
        // A single bitmap is below the live overlay. If a later static
        // mark overlaps earlier live content, retain the original painter
        // order using the native canvas for this row.
        var live: [CGRect] = []
        for item in plan.items {
            switch item {
            case .box(let box):
                if live.contains(where: { $0.intersects(box.frame) }) { return true }
            case .text(_, let frame), .icon(_, _, let frame, _):
                if live.contains(where: { $0.intersects(frame) }) { return true }
            case .spinner(let frame, _, _), .elapsed(_, let frame, _), .diff(_, let frame, _, _, _, _),
                 .diffHeader(_, _, let frame), .scroller(_, let frame, _, _), .attachment(_, let frame),
                 .webImage(_, let frame, _), .mermaid(_, let frame), .media(_, let frame), .embed(_, let frame): live.append(frame)
            case .pulse(let box): live.append(box.frame)
            }
        }
        return false
    }
}

@MainActor
final class ChatUltraRowView: ListRowView, UIGestureRecognizerDelegate {
    private(set) var row: ChatUltraRow
    private let drawing: ListRowView
    let canvas = ChatPlanView()
    private let hold = UILongPressGestureRecognizer()
    override var isDisplayReady: Bool { drawing.isDisplayReady }

    init(row: ChatUltraRow) {
        self.row = row
        drawing = row.node.makeView()
        super.init(frame: .zero)
        transform = ChatCollectionLayout.flip
        clipsToBounds = true
        canvas.drawsStaticContent = row.usesNativeDrawing
        addSubview(drawing); addSubview(canvas)
        drawing.onDisplayReady = { [weak self] in self?.reportDisplayReady() }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false; tap.delegate = self
        hold.addTarget(self, action: #selector(held(_:)))
        hold.minimumPressDuration = CopyMenuLayout.Metrics.pressDuration
        hold.delegate = self
        addGestureRecognizer(tap); addGestureRecognizer(hold)
        tap.require(toFail: hold)
        applyCanvas()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func apply(_ row: ChatUltraRow, transition: ListTransition) {
        self.row = row
        row.node.apply(to: drawing, transition: transition)
        applyCanvas()
    }

    private func applyCanvas() {
        canvas.drawsStaticContent = row.usesNativeDrawing
        drawing.alpha = row.plan.alpha
        canvas.apply(row.plan)
        canvas.onAction = { [weak self] action in
            guard let adapter = self?.row.adapter, adapter.isActive else { return }
            adapter.onAction?(action)
        }
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        accessibilityLabel = row.plan.accessibilityLabel
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        drawing.frame = bounds; canvas.frame = bounds
    }
    override func update(width: Double, transition: ListTransition) -> Double { row.plan.size.height }
    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawing.applyPreparation(preparation, width: width, environment: environment)
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var target = touch.view
        while let view = target, view !== self {
            if view is UIControl { return false }
            target = view.superview
        }
        return true
    }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer !== hold || canvas.hold(at: gestureRecognizer.location(in: canvas)) != nil
    }
    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let adapter = row.adapter, adapter.isActive else { return }
        let point = gesture.location(in: canvas)
        if let url = canvas.link(at: point) { adapter.onLink?(url) }
        else if let action = canvas.action(at: point) { adapter.onAction?(action) }
    }
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let adapter = row.adapter, adapter.isActive,
              let hit = canvas.hold(at: gesture.location(in: canvas)) else { return }
        adapter.onHold?(hit.action, canvas, hit.frame, gesture.location(in: canvas))
    }
}

@MainActor
private struct ChatOlderUltraRow: ListRow {
    let identity = "chat:older-end"
    let revision: UInt64
    let view: ChatOlderEndView
    var measuresAsynchronously: Bool { true }
    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { .init(height: Double(ChatOlderEndLayout.height)) }
    func makeView() -> ListRowView { ChatOlderUltraView(content: view) }
}

@MainActor
private final class ChatOlderUltraView: ListRowView {
    private let content: ChatOlderEndView
    init(content: ChatOlderEndView) {
        self.content = content
        super.init(frame: .zero)
        transform = ChatCollectionLayout.flip
        content.transform = .identity
        addSubview(content)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func layoutSubviews() { super.layoutSubviews(); content.frame = bounds }
    override func update(width: Double, transition: ListTransition) -> Double { ChatOlderEndLayout.height }
}

/// Bridges the shared newest-first plans to UltraList. Logical content
/// positions come from HappyLayout, since the library retains only a window.
@MainActor
final class ChatUltraListAdapter {
    let list = UltraListView(engineMode: .keyframe)
    let measurer: any NodeRowMeasuring
    private let olderEnd: ChatOlderEndView
    private var rows: [String: ChatUltraRow] = [:]
    private var revision: UInt64 = 0
    private var model = ChatListLayout(width: 0, heights: [])
    private var insets = UIEdgeInsets.zero
    private var viewportSize = CGSize.zero
    private var latest: ChatListUpdate?
    private var submitted: UInt64 = 0
    private var motion: UInt64 = 0
    private struct Settlement {
        var submission: UInt64
        var motion: UInt64
        var follow: Bool
        var pin: (identity: String, end: CGFloat)?
        var animated: Bool
    }
    private var settlement: Settlement?
    private(set) var isActive = true
    var onScroll: (() -> Void)?
    var onAction: ((ChatRowAction) -> Void)?
    var onLink: ((String) -> Void)?
    var onHold: ((ChatRowAction, UIView, CGRect, CGPoint) -> Void)?

    init(olderEnd: ChatOlderEndView, measurer: any NodeRowMeasuring = NodeRowMeasurer()) {
        self.olderEnd = olderEnd
        self.measurer = measurer
        list.contentView.transform = ChatCollectionLayout.flip
        list.keyboardDismissMode = .interactive
        list.accessibilityIdentifier = "chat.ultralist"
        list.onScroll = { [weak self] _ in self?.onScroll?() }
        list.onVisibleWindowChanged = { [weak self] in
            self?.settleCommittedUpdate()
            self?.onScroll?()
        }
        list.willBeginDragging = { [weak self] in self?.motion &+= 1 }
        list.registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { [weak self] (_: UltraListView, _) in
            guard let self, let latest = self.latest else { return }
            self.rows.removeAll()
            self.apply(latest, animated: false)
        }
    }

    var visibleMinY: CGFloat {
        for index in list.loadedIndexRange {
            guard let row = list.items[index] as? ChatUltraRow, let frame = list.settledFrame(at: index) else { continue }
            return row.contentY - frame.minY + insets.top
        }
        return 0
    }

    var isDisplayReady: Bool {
        list.items.last?.revision == submitted && !list.loadedItemViews.isEmpty && list.loadedItemViews.allSatisfy(\.isDisplayReady)
    }

    /// `keyboard` carries the keyboard's transition and whether the rows
    /// move with the inset (`ChatUltraKeyboard`). The keyboard's change
    /// with an unchanged size takes the list's inset-only pass, which keeps
    /// a transition's viewport curve.
    func setViewport(size: CGSize, insets: UIEdgeInsets, keyboard: ChatUltraKeyboard.Change? = nil) {
        guard size.width > 0, size.height > 0 else { return }
        let sizeChanged = viewportSize != size
        let changed = self.insets != insets || sizeChanged
        self.insets = insets
        viewportSize = size
        guard changed else {
            if keyboard?.finishes == true { list.finishViewportTransition() }
            return
        }
        list.applyChanges(newSize: keyboard == nil || sizeChanged ? size : nil, newInsets: .init(top: insets.top, bottom: insets.bottom), anchorMode: .preserveVisibleContent,
                          compensatesInsetChange: keyboard?.compensates ?? !list.isTracking, transition: keyboard?.transition ?? .none)
    }

    func apply(_ update: ChatListUpdate, target: CGFloat? = nil, animated: Bool) {
        latest = update
        submitted &+= 1
        let idle = !list.isTracking && !list.isDragging && !list.isDecelerating
        let follow = idle && visibleMinY <= ChatScrollAnchor.followThreshold
        var pin: (identity: String, end: CGFloat)?
        if idle, visibleMinY > 0.5, let id = update.pinning {
            let identity = "chat:message:\(id)"
            if let index = list.items.firstIndex(where: { $0.identity == identity }), let frame = list.settledFrame(at: index) {
                pin = (identity, frame.maxY - insets.top)
            }
        }
        if pin == nil, update.pinning == nil, let previous = settlement,
           previous.motion == motion, let pendingPin = previous.pin,
           update.plans.contains(where: { "chat:message:\($0.id)" == pendingPin.identity }) {
            // Row planning emits a tool pin once. A newer token or syntax
            // pass may supersede its preparation before it is committed.
            pin = pendingPin
        }
        settlement = target == nil ? Settlement(submission: submitted, motion: motion, follow: pin == nil && follow, pin: pin, animated: animated) : nil
        model = update.model
        var next: [String: ChatUltraRow] = [:]
        func descriptor(_ plan: ChatRowPlan, identity: String, y: CGFloat) -> ChatUltraRow {
            if let cached = rows[identity], cached.plan === plan {
                let row = cached.contentY == y ? cached : ChatUltraRow(identity: identity, revision: cached.revision, plan: plan, contentY: y, adapter: self, preparedNode: cached.node)
                next[identity] = row; return row
            }
            // The revision is never reused, even after removing an identity.
            revision &+= 1
            let row = ChatUltraRow(identity: identity, revision: revision, plan: plan, contentY: y, adapter: self)
            next[identity] = row
            return row
        }
        var items: [any ListRow] = []
        if let footer = update.footer { items.append(descriptor(footer, identity: "chat:newer-end", y: 0)) }
        for (index, plan) in update.plans.enumerated() {
            items.append(descriptor(plan, identity: "chat:message:\(plan.id)", y: update.model.frame(ofRow: index).minY))
        }
        items.append(ChatOlderUltraRow(revision: submitted, view: olderEnd))
        rows = next
        let scroll = target.map { scrollTarget($0) } ?? pin.flatMap { pin in
            guard let index = items.firstIndex(where: { $0.identity == pin.identity }) else { return nil }
            return ListScrollTarget(index: index, identity: pin.identity, resolve: { height, _ in pin.end - height })
        }
        list.applyChanges(items: items, newSize: viewportSize, newInsets: .init(top: insets.top, bottom: insets.bottom), scrollTo: scroll,
                          anchorMode: .preserveVisibleContent, transition: animated && follow && !UIAccessibility.isReduceMotionEnabled ? .easeInOut(0.2) : .none)
    }

    private func settleCommittedUpdate() {
        guard let pending = settlement, list.items.last?.revision == pending.submission else { return }
        settlement = nil
        list.performAfterCurrentPass { [weak self] in
            guard let self, isActive, submitted == pending.submission, motion == pending.motion,
                  !list.isTracking, !list.isDragging, !list.isDecelerating else { return }
            // Tool pins commit with their collection. Following the newest
            // row is the only target settled afterward.
            if pending.follow, abs(visibleMinY) > 0.5, list.loadedItemView(at: 0) != nil {
                list.scrollTo(newestTarget(), transition: pending.animated && !UIAccessibility.isReduceMotionEnabled ? .easeInOut(0.2) : .none)
            }
        }
    }

    private func scrollTarget(_ distance: CGFloat) -> ListScrollTarget {
        let distance = min(max(0, distance), max(0, model.contentHeight + insets.top + insets.bottom - list.bounds.height))
        let index = model.firstRow(endingAfter: distance)
        if distance < model.newerEndHeight || model.count == 0 { return .init(index: 0, pointOffset: -distance) }
        if index >= model.count { return .init(index: model.count + 1, pointOffset: model.olderEndFrame.minY - distance) }
        return .init(index: index + 1, pointOffset: model.frame(ofRow: index).minY - distance)
    }

    private func newestTarget() -> ListScrollTarget {
        .init(index: 0, identity: list.items.first?.identity == "chat:newer-end" ? "chat:newer-end" : nil)
    }

    func setVisibleMinY(_ distance: CGFloat) { motion &+= 1; list.scrollTo(scrollTarget(distance), transition: .none) }
    func scrollToNewest(animated: Bool) { motion &+= 1; list.scrollTo(newestTarget(), transition: animated ? .easeInOut(0.2) : .none) }

    func deactivate() {
        isActive = false
        onScroll = nil; onAction = nil; onLink = nil; onHold = nil
        list.onScroll = nil; list.onVisibleWindowChanged = nil
        list.willBeginDragging = nil
        list.applyChanges(items: [], transition: .none)
        list.removeFromSuperview()
        rows.removeAll()
    }
}
#endif