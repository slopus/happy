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
    /// Its words came out as they streamed (`ChatRevealDriver`): drawn by
    /// the native canvas, which the reveal masks, at `height`, which the
    /// row knows at once rather than measuring.
    let reveals: Bool
    /// The plan's height, or less while its words are coming out.
    let height: CGFloat
    /// The width `plan` was made at.
    let plannedWidth: CGFloat
    /// Plans the row again at another width, off the main thread, for a
    /// width change that lays the rows on screen out again before the
    /// pipeline plans them there.
    let replan: (@Sendable (CGFloat) -> ChatRowPlan)?
    /// An agent's reply whose words are still arriving. Arriving at the
    /// foot it is followed as growth, by the budget; a finished message
    /// comes into view whole.
    let isStreaming: Bool
    /// The person's own message, on its way, waiting or taken, or the
    /// footer under it: the newest of them, last, stays on the composer
    /// while a reply above it grows (`ChatRowPlan.mine`).
    let pinsToBottomEdge: Bool
    private let replanned = ReplannedAtWidth<ChatRowPlan>()
    weak var adapter: ChatUltraListAdapter?
    var measuresAsynchronously: Bool { !reveals }

    init(identity: String, revision: UInt64, plan: ChatRowPlan, contentY: CGFloat, adapter: ChatUltraListAdapter, preparedNode: NodeRow? = nil, reveals: Bool = false, height: CGFloat? = nil,
         plannedWidth: CGFloat? = nil, replan: (@Sendable (CGFloat) -> ChatRowPlan)? = nil, isStreaming: Bool = false, pins: Bool? = nil) {
        self.identity = identity; self.revision = revision; self.plan = plan; self.contentY = contentY; self.adapter = adapter
        self.isStreaming = isStreaming
        pinsToBottomEdge = pins ?? plan.mine
        self.reveals = reveals
        self.height = height ?? plan.size.height
        self.plannedWidth = plannedWidth ?? plan.size.width
        self.replan = replan
        usesNativeDrawing = reveals || Self.requiresNativeDrawing(plan)
        if let preparedNode { node = preparedNode; return }
        let native = usesNativeDrawing
        let dark = adapter.list.traitCollection.userInterfaceStyle == .dark
        let scale = adapter.list.traitCollection.displayScale
        node = NodeRow(identity: identity, revision: revision, measurer: adapter.measurer) {
            Self.root(plan, native: native, dark: dark, scale: scale)
        }
    }

    /// The plan's static marks, in vertical tiles. Its height is the tiles',
    /// not points of its own: a message's height follows its width, so a
    /// width change measures it again rather than keeping it in place.
    private nonisolated static func root(_ plan: ChatRowPlan, native: Bool, dark: Bool, scale: CGFloat) -> UltraNode {
        var style = Style()
        style.minHeight = .points(plan.size.height)
        style.maxHeight = .points(plan.size.height)
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

    /// The plan the row shows at `width`: its own, or the one made there.
    func plan(at width: Double) -> ChatRowPlan {
        abs(width - plannedWidth) <= 0.5 ? plan : replanned.plan(at: width) ?? plan
    }

    /// The node row at `width`: its own, or one that plans the row again
    /// there before it is measured and drawn.
    private func node(at width: Double) -> NodeRow {
        guard let replan, let adapter, !reveals, abs(width - plannedWidth) > 0.5 else { return node }
        let replanned = replanned
        let dark = adapter.list.traitCollection.userInterfaceStyle == .dark
        let scale = adapter.list.traitCollection.displayScale
        return NodeRow(identity: identity, revision: revision, measurer: adapter.measurer) {
            let plan = replan(CGFloat(width))
            replanned.store(plan, width: width)
            return Self.root(plan, native: Self.requiresNativeDrawing(plan), dark: dark, scale: scale)
        }
    }

    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { await node(at: width).prepare(width: width, environment: environment) }
    func prepareInPlace(width: Double, environment: RenderEnvironment) -> ListInPlacePreparation? { node(at: width).prepareInPlace(width: width, environment: environment) }
    func makeView() -> ListRowView { ChatUltraRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? ChatUltraRowView)?.apply(self, transition: transition) }

    nonisolated static func requiresNativeDrawing(_ plan: ChatRowPlan) -> Bool {
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
            case .spinner(let frame, _, _), .shimmer(_, let frame), .sheen(_, let frame, _), .elapsed(_, let frame, _), .diff(_, let frame, _, _, _, _),
                 .diffHeader(_, _, let frame), .scroller(_, let frame, _, _), .attachment(_, let frame),
                 .webImage(_, let frame, _), .mermaid(_, let frame), .media(_, let frame), .fileStatus(_, let frame), .embed(_, let frame), .delivery(_, let frame): live.append(frame)
            case .pulse(let box): live.append(box.frame)
            }
        }
        return false
    }
}

