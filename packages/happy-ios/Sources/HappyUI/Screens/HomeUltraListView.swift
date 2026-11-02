#if canImport(UIKit)
import HappyLayout
import UIKit
import UltraView

/// UltraView calls this value on its display queue. It owns no views,
/// account references or main-actor closures.
struct HomeNodeDrawing: Drawing {
    let plan: HomeRowDrawing
    func draw(in context: CGContext, bounds: CGRect) { plan.draw(in: context) }
}

@MainActor
final class HomeUltraRow: ListRow {
    let identity: String
    let revision: UInt64
    let node: NodeRow
    let plan: HomeRowDrawing
    /// The width `plan` was made at.
    let plannedWidth: CGFloat
    /// Makes the row's plan at another width, off the main thread, for a
    /// width change that lays the rows out again before home plans them.
    let replan: (@Sendable (CGFloat) -> HomeRowDrawing)?
    private let replanned = ReplannedAtWidth<HomeRowDrawing>()
    let selected: Bool
    let makeOverlay: @MainActor (HomeRowDrawing) -> UIView
    let select: (@MainActor () -> Void)?
    let longPress: (@MainActor () -> Void)?
    let archive: (@MainActor () -> Void)?
    /// The swipe leaves a task rather than archiving a session.
    let leaves: Bool
    let createWorkspace: (@MainActor () -> Void)?
    let archiveBitmap: HomeArchiveBitmap?
    let usesArchiveBitmap: Bool
    let selectsOnRelease: Bool
    var measuresAsynchronously: Bool { !usesArchiveBitmap }
    /// A home row is lines of one-line text in a box of its own height, at
    /// any width; the banner over them wraps.
    let hasFixedHeight: Bool
    var trailingSwipeActions: [ListSwipeAction] {
        guard let archive else { return [] }
        if leaves {
            return [ListSwipeAction(title: Strings.Tasks.leave, image: .icon(.ionicons("exit-outline"), size: 20), color: UIColor(Palette.statusError), isDestructive: true) { archive() }]
        }
        return [ListSwipeAction(title: Strings.SessionInfo.archiveSession, image: .icon(.ionicons("archive-outline"), size: 20), color: UIColor(Palette.statusError), isDestructive: true) { archive() }]
    }

    init(identity: String, revision: UInt64, plan: HomeRowDrawing, plannedWidth: CGFloat? = nil,
         replan: (@Sendable (CGFloat) -> HomeRowDrawing)? = nil, hasFixedHeight: Bool = true, selected: Bool = false,
         makeOverlay: @escaping @MainActor (HomeRowDrawing) -> UIView,
         select: (@MainActor () -> Void)? = nil, longPress: (@MainActor () -> Void)? = nil,
         archive: (@MainActor () -> Void)? = nil, leaves: Bool = false, createWorkspace: (@MainActor () -> Void)? = nil,
         usesArchiveBitmap: Bool = false, archiveBitmap: HomeArchiveBitmap? = nil, selectsOnRelease: Bool = false) {
        self.identity = identity; self.revision = revision; self.plan = plan; self.selected = selected
        self.makeOverlay = makeOverlay; self.select = select; self.longPress = longPress
        self.archive = archive; self.leaves = leaves; self.createWorkspace = createWorkspace
        self.usesArchiveBitmap = usesArchiveBitmap; self.archiveBitmap = archiveBitmap
        self.selectsOnRelease = selectsOnRelease
        self.plannedWidth = plannedWidth ?? plan.size.width; self.replan = replan; self.hasFixedHeight = hasFixedHeight
        node = NodeRow(identity: identity, revision: revision) { Self.root(plan) }
    }

    private nonisolated static func root(_ plan: HomeRowDrawing) -> UltraNode {
        var style = Style()
        style.height = .points(plan.size.height)
        let root = UltraNode(style: style)
        root.drawing = HomeNodeDrawing(plan: plan)
        return root
    }

    /// The plan the row shows at `width`: its own, or the one made there.
    func plan(at width: Double) -> HomeRowDrawing {
        abs(width - plannedWidth) <= 0.5 ? plan : replanned.plan(at: width) ?? plan
    }

