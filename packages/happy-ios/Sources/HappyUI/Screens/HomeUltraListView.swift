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
    let selected: Bool
    let makeOverlay: @MainActor () -> UIView
    let select: (@MainActor () -> Void)?
    let longPress: (@MainActor () -> Void)?
    let archive: (@MainActor () -> Void)?
    let createWorkspace: (@MainActor () -> Void)?
    var measuresAsynchronously: Bool { true }
    var trailingSwipeActions: [ListSwipeAction] {
        guard let archive else { return [] }
        return [ListSwipeAction(title: Strings.SessionInfo.archiveSession, image: .icon(.ionicons("archive-outline"), size: 20), isDestructive: true) { archive() }]
    }

    init(identity: String, revision: UInt64, plan: HomeRowDrawing, selected: Bool = false,
         makeOverlay: @escaping @MainActor () -> UIView,
         select: (@MainActor () -> Void)? = nil, longPress: (@MainActor () -> Void)? = nil,
         archive: (@MainActor () -> Void)? = nil, createWorkspace: (@MainActor () -> Void)? = nil) {
        self.identity = identity; self.revision = revision; self.plan = plan; self.selected = selected
        self.makeOverlay = makeOverlay; self.select = select; self.longPress = longPress
        self.archive = archive; self.createWorkspace = createWorkspace
        let content = HomeNodeDrawing(plan: plan)
        node = NodeRow(identity: identity, revision: revision) {
            var style = Style()
            style.height = .points(plan.size.height)
            let root = UltraNode(style: style)
            root.drawing = content
            return root
        }
    }

    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { await node.prepare(width: width, environment: environment) }
    func makeView() -> ListRowView { HomeUltraRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? HomeUltraRowView)?.apply(self, transition: transition) }
}

@MainActor
private final class HomeUltraRowView: ListRowView, UIGestureRecognizerDelegate {
    private var row: HomeUltraRow
    private let drawingView: ListRowView
    private var overlayView: UIView
    private let highlight = UIView()
    override var isDisplayReady: Bool { drawingView.isDisplayReady }

    init(row: HomeUltraRow) {
        self.row = row; drawingView = row.node.makeView(); overlayView = row.makeOverlay()
        super.init(frame: .zero)
        clipsToBounds = true
        addSubview(drawingView); addSubview(overlayView); addSubview(highlight)
        highlight.backgroundColor = UIColor(Palette.surfacePressed)
        highlight.isUserInteractionEnabled = false; highlight.alpha = 0
        drawingView.onDisplayReady = { [weak self] in self?.reportDisplayReady() }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        let long = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        tap.delegate = self; long.delegate = self; tap.require(toFail: long)
        addGestureRecognizer(tap); addGestureRecognizer(long)
        applyAccessibility()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func apply(_ next: HomeUltraRow, transition: ListTransition) {
        row = next; next.node.apply(to: drawingView, transition: transition)
        (overlayView as? HomeUltraOverlay)?.deactivate()
        overlayView.removeFromSuperview(); overlayView = next.makeOverlay()
        addSubview(overlayView); bringSubviewToFront(highlight)
        applyAccessibility(); setNeedsLayout()
    }

    private func applyAccessibility() {
        isAccessibilityElement = !row.plan.accessibilityLabel.isEmpty
        accessibilityLabel = row.plan.accessibilityLabel; accessibilityValue = row.plan.accessibilityValue
        accessibilityTraits = row.plan.isHeading ? .header : row.select == nil ? .staticText : .button
        if row.selected { accessibilityTraits.insert(.selected) }
        var actions: [UIAccessibilityCustomAction] = []
        if row.longPress != nil {
            actions.append(UIAccessibilityCustomAction(name: Strings.HomeRenderer.actions, actionHandler: { [weak self] _ in
                self?.row.longPress?(); return self?.row.longPress != nil
            }))
        }
        if row.createWorkspace != nil {
            actions.append(UIAccessibilityCustomAction(name: Strings.Home.createWorkspaceIn(row.plan.accessibilityLabel), actionHandler: { [weak self] _ in
                self?.row.createWorkspace?(); return self?.row.createWorkspace != nil
            }))
        }
        accessibilityCustomActions = actions
    }

    override func accessibilityActivate() -> Bool { row.select?(); return row.select != nil }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        if row.select != nil { highlight.alpha = 1 }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        UIView.animate(withDuration: RowHighlight.fadeOut) { self.highlight.alpha = 0 }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event); highlight.alpha = 0
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        drawingView.frame = bounds; overlayView.frame = bounds; highlight.frame = bounds
    }
    override func applyPreparation(_ preparation: ListPreparation, width: Double, environment: RenderEnvironment) {
        drawingView.applyPreparation(preparation, width: width, environment: environment)
    }
    override func update(width: Double, transition: ListTransition) -> Double { row.plan.size.height }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var target = touch.view
        while let view = target, view !== self {
            if view is UIControl { return false }
            target = view.superview
        }
        return true
    }
    @objc private func tapped() { row.select?() }
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        highlight.alpha = gesture.state == .began ? 1 : 0
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
    override func layoutSubviews() { super.layoutSubviews(); list.frame = bounds }

    func apply(rows: [HomeUltraRow]? = nil, top: CGFloat, bottom: CGFloat) {
        guard top.isFinite, bottom.isFinite else { return }
        if let rows { precondition(Set(rows.map(\.identity)).count == rows.count) }
        list.applyChanges(items: rows, newSize: bounds.size, newInsets: .init(top: top, bottom: bottom), anchorMode: .preserveVisibleContent, transition: rows == nil || UIAccessibility.isReduceMotionEnabled ? .none : .easeInOut(0.2))
    }

    func deactivate() { list.applyChanges(items: [], transition: .none); removeFromSuperview() }
}
#endif