@MainActor
final class ChatUltraRowView: ListRowView, UIGestureRecognizerDelegate {
    private(set) var row: ChatUltraRow
    /// What the row shows: its plan, or the one a width change made for it
    /// (`ChatUltraRow.plan(at:)`).
    private(set) var plan: ChatRowPlan
    private let drawing: ListRowView
    let canvas = ChatPlanView()
    private let hold = UILongPressGestureRecognizer()
    /// Its words coming out while a reply streams.
    let reveal = ChatRevealPresenter()
    override var isDisplayReady: Bool { row.reveals || drawing.isDisplayReady }

    init(row: ChatUltraRow) {
        self.row = row
        plan = row.plan
        drawing = row.node.makeView()
        super.init(frame: .zero)
        clipsToBounds = true
        canvas.drawsStaticContent = row.usesNativeDrawing
        addSubview(drawing); addSubview(canvas)
        reveal.attach(content: canvas, host: self)
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
        plan = row.plan
        row.node.apply(to: drawing, transition: transition)
        applyCanvas()
    }

    /// Its message is lifted over the chat: the copy shows, not the row.
    var isLifted = false {
        didSet {
            drawing.isHidden = isLifted
            canvas.isHidden = isLifted
            reveal.overlay.isHidden = isLifted
        }
    }

    private func applyCanvas() {
        canvas.drawsStaticContent = plan === row.plan ? row.usesNativeDrawing : ChatUltraRow.requiresNativeDrawing(plan)
        // Words that stream are drawn off the main thread as they grow.
        canvas.drawsTextOffMain = row.reveals
        let veiled = row.adapter?.veiled == row.identity
        drawing.alpha = veiled ? 0 : plan.alpha
        canvas.veiled = veiled
        canvas.apply(plan)
        layoutCanvas()
        // In the same transaction as the plan it draws: none of its new
        // words show before they come out.
        if let state = row.adapter?.reveal.state(row.identity) { reveal.show(state.map, count: state.count) }
        else if reveal.isActive { reveal.clear() }
        canvas.onAction = { [weak self] action in
            guard let adapter = self?.row.adapter, adapter.isActive else { return }
            adapter.onAction?(action)
        }
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        accessibilityLabel = plan.accessibilityLabel
        // A long press's actions, for VoiceOver.
        let whole = plan.selection?.whole
        accessibilityCustomActions = whole.map { whole in
            [
                UIAccessibilityCustomAction(name: Strings.Chat.copy) { _ in UIPasteboard.general.string = whole; return true },
                UIAccessibilityCustomAction(name: Strings.TextSelection.title) { [weak self] _ in
                    guard let adapter = self?.row.adapter, adapter.isActive else { return false }
                    adapter.onSelectText?(whole)
                    return true
                },
            ]
        }
        isLifted = row.adapter?.liftedId == plan.id
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        drawing.frame = bounds
        layoutCanvas()
    }
    /// Shown again after a send's copy landed on it.
    func unveil() {
        drawing.alpha = plan.alpha
        canvas.veiled = false
    }
    /// The plan at its own size from the row's top: a row coming out is
    /// shorter, and clips what is still to come.
    private func layoutCanvas() {
        let frame = CGRect(x: 0, y: 0, width: bounds.width, height: max(bounds.height, plan.size.height))
        if canvas.frame != frame { canvas.frame = frame }
        reveal.layout(frame)
    }
    override func update(width: Double, transition: ListTransition) -> Double { row.height }
    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawing.applyPreparation(preparation, width: width, environment: environment)
        // Drawn for a width change: the live marks follow the drawing in
        // the same pass.
        let shown = row.plan(at: width)
        guard shown !== plan else { return }
        plan = shown
        applyCanvas()
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
        addSubview(content)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func layoutSubviews() { super.layoutSubviews(); content.frame = bounds }
    override func update(width: Double, transition: ListTransition) -> Double { ChatOlderEndLayout.height }
}