    /// The node row at `width`: its own, or one that plans the row again
    /// there before it is measured and drawn.
    private func node(at width: Double) -> NodeRow {
        guard let replan, abs(width - plannedWidth) > 0.5 else { return node }
        let replanned = replanned
        return NodeRow(identity: identity, revision: revision) {
            let plan = replan(CGFloat(width))
            replanned.store(plan, width: width)
            return Self.root(plan)
        }
    }

    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { await node(at: width).prepare(width: width, environment: environment) }
    func prepareInPlace(width: Double, environment: RenderEnvironment) -> ListInPlacePreparation? { node(at: width).prepareInPlace(width: width, environment: environment) }
    func makeView() -> ListRowView { HomeUltraRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? HomeUltraRowView)?.apply(self, transition: transition) }
}

/// A row as its table cell shows it: the page colour, then the press fill,
/// then the drawn content and its live views. A press dims the content or
/// fills behind it (`HomeRowDrawing.Press`); it never covers it.
@MainActor
private final class HomeUltraRowView: ListRowView, UIGestureRecognizerDelegate {
    private var row: HomeUltraRow
    /// What the row shows: its plan, or the one a width change made for it
    /// (`HomeUltraRow.plan(at:)`).
    private var plan: HomeRowDrawing
    private let background = UIView()
    private let pressFill = UIView()
    /// The drawing and its overlay, dimmed together.
    private let content = UIView()
    private var drawingView: ListRowView
    private var overlayView: UIView
    private let tap = UITapGestureRecognizer()
    /// Enabled only on a row with a long press, so elsewhere a held finger
    /// still ends in a tap.
    private let long = UILongPressGestureRecognizer()
    private var pressed = false
    private var archiveTouch: (touch: UITouch, identity: String, origin: CGPoint)?
    override var isDisplayReady: Bool { drawingView.isDisplayReady }
    var identity: String { row.identity }

    /// Only mounted rows in the synchronous archive transaction take this
    /// one-shot appearance. Offscreen rows never replay it on later scrolls.
    func beginArchiveAppearance() {
        guard window != nil else { return }
        content.layer.opacity = 1
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.12; fade.toValue = 1
        fade.duration = 0.2; fade.beginTime = 0; fade.fillMode = .backwards
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        content.layer.add(fade, forKey: "home.archive.appear")
    }

    /// The list owns the departing row and its fade to zero. Its content
    /// starts a little dimmer in that same commit, then leaves with the row.
    func beginArchiveDeparture() {
        guard window != nil else { return }
        let entering = content.layer.animation(forKey: "home.archive.appear") as? CABasicAnimation
        let opacity = content.layer.presentation()?.opacity ?? (entering?.fromValue as? NSNumber)?.floatValue ?? content.layer.opacity
        content.layer.removeAnimation(forKey: "home.archive.appear")
        content.layer.opacity = opacity * 0.88
    }

    /// Home's grounds, which the sidebar leaves out.
    private static let grounds = [Palette.groupedGround, Palette.groupedBackground]