/// Bridges the shared newest-first plans to UltraList, which shows them the
/// natural way up: the older end at the top, the newest message at the foot
/// on the composer (`bottomGravity`). Logical content positions come from
/// HappyLayout, since the library retains only a window.
///
/// The list keeps the reader's place itself: away from the newest message,
/// the row under the finger, or else the top row on screen, stays where it
/// is through every update. At the newest message a reply still streaming
/// is followed by `followBudget` from its first words on, and then the list
/// holds still, leaving the rest below the fold until the reader is back at
/// the foot. A finished message arriving there comes into view whole, and a
/// send of the person's own always does (`revealNextSend`).
@MainActor
final class ChatUltraListAdapter {
    let list = UltraListView(engineMode: .keyframe)
    let measurer: any NodeRowMeasuring
    private let olderEnd: ChatOlderEndView
    private var rows: [String: ChatUltraRow] = [:]
    private var revision: UInt64 = 0
    private var model = ChatListLayout(width: 0, heights: [])
    private var hasFooter = false
    private var insets = UIEdgeInsets.zero
    private var viewportSize = CGSize.zero
    private var latest: ChatListUpdate?
    private var submitted: UInt64 = 0
    /// The person sent a message: the next update that brings a new newest
    /// row scrolls it fully into view, whatever the follow has left.
    private var revealsSend = false
    private(set) var isActive = true
    /// How far the list follows a message growing at its foot by itself
    /// (`ChatFollow.budget`).
    var followBudget: CGFloat = ChatFollow.budget(body: ChatTextStyles.markdownText, scale: .standard) {
        didSet {
            guard followBudget != oldValue else { return }
            list.bottomGravity = ListBottomGravity(followBudget: Double(followBudget))
        }
    }
    /// A send flying in from the composer: the row it waits for is
    /// veiled from the pass that inserts it until the copy lands.
    var flight: ChatSendFlight? {
        didSet {
            oldValue?.cancel()
            landing = nil
            flight?.onFinish = { [weak self, weak flight] in
                guard let self, self.flight === flight else { return }
                self.flight = nil
                self.unveil()
            }
        }
    }
    private(set) var veiled: String?
    /// The veiled row and its plan, until the list has placed it.
    private var landing: (identity: String, plan: ChatRowPlan)?
    /// A reply still arriving comes out a character at a time.
    let reveal = ChatRevealDriver()
    /// Rows whose words came out as they streamed. They stay on the native
    /// canvas: going back to a bitmap would swap their drawing on screen.
    private var revealed: Set<String> = []
    var onScroll: (() -> Void)?
    var onAction: ((ChatRowAction) -> Void)?
    var onLink: ((String) -> Void)?
    var onHold: ((ChatRowAction, UIView, CGRect, CGPoint) -> Void)?
    /// VoiceOver's Select Text on a message: its words, whole.
    var onSelectText: ((String) -> Void)?

    /// The plan whose message is lifted over the chat (`MessageLiftOverlay`):
    /// its row draws nothing meanwhile, whatever view shows it.
    var liftedId: String? {
        didSet {
            guard liftedId != oldValue else { return }
            for case let view as ChatUltraRowView in list.loadedItemViews { view.isLifted = view.row.plan.id == liftedId }
        }
    }

    /// The view plan `id` is drawn in now, in its coordinates, if on screen.
    func canvas(forPlan id: String) -> ChatPlanView? {
        list.loadedItemViews.lazy.compactMap { $0 as? ChatUltraRowView }.first { $0.row.plan.id == id }?.canvas
    }

    init(olderEnd: ChatOlderEndView, measurer: any NodeRowMeasuring = NodeRowMeasurer()) {
        self.olderEnd = olderEnd
        self.measurer = measurer
        list.bottomGravity = ListBottomGravity(followBudget: Double(followBudget))
        list.keyboardDismissMode = .interactive
        list.accessibilityIdentifier = "chat.ultralist"
        list.onScroll = { [weak self] _ in self?.onScroll?() }
        list.onVisibleWindowChanged = { [weak self] in
            self?.land()
            self?.onScroll?()
        }
        list.registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { [weak self] (_: UltraListView, _) in
            guard let self, let latest = self.latest else { return }
            self.rows.removeAll()
            self.apply(latest, animated: false)
        }
        reveal.host = self
    }

    /// How far the foot of the visible area is from the newest end: 0
    /// with the newest message on the composer. The list's own while its
    /// end is loaded, as rows laid out again at a new width hold their old
    /// starts until the new plans come; otherwise from the first row it
    /// has loaded.
    var visibleMinY: CGFloat {
        if let distance = list.distanceFromBottom { return distance }
        for index in list.loadedIndexRange {
            guard let row = list.items[index] as? ChatUltraRow, let frame = list.settledFrame(at: index) else { continue }
            return ChatListPosition.distanceFromNewest(rowStart: row.contentY, rowMaxY: frame.maxY, viewportHeight: viewportSize.height, bottomInset: insets.bottom)
        }
        return 0
    }

    /// The list follows what grows at its foot.
    var isFollowingNewest: Bool { list.isFollowingBottom }

    var isDisplayReady: Bool {
        list.items.first?.revision == submitted && !list.loadedItemViews.isEmpty && list.loadedItemViews.allSatisfy(\.isDisplayReady)
    }

    /// `keyboard` carries the keyboard's transition and whether the rows
    /// move with the inset (`ChatUltraKeyboard`). The keyboard's change
    /// with an unchanged size takes the list's inset-only pass, which keeps
    /// a transition's viewport curve.
    func setViewport(frame: CGRect, insets: UIEdgeInsets, keyboard: ChatUltraKeyboard.Change? = nil) {
        let size = frame.size
        guard size.width > 0, size.height > 0 else { return }
        let sizeChanged = viewportSize != size
        let changed = self.insets != insets || sizeChanged
        if abs(viewportSize.width - size.width) > 0.5 {
            // New insets first, at the old width, then the new width alone:
            // the rows the change puts on screen are laid out again in
            // place, where the new insets put them, on the curve of the
            // animation it is in.
            if self.insets != insets {
                self.insets = insets
                // A new size keeps the row read at the top where it is,
                // not the distance from the composer.
                list.applyChanges(newInsets: .init(top: insets.top, bottom: insets.bottom), anchorMode: .preserveVisibleContent,
                                  compensatesInsetChange: keyboard?.compensates ?? false, transition: keyboard?.transition ?? .none)
            }
            list.resize(to: frame)
            viewportSize = size
            flight?.follow(in: list)
            return
        }
        self.insets = insets
        viewportSize = size
        if list.frame.origin != frame.origin { list.frame.origin = frame.origin }
        guard changed else {
            if keyboard?.finishes == true { list.finishViewportTransition() }
            return
        }
        list.applyChanges(newSize: keyboard == nil || sizeChanged ? size : nil, newInsets: .init(top: insets.top, bottom: insets.bottom), anchorMode: .preserveVisibleContent,
                          compensatesInsetChange: keyboard?.compensates ?? !list.isTracking, transition: keyboard?.transition ?? .none)
        flight?.follow(in: list)
    }

    func apply(_ update: ChatListUpdate, animated: Bool) {
        if isActive { startReveals(update) }
        submit(update, transition: animated ? .easeInOut(0.2) : .none, followOnly: true)
    }

    /// Only the newest row comes out as it streams, and only with words
    /// that arrive while the chat is on screen; any other finishes coming
    /// out (`RevealFocus`).
    private func startReveals(_ update: ChatListUpdate) {
        var focus: [RevealFocus.Row] = []
        focus.reserveCapacity(update.plans.count)
        // Newest first: the focus reads them oldest first.
        for plan in update.plans.reversed() {
            let identity = "chat:message:\(plan.id)"
            focus.append(.init(id: identity, revealable: plan.revealable, change: ChatRevealMapping.change(from: rows[identity]?.plan, to: plan)))
        }
        let steps = reveal.focus(focus, streaming: update.streaming, onScreen: list.window != nil)
        // The rows revealing are at the newest end, where the search starts.
        let plans = update.plans
        func plan(_ identity: String) -> ChatRowPlan? {
            let id = identity.dropFirst("chat:message:".count)
            return plans.first { $0.revealable && $0.id == id }
        }
        revealed.formUnion(reveal.perform(steps, plan: plan, previous: { [rows] in rows[$0]?.plan }))
        reveal.keep { plan($0) != nil }
    }