    init(row: HomeUltraRow) {
        self.row = row
        plan = row.plan
        drawingView = row.usesArchiveBitmap ? HomeArchiveBitmapView(plan: row.plan, bitmap: row.archiveBitmap) : row.node.makeView()
        overlayView = row.makeOverlay(row.plan)
        super.init(frame: .zero)
        clipsToBounds = true
        for view in [background, pressFill, content] { view.isUserInteractionEnabled = view === content; addSubview(view) }
        content.addSubview(drawingView); content.addSubview(overlayView)
        pressFill.alpha = 0
        drawingView.onDisplayReady = { [weak self] in self?.reportDisplayReady() }
        tap.addTarget(self, action: #selector(tapped)); long.addTarget(self, action: #selector(held(_:)))
        // The row hears its own touchesEnded, so the press fades as a
        // table cell's does.
        tap.cancelsTouchesInView = false
        tap.delegate = self; long.delegate = self
        addGestureRecognizer(tap); addGestureRecognizer(long)
        applyRow()
        registerForTraitChanges([SidebarColumnTrait.self]) { (self: Self, _) in self.applyRow() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func apply(_ next: HomeUltraRow, transition: ListTransition) {
        let changesDrawingKind = row.usesArchiveBitmap != next.usesArchiveBitmap
        row = next
        plan = next.plan
        if changesDrawingKind {
            drawingView.removeFromSuperview()
            drawingView = next.usesArchiveBitmap ? HomeArchiveBitmapView(plan: next.plan, bitmap: next.archiveBitmap) : next.node.makeView()
            content.insertSubview(drawingView, at: 0)
            drawingView.onDisplayReady = { [weak self] in self?.reportDisplayReady() }
        } else if let bitmap = drawingView as? HomeArchiveBitmapView {
            bitmap.apply(plan: next.plan, bitmap: next.archiveBitmap)
        } else {
            next.node.apply(to: drawingView, transition: transition)
        }
        replaceOverlay()
        applyRow(); setNeedsLayout()
    }

    private func replaceOverlay() {
        (overlayView as? HomeUltraOverlay)?.deactivate()
        overlayView.removeFromSuperview(); overlayView = row.makeOverlay(plan)
        content.addSubview(overlayView)
    }

    private func applyRow() {
        // The page, then the row's part of its card over it. As the iPad's
        // sidebar there is no page: the system's sidebar shows through.
        let page = plan.background.flatMap { traitCollection.isSidebarColumn && Self.grounds.contains($0) ? nil : $0 }
        if let card = plan.card {
            backgroundColor = page.map(plan.resolved)
            background.backgroundColor = plan.resolved(card.color)
        } else {
            backgroundColor = nil
            background.backgroundColor = page.map(plan.resolved)
        }
        for view in [background, pressFill] {
            var corners: CACornerMask = []
            if plan.card?.roundsTop == true { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
            if plan.card?.roundsBottom == true { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
            view.layer.cornerCurve = .continuous
            view.layer.cornerRadius = corners.isEmpty ? 0 : HomeCardLayout.Metrics.radius
            view.layer.maskedCorners = corners
        }
        tap.isEnabled = !row.selectsOnRelease
        if !row.selectsOnRelease || archiveTouch?.identity != row.identity { archiveTouch = nil }
        long.isEnabled = row.longPress != nil
        showPress(animated: false)
        applyAccessibility()
    }

    private func applyAccessibility() {
        isAccessibilityElement = !plan.accessibilityLabel.isEmpty
        accessibilityLabel = plan.accessibilityLabel; accessibilityValue = plan.accessibilityValue
        accessibilityTraits = plan.isHeading ? .header : row.select == nil ? .staticText : .button
        if row.selected { accessibilityTraits.insert(.selected) }
        var actions: [UIAccessibilityCustomAction] = []
        if row.longPress != nil {
            actions.append(UIAccessibilityCustomAction(name: Strings.Home.rowActions, actionHandler: { [weak self] _ in
                self?.row.longPress?(); return self?.row.longPress != nil
            }))
        }
        if row.createWorkspace != nil {
            actions.append(UIAccessibilityCustomAction(name: Strings.Home.createWorkspaceIn(plan.accessibilityLabel), actionHandler: { [weak self] _ in
                self?.row.createWorkspace?(); return self?.row.createWorkspace != nil
            }))
        }
        accessibilityCustomActions = actions
    }

    /// The table's timings: a dim flips, a fill fades up in 70ms and away
    /// over 240ms (RowHighlight).
    private func showPress(animated: Bool) {
        let press = pressed && row.select != nil ? plan.press : .none
        content.alpha = press == .dim ? 0.5 : 1
        var fill: CGFloat = 0
        if case .fill(let color) = press { pressFill.backgroundColor = plan.resolved(color); fill = 1 }
        guard pressFill.alpha != fill else { return }
        guard animated else { pressFill.layer.removeAllAnimations(); pressFill.alpha = fill; return }
        UIView.animate(withDuration: fill > 0 ? RowHighlight.fadeIn : RowHighlight.fadeOut, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.pressFill.alpha = fill
        }
    }

    private func setPressed(_ pressed: Bool, animated: Bool) {
        guard self.pressed != pressed else { return }
        self.pressed = pressed; showPress(animated: animated)
    }

    override func accessibilityActivate() -> Bool { row.select?(); return row.select != nil }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        if row.selectsOnRelease {
            let active = event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? touches.count
            guard archiveTouch == nil, active == 1, touches.count == 1, let touch = touches.first,
                  bounds.contains(touch.location(in: self)) else {
                archiveTouch = nil; setPressed(false, animated: true); return
            }
            archiveTouch = (touch, row.identity, touch.location(in: self))
        }
        setPressed(true, animated: true)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesMoved(touches, with: event)
        guard let tracked = archiveTouch, touches.contains(tracked.touch) else { return }
        let point = tracked.touch.location(in: self)
        if !bounds.contains(point) || hypot(point.x - tracked.origin.x, point.y - tracked.origin.y) > 10 {
            archiveTouch = nil; setPressed(false, animated: true)
        }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        let select: (@MainActor () -> Void)?
        if let tracked = archiveTouch, row.selectsOnRelease, tracked.identity == row.identity,
           touches.contains(tracked.touch), window != nil, bounds.contains(tracked.touch.location(in: self)),
           hypot(tracked.touch.location(in: self).x - tracked.origin.x, tracked.touch.location(in: self).y - tracked.origin.y) <= 10 {
            select = row.select
        } else { select = nil }
        archiveTouch = nil
        super.touchesEnded(touches, with: event); setPressed(false, animated: true)
        select?()
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        archiveTouch = nil
        super.touchesCancelled(touches, with: event); setPressed(false, animated: false)
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        for view in [content, drawingView, overlayView] { view.frame = bounds }
        // A card's row fills only its part of the card.
        let card = plan.card.map { CGRect(x: $0.frame.minX, y: 0, width: $0.frame.width, height: bounds.height) } ?? bounds
        for view in [background, pressFill] { view.frame = card }
    }
    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawingView.applyPreparation(preparation, width: width, environment: environment)
        // Drawn for a width change: the card, the press and the live views
        // follow the drawing in the same pass.
        let shown = row.plan(at: width)
        guard abs(shown.size.width - plan.size.width) > 0.5 else { return }
        plan = shown
        replaceOverlay()
        applyRow(); setNeedsLayout()
    }
    override func update(width: Double, transition: ListTransition) -> Double { plan.size.height }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var target = touch.view
        while let view = target, view !== self {
            if view is UIControl { return false }
            target = view.superview
        }
        return true
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
        gestureRecognizer === tap && other === long && long.isEnabled
    }
    @objc private func tapped() { row.select?() }
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        setPressed(gesture.state == .began || gesture.state == .changed, animated: true)
        if gesture.state == .began { row.longPress?() }
    }
}

@MainActor
class HomeUltraListView: UIView {
    let list = UltraListView(engineMode: .keyframe)
    init() {
        super.init(frame: .zero)
        addSubview(list); list.swipeActions.allowsFullSwipe = false
        list.accessibilityIdentifier = "home.ultralist"
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func layoutSubviews() { super.layoutSubviews(); list.frame = sidesBand }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        list.takingMargins(super.hitTest(point, with: event), of: self)
    }

    /// The width the rows are laid out at: this view less the safe area's
    /// sides, so a phone held sideways keeps them off the camera.
    var contentWidth: CGFloat { sidesBand.width }

    func apply(rows: [HomeUltraRow]? = nil, top: CGFloat, bottom: CGFloat, archiveToggle: Bool = false) {
        guard top.isFinite, bottom.isFinite else { return }
        if let rows { precondition(Set(rows.map(\.identity)).count == rows.count) }
        // A new width first, alone, so the rows on screen are laid out again
        // in place; the insets and rows follow in their own pass.
        let band = sidesBand
        list.resize(to: band)
        // Archive rows append at the tail. Start their native-style fade
        // promptly in both directions, without changing other list motion.
        let fade: ListTransition = archiveToggle ? .init(duration: 0.2, curve: .bezier(0, 0, 0.58, 1)) : .easeInOut(0.2)
        let archiveAppearance = archiveToggle && rows != nil && !UIAccessibility.isReduceMotionEnabled
        let beforeIDs = archiveAppearance ? Set(list.items.map(\.identity)) : []
        let afterIDs = archiveAppearance ? Set(rows!.map(\.identity)) : []
        let inserted = afterIDs.subtracting(beforeIDs)
        let departing = archiveAppearance ? list.loadedItemViews.compactMap { $0 as? HomeUltraRowView }.filter { !afterIDs.contains($0.identity) } : []
        // The list opens a nested transaction. Keep our content appearance
        // in its exact commit, and never touch the list-owned row opacity.
        if archiveAppearance { CATransaction.begin(); CATransaction.setDisableActions(true) }
        let beforePass = list.appliedPassCount
        list.applyChanges(items: rows, newSize: band.size, newInsets: .init(top: top, bottom: bottom), anchorMode: .preserveVisibleContent, animatesInsertions: !archiveAppearance, transition: rows == nil || UIAccessibility.isReduceMotionEnabled ? .none : fade)
        if archiveAppearance, list.appliedPassCount != beforePass {
            for case let view as HomeUltraRowView in list.loadedItemViews where inserted.contains(view.identity) { view.beginArchiveAppearance() }
            for view in departing { view.beginArchiveDeparture() }
        }
        if archiveAppearance { CATransaction.commit() }
    }

    func deactivate() { list.applyChanges(items: [], transition: .none); removeFromSuperview() }
}
#endif