    private func submit(_ update: ChatListUpdate, transition: ListTransition, followOnly: Bool) {
        latest = update
        submitted &+= 1
        // A row the reader opened or closed grows or shrinks under their
        // finger: the rows above it hold still, not the newest message.
        if update.pinning != nil { list.stopFollowingBottom() }
        let follow = list.isFollowingBottom
        model = update.model
        hasFooter = update.footer != nil
        var next: [String: ChatUltraRow] = [:]
        // What moves: a row's height or the rows there are, and of that, a
        // revealing row growing a line.
        var moved = false
        var grew = false
        let plannedWidth = update.model.width
        func descriptor(_ plan: ChatRowPlan, identity: String, y: CGFloat, input: ChatRowInput? = nil, replan: (@Sendable (CGFloat) -> ChatRowPlan)? = nil, pins: Bool? = nil) -> ChatUltraRow {
            let pins = pins ?? plan.mine
            let reveals = revealed.contains(identity)
            let revealing = reveal.height(identity)
            let height = revealing ?? plan.size.height
            if let kept = rows[identity], kept.height != height {
                if revealing != nil { grew = true } else { moved = true }
            }
            if let cached = rows[identity], cached.plan === plan, cached.reveals == reveals, cached.height == height {
                let row = cached.contentY == y && cached.pinsToBottomEdge == pins ? cached : ChatUltraRow(identity: identity, revision: cached.revision, plan: plan, contentY: y, adapter: self, preparedNode: cached.node, reveals: reveals, height: height, plannedWidth: cached.plannedWidth, replan: cached.replan, isStreaming: cached.isStreaming, pins: pins)
                next[identity] = row; return row
            }
            // The revision is never reused, even after removing an identity.
            revision &+= 1
            let replan = replan ?? input.map { input -> @Sendable (CGFloat) -> ChatRowPlan in { ChatRowRenderer.plan(input, width: $0) } }
            let row = ChatUltraRow(identity: identity, revision: revision, plan: plan, contentY: y, adapter: self, reveals: reveals, height: height, plannedWidth: plannedWidth, replan: replan,
                                   isStreaming: identity == streamingIdentity, pins: pins)
            next[identity] = row
            return row
        }
        // Worked out newest first, as the plans come, then turned the
        // natural way up: the older end, the oldest row … the newest, the
        // footer.
        // The agent at work and its newest message its words: they stream.
        let streamingIdentity = update.streaming ? update.plans.first.flatMap { $0.revealable ? "chat:message:\($0.id)" : nil } : nil
        var newestFirst: [any ListRow] = []
        newestFirst.reserveCapacity(update.plans.count + 2)
        // The footer under the person's own newest message keeps it on the
        // composer for it, as the last row.
        if let footer = update.footer {
            newestFirst.append(descriptor(footer, identity: "chat:newer-end", y: 0, replan: update.footerReplan, pins: update.plans.first?.mine == true))
        }
        if landing == nil, let flight, let plan = update.plans.first, rows["chat:message:\(plan.id)"] == nil, flight.awaits(plan) {
            landing = ("chat:message:\(plan.id)", plan)
            veiled = "chat:message:\(plan.id)"
        }
        let lands = landing.map { landing in rows[landing.identity] == nil } ?? false
        // A send of the person's own, once its row is in, comes fully into view.
        let newestIdentity = update.plans.first.map { "chat:message:\($0.id)" }
        let reveals = revealsSend && newestIdentity.map { rows[$0] == nil } == true
        if reveals { revealsSend = false }
        // What revealing rows still hold back, newer than each row.
        var held: CGFloat = 0
        for (index, plan) in update.plans.enumerated() {
            let identity = "chat:message:\(plan.id)"
            let input = update.inputs.indices.contains(index) && update.inputs[index].id == plan.id ? update.inputs[index] : nil
            let row = descriptor(plan, identity: identity, y: update.model.frame(ofRow: index).minY - held, input: input)
            held += plan.size.height - row.height
            newestFirst.append(row)
        }
        newestFirst.append(ChatOlderUltraRow(revision: submitted, view: olderEnd))
        let items = Array(newestFirst.reversed())
        if list.items.count != items.count || zip(list.items, items).contains(where: { $0.identity != $1.identity }) { moved = true }
        rows = next
        // The chat opens on its newest message.
        let scroll: ListScrollTarget? = reveals || list.items.isEmpty ? .bottom : nil
        let eased: ListTransition = if lands && (follow || reveals) {
            // The rows above make room as the send flies in.
            ChatSendFlight.Motion.list
        } else {
            follow || reveals || !followOnly ? transition : .none
        }
        list.applyChanges(items: items, newSize: viewportSize, newInsets: .init(top: insets.top, bottom: insets.bottom), scrollTo: scroll,
                          anchorMode: .preserveVisibleContent, transition: AgentChatUltraList.transition(eased, moved: moved, grew: grew))
        if lands { list.performAfterCurrentPass { [weak self] in self?.land() } }
    }

    /// Flies the send in over its row once the list placed it: a row is
    /// measured off the main thread, so it may be a pass or two later.
    private func land() {
        guard let landing, let flight, veiled == landing.identity,
              let index = list.items.firstIndex(where: { $0.identity == landing.identity }),
              list.settledFrame(at: index) != nil,
              let view = list.loadedItemView(at: index) as? ChatUltraRowView else { return }
        self.landing = nil
        flight.land(on: view, plan: landing.plan, drawn: { [weak view] in view.map { $0.isDisplayReady && $0.canvas.isDrawn } ?? true },
                    reveal: { [weak self] in self?.unveil() })
    }

    private func unveil() {
        guard let identity = veiled else { return }
        veiled = nil
        landing = nil
        guard let index = list.items.firstIndex(where: { $0.identity == identity }) else { return }
        (list.loadedItemView(at: index) as? ChatUltraRowView)?.unveil()
    }

    /// The target that puts the foot of the visible area `distance` from
    /// the newest end, by the row there (`ChatListPosition.rowTop`).
    private func scrollTarget(_ distance: CGFloat) -> ListScrollTarget {
        let visible = viewportSize.height - insets.top - insets.bottom
        let distance = min(max(0, distance), max(0, model.contentHeight - visible))
        // The rows stand oldest first, under the older end.
        let count = model.count
        func top(_ frame: CGRect) -> Double { Double(ChatListPosition.rowTop(rowStart: frame.minY, rowHeight: frame.height, distance: distance, visibleHeight: visible)) }
        if count == 0 || (distance < model.newerEndHeight && hasFooter) {
            if hasFooter { return .init(index: count + 1, pointOffset: top(model.newerEndFrame)) }
            return .init(index: 0, pointOffset: top(model.olderEndFrame))
        }
        let index = min(model.firstRow(endingAfter: distance), count)
        if index == count { return .init(index: 0, pointOffset: top(model.olderEndFrame)) }
        return .init(index: count - index, pointOffset: top(model.frame(ofRow: index)))
    }

    func setVisibleMinY(_ distance: CGFloat) { list.scrollTo(scrollTarget(distance), transition: .none) }

    /// Back to the newest message, following it again from there.
    func scrollToNewest(animated: Bool) {
        list.scrollToBottom(animated: animated && !UIAccessibility.isReduceMotionEnabled)
    }

    /// The person sent a message: back to the newest message now, and the
    /// row it brings brought fully into view when it comes.
    func revealNextSend() {
        revealsSend = true
        scrollToNewest(animated: true)
    }

    func deactivate() {
        flight = nil
        isActive = false
        reveal.stopAll()
        onScroll = nil; onAction = nil; onLink = nil; onHold = nil; onSelectText = nil
        list.onScroll = nil; list.onVisibleWindowChanged = nil
        list.applyChanges(items: [], transition: .none)
        list.removeFromSuperview()
        rows.removeAll()
    }
}

extension ChatUltraListAdapter: ChatRevealHost {
    func revealPresenter(_ identity: String) -> ChatRevealPresenter? {
        guard let index = list.items.firstIndex(where: { $0.identity == identity }) else { return nil }
        return (list.loadedItemView(at: index) as? ChatUltraRowView)?.reveal
    }

    /// A reply came onto a new line: the row grows on Telegram's 0.15 s,
    /// followed while the list follows the newest message, below the fold
    /// once it has stopped.
    func revealHeightsChanged() {
        guard isActive, let latest else { return }
        submit(latest, transition: .easeInOut(StreamingRevealMotion.heightDuration), followOnly: false)
    }
}
#endif