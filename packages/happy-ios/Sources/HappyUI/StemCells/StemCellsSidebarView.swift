#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One action behind a row swiped open.
struct StemCellsSwipeAction {
    var title: String
    var destructive: Bool
    var identifier: String
    var handler: () -> Void
}

/// The Stem Cells sidebar as one scrolling column. Rows are views keyed by
/// their ID: a row that did not change is not touched, a changed one is
/// reconfigured in place, and a fold only moves the rows after it. Nothing
/// here ever resets the scroll position.
///
/// Three gestures share a row, as iOS shares them: a hold lifts it with its
/// menu; moving while held drops the menu and carries the row (its peers
/// glide aside, the list scrolls at its edges, and a drop lands where the
/// gap is); a sideways pull uncovers its actions. A row's title can turn
/// into a field in place to be renamed.
final class StemCellsSidebarView: UIScrollView, UIContextMenuInteractionDelegate {
    var onSelect: ((StemCellsRow) -> Void)?
    var onFold: ((StemCellsRow) -> Void)?
    var menu: ((StemCellsRow) -> UIMenu?)?
    var swipeActions: ((StemCellsRow) -> [StemCellsSwipeAction])?
    /// A carry for a row, when it can be carried.
    var beginDrag: ((StemCellsRow) -> StemCellsDrag?)?
    /// A carry starts or ends (the document holds still while one is on).
    var onDragging: ((Bool) -> Void)?
    /// Set down in slot `to`.
    var onDrop: ((StemCellsDrag, Int) -> Void)?
    var images: StemCellsImages?

    /// The row whose conversation is open, which stays selected.
    var selectedRowId: String? {
        didSet {
            guard selectedRowId != oldValue else { return }
            for (id, view) in views { view.selected = id == selectedRowId }
        }
    }

    private(set) var rows: [StemCellsRow] = []
    private var views: [String: StemCellsRowView] = [:]
    private let connectors = CAShapeLayer()
    private var laidOut: (width: CGFloat, rows: [StemCellsSidebarLayout.Row])?
    private(set) var layoutResult: StemCellsSidebarLayout.Result?
    /// The order shown while a carry is on, and after a drop until the
    /// document says the same.
    private var arranged: [StemCellsRow]?
    private var arrangedUntil: Task<Void, Never>?
    private var carry: Carry?
    /// A drop's preview is still flying to its slot.
    private var landing = false
    /// A menu action waiting for the menu to close (a rename needs the keyboard).
    private var afterMenu: (() -> Void)?
    private var swiped: (id: String, view: StemCellsSwipeActionsView)?
    /// How far open the pulled row was when the pull began.
    private var pullBase: CGFloat = 0
    private var editing: (id: String, commit: (String) -> Void)?
    private lazy var pulls = PullDelegate(sidebar: self)

    private struct Carry {
        var drag: StemCellsDrag
        /// Where the hand began, in content coordinates.
        var start: CGPoint
        /// Where the hand is, in this view's frame (so a scroll moves it through the content).
        var hand: CGPoint
        var to: Int
        var heights: [Double]
        var link: CADisplayLink?
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        alwaysBounceVertical = true
        delaysContentTouches = true
        contentInsetAdjustmentBehavior = .never
        connectors.fillColor = UIColor(Palette.stemCellsRowText).withAlphaComponent(StemCellsMetrics.connectorAlpha).cgColor
        layer.addSublayer(connectors)
        addInteraction(UIContextMenuInteraction(delegate: self))
        let drag = UIDragInteraction(delegate: self)
        drag.isEnabled = true
        addInteraction(drag)
        addInteraction(UIDropInteraction(delegate: self))
        let away = UITapGestureRecognizer(target: self, action: #selector(tappedAway(_:)))
        away.cancelsTouchesInView = false
        away.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(away)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.connectors.fillColor = UIColor(Palette.stemCellsRowText).withAlphaComponent(StemCellsMetrics.connectorAlpha).resolvedColor(with: self.traitCollection).cgColor
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func touchesShouldCancel(in view: UIView) -> Bool { true }

    /// Shows `rows`, touching only the rows that changed. Returns how many it touched.
    @discardableResult
    func apply(_ rows: [StemCellsRow]) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        let previous = Dictionary(self.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.rows = rows
        settleIfCaughtUp()
        var touched = 0
        var live = Set<String>()
        for row in rows {
            live.insert(row.id)
            let view: StemCellsRowView
            if let existing = views[row.id] {
                view = existing
                if previous[row.id] == row { continue }
            } else {
                view = makeRow()
                views[row.id] = view
            }
            view.configure(row)
            // Rows a tap doesn't open (a proposal's) read as what they are.
            if onSelect == nil, row.kind != .section, row.kind != .separator { view.accessibilityTraits = .staticText }
            view.selected = row.id == selectedRowId
            touched += 1
        }
        for (id, view) in views where !live.contains(id) {
            view.removeFromSuperview()
            views.removeValue(forKey: id)
            if swiped?.id == id { closeSwipe(animated: false) }
            if editing?.id == id { editing = nil }
            touched += 1
        }
        setNeedsLayout()
        return touched
    }

    private func makeRow() -> StemCellsRowView {
        let view = StemCellsRowView()
        view.images = images
        addSubview(view)
        let tap = UITapGestureRecognizer(target: self, action: #selector(rowTapped(_:)))
        view.addGestureRecognizer(tap)
        let press = PressRecognizer(target: self, action: #selector(rowPressed(_:)))
        press.delegate = PressRecognizer.simultaneous
        view.addGestureRecognizer(press)
        let pull = UIPanGestureRecognizer(target: self, action: #selector(rowPulled(_:)))
        pull.delegate = pulls
        view.addGestureRecognizer(pull)
        return view
    }

    @objc private func rowTapped(_ gesture: UITapGestureRecognizer) {
        guard let view = gesture.view as? StemCellsRowView, let row = view.row else { return }
        // A tap while something is open closes it and does nothing else; a
        // tap in the title being edited is the field's.
        if editing != nil || swiped != nil {
            if let id = editing?.id, id != row.id { finishRename() }
            closeSwipe(animated: true)
            return
        }
        switch row.kind {
        case .section: onFold?(row)
        case .separator: break
        default: onSelect?(row)
        }
    }

    @objc private func tappedAway(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        // A row's own tap closes what is open, and only that.
        guard row(at: point) == nil else { return }
        if editing != nil { finishRename() }
        if let swiped, !swiped.view.frame.contains(point) { closeSwipe(animated: true) }
    }

    @objc private func rowPressed(_ gesture: PressRecognizer) {
        guard let view = gesture.view as? StemCellsRowView else { return }
        let opens = onSelect != nil || view.row?.kind == .section
        view.pressed = opens && (gesture.state == .began || gesture.state == .changed) && swiped == nil
    }

    nonisolated static func layoutRows(_ rows: [StemCellsRow]) -> [StemCellsSidebarLayout.Row] {
        rows.map { row in
            let kind: StemCellsSidebarLayout.Kind = switch row.kind {
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            default: .row
            }
            return StemCellsSidebarLayout.Row(kind: kind, depth: row.depth, hasMark: row.mark != .none, hasTrailing: row.status == .waiting || row.status == .awaitingInput || row.unread)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let shown = arranged ?? rows
        let input = Self.layoutRows(shown)
        let width = bounds.width
        if laidOut?.width != width || laidOut?.rows != input || layoutResult?.frames.count != shown.count {
            place(shown, animated: false)
        }
    }

    /// Lays `shown` out and moves each row to its place, gliding when asked.
    private func place(_ shown: [StemCellsRow], animated: Bool) {
        let input = Self.layoutRows(shown)
        let result = StemCellsSidebarLayout.layout(input, width: bounds.width)
        layoutResult = result
        laidOut = (bounds.width, input)
        let move = {
            for (row, frame) in zip(shown, result.frames) {
                guard let view = self.views[row.id] else { continue }
                // By bounds and centre: a row pulled open wears a transform.
                view.bounds = CGRect(origin: .zero, size: frame.box.size)
                view.center = CGPoint(x: frame.box.midX, y: frame.box.midY)
                view.frames = frame
                view.layoutIfNeeded()
            }
        }
        if animated {
            // Desktop's rows glide on `top` over 160ms.
            UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: move)
        } else {
            UIView.performWithoutAnimation(move)
        }
        if let swiped, let box = zip(shown, result.frames).first(where: { $0.0.id == swiped.id })?.1.box { swiped.view.frame = box }
        let path = CGMutablePath()
        for line in result.connectors { path.addRect(line) }
        CATransaction.begin(); CATransaction.setDisableActions(!animated)
        connectors.path = path
        CATransaction.commit()
        let size = CGSize(width: bounds.width, height: result.contentHeight)
        if contentSize != size { contentSize = size }
    }

    func view(for rowId: String) -> StemCellsRowView? { views[rowId] }

    private func row(at point: CGPoint) -> StemCellsRowView? {
        for view in views.values where view.frame.contains(point) { return view }
        return nil
    }

    // MARK: Menus

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard editing == nil, let view = row(at: location), let row = view.row, let menu = menu?(row) else { return nil }
        // Warmed as the hold begins: a carry may follow at once.
        StemCellsHaptics.prepare(.lift)
        StemCellsHaptics.prepare(.slot)
        closeSwipe(animated: true)
        return UIContextMenuConfiguration(identifier: row.id as NSString, previewProvider: nil) { _ in menu }
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        guard let id = identifier as? String, let view = views[id] else { return nil }
        let parameters = UIPreviewParameters()
        parameters.visiblePath = UIBezierPath(roundedRect: view.bounds, cornerRadius: StemCellsMetrics.cornerRadius)
        parameters.backgroundColor = UIColor(Palette.stemCellsBackground)
        return UITargetedPreview(view: view, parameters: parameters)
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        guard let animator else { return }
        animator.addCompletion { [weak self] in
            let next = self?.afterMenu
            self?.afterMenu = nil
            next?()
        }
    }

    /// Runs `work` once the open menu has gone, or now when none is open.
    func afterMenuCloses(_ work: @escaping () -> Void) {
        afterMenu = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, let next = afterMenu else { return }
            afterMenu = nil
            next()
        }
    }

    // MARK: Rename in place

    /// Turns `rowId`'s title into a field holding `text`, selected, with the
    /// keyboard up. Return or a tap elsewhere keeps it; Escape keeps the old one.
    func beginRename(_ rowId: String, text: String, commit: @escaping (String) -> Void) {
        beginRename(rowId, text: text, retries: 1, commit: commit)
    }

    private func beginRename(_ rowId: String, text: String, retries: Int, commit: @escaping (String) -> Void) {
        guard let view = views[rowId] else { return }
        closeSwipe(animated: true)
        if editing != nil { finishRename() }
        editing = (rowId, commit)
        scrollRectToVisible(view.frame.insetBy(dx: 0, dy: -24), animated: true)
        let began = view.beginEditing(text) { [weak self, weak view] result in
            guard let self, editing?.id == rowId else { return }
            let commit = editing?.commit
            editing = nil
            guard let result else { return }
            let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != text else { return }
            StemCellsHaptics.play(.renamed)
            view?.holdLabel(trimmed)
            commit?(trimmed)
        }
        guard !began else { return }
        // The keyboard wasn't to be had (a menu still leaving): once more, a moment on.
        editing = nil
        guard retries > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.beginRename(rowId, text: text, retries: retries - 1, commit: commit)
        }
    }

    /// Keeps what the field holds, and lets go of it however it stands.
    private func finishRename() {
        guard let id = editing?.id else { return }
        views[id]?.commitEditing()
        // A row that had no field (or is gone) can't say so.
        if editing?.id == id { editing = nil }
    }

    // MARK: Swipe

    @objc private func rowPulled(_ gesture: UIPanGestureRecognizer) {
        guard let view = gesture.view as? StemCellsRowView, let row = view.row else { return }
        if gesture.state == .began {
            if let swiped, swiped.id != row.id { closeSwipe(animated: true) }
            // Pulled again while open: from open, else from closed.
            pullBase = swiped?.id == row.id ? swiped?.view.openWidth ?? 0 : 0
        }
        let pull = -gesture.translation(in: self).x + pullBase
        switch gesture.state {
        case .began:
            if swiped == nil {
                let actions = swipeActions?(row) ?? []
                guard !actions.isEmpty else { gesture.state = .cancelled; return }
                let behind = StemCellsSwipeActionsView(actions: actions) { [weak self] in self?.closeSwipe(animated: true) }
                behind.frame = view.frames?.box ?? view.frame
                insertSubview(behind, belowSubview: view)
                swiped = (row.id, behind)
            }
            view.pressed = false
            view.swiping = true
            StemCellsHaptics.prepare(.swipeThreshold)
            if let behind = swiped?.view { behind.wouldOpen = pull >= behind.openWidth * StemCellsSwipeLayout.opensAt }
        case .changed:
            if let behind = swiped?.view {
                // A tick where letting go starts to open them, either way across.
                let opens = pull >= behind.openWidth * StemCellsSwipeLayout.opensAt
                if opens != behind.wouldOpen {
                    behind.wouldOpen = opens
                    StemCellsHaptics.play(.swipeThreshold)
                }
                behind.pull(pull, row: view)
            }
        case .ended, .cancelled, .failed:
            guard let swiped else { return }
            let opens = gesture.state == .ended && StemCellsSwipeLayout.opens(pull: pull, velocity: -gesture.velocity(in: self).x, actions: swiped.view.count)
            if opens {
                UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0) {
                    swiped.view.pull(swiped.view.openWidth, row: view)
                }
            } else {
                closeSwipe(animated: true)
            }
        default:
            break
        }
    }

    func closeSwipe(animated: Bool) {
        guard let swiped else { return }
        self.swiped = nil
        let view = views[swiped.id]
        let close = { swiped.view.pull(0, row: view) }
        let done = { (_: Bool) in
            swiped.view.removeFromSuperview()
            // Unless pulled again while it closed.
            if self.swiped?.id != swiped.id { view?.swiping = false }
        }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: close, completion: done)
        } else {
            close(); done(true)
        }
    }

    // MARK: Carry

    private func heights(_ drag: StemCellsDrag, frames: [StemCellsSidebarLayout.Frame]) -> [Double] {
        drag.units.map { unit in
            Double(frames[unit.last!].box.maxY - frames[unit.first!].box.minY + StemCellsMetrics.rowGap)
        }
    }

    /// The drawn order's frames for the carried rows, and their union.
    private func heldFrame(order: [StemCellsRow], held: [StemCellsRow]) -> CGRect {
        let result = StemCellsSidebarLayout.layout(Self.layoutRows(order), width: bounds.width)
        let ids = Set(held.map(\.id))
        return zip(order, result.frames).reduce(CGRect.null) { union, pair in ids.contains(pair.0.id) ? union.union(pair.1.box) : union }
    }

    private func updateCarry() {
        guard var carry else { return }
        let content = CGPoint(x: carry.hand.x + contentOffset.x - frame.minX, y: carry.hand.y + contentOffset.y - frame.minY)
        let to = carry.drag.target(deltaY: Double(content.y - carry.start.y), heights: carry.heights)
        guard to != carry.to else { return }
        carry.to = to
        self.carry = carry
        let order = carry.drag.order(to: to)
        arranged = order
        place(order, animated: true)
        StemCellsHaptics.play(.slot)
    }

    /// Scrolls while the hand is near an edge: faster the closer it is.
    @objc private func autoscroll(_ link: CADisplayLink) {
        guard let carry else { return }
        let y = carry.hand.y - frame.minY
        let top = contentInset.top + 56
        let bottom = bounds.height - contentInset.bottom - 56
        var speed: CGFloat = 0
        if y < top { speed = -min(1, (top - y) / 56) * 14 }
        if y > bottom { speed = min(1, (y - bottom) / 56) * 14 }
        guard speed != 0 else { return }
        let minY = -contentInset.top
        let maxY = max(minY, contentSize.height + contentInset.bottom - bounds.height)
        let next = min(maxY, max(minY, contentOffset.y + speed))
        guard next != contentOffset.y else { return }
        contentOffset.y = next
        updateCarry()
    }

    private func endCarry() {
        carry?.link?.invalidate()
        carry = nil
        onDragging?(false)
    }

    /// Back to the document's order. The carried rows stay hidden while a
    /// preview is still flying to them (`revealing` false).
    private func settle(revealing: Bool = true) {
        arrangedUntil?.cancel()
        arrangedUntil = nil
        arranged = nil
        if revealing { for view in views.values { view.isHidden = false } }
        laidOut = nil
        setNeedsLayout()
    }

    /// Settles once nothing is carried or landing and the document shows
    /// the order dropped (or, dropped where it was, never changed).
    private func settleIfCaughtUp() {
        guard carry?.link == nil, !landing, let arranged, arranged.map(\.id) == rows.map(\.id) else { return }
        settle()
    }

    /// A drop's preview reached its slot: the rows show again.
    private func landed() {
        guard landing else { return }
        landing = false
        for view in views.values { view.isHidden = false }
        settleIfCaughtUp()
    }
}

extension StemCellsSidebarView {
    /// A row's sideways pull.
    final class PullDelegate: NSObject, UIGestureRecognizerDelegate {
        weak var sidebar: StemCellsSidebarView?
        init(sidebar: StemCellsSidebarView) { self.sidebar = sidebar }
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer else { return false }
            return sidebar?.pullShouldBegin(pan) ?? false
        }
    }

    /// A pull is sideways, leftward to open or either way once open.
    fileprivate func pullShouldBegin(_ pan: UIPanGestureRecognizer) -> Bool {
        guard editing == nil, carry?.link == nil, let view = pan.view as? StemCellsRowView, let row = view.row else { return false }
        let velocity = pan.velocity(in: self)
        guard abs(velocity.x) > abs(velocity.y) * 1.5 else { return false }
        if swiped?.id == row.id { return true }
        // Happy's row has nothing behind it: the pull is never taken from the scroll.
        return velocity.x < 0 && !(swipeActions?(row) ?? []).isEmpty
    }
}

extension StemCellsSidebarView: UIDragInteractionDelegate {
    func dragInteraction(_ interaction: UIDragInteraction, itemsForBeginning session: any UIDragSession) -> [UIDragItem] {
        let point = session.location(in: self)
        // Asked at the lift, which may only ever show the menu: a carry not
        // yet under way is replaced.
        guard carry?.link == nil, editing == nil, let view = row(at: point), let row = view.row,
              let drag = beginDrag?(row) else { return [] }
        // The carry's indices are the document's drawn rows: measured on
        // those, never on an order still held from a drop.
        let frames = StemCellsSidebarLayout.layout(Self.layoutRows(rows), width: bounds.width).frames
        guard arranged == nil, let last = drag.units.last?.last, last < frames.count else { return [] }
        closeSwipe(animated: false)
        carry = Carry(drag: drag, start: point, hand: convert(point, to: superview), to: drag.from, heights: heights(drag, frames: frames))
        let item = UIDragItem(itemProvider: NSItemProvider())
        item.localObject = row.id
        return [item]
    }

    func dragInteraction(_ interaction: UIDragInteraction, previewForLifting item: UIDragItem, session: any UIDragSession) -> UITargetedDragPreview? {
        guard let carry else { return nil }
        let rect = heldFrame(order: rows, held: carry.drag.held)
        guard !rect.isNull, let snapshot = resizableSnapshotView(from: rect, afterScreenUpdates: false, withCapInsets: .zero) else { return nil }
        let card = UIView(frame: CGRect(origin: .zero, size: rect.size))
        card.backgroundColor = UIColor(Palette.stemCellsBackground)
        card.layer.cornerRadius = StemCellsMetrics.cornerRadius
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        snapshot.frame = card.bounds
        card.addSubview(snapshot)
        let parameters = UIDragPreviewParameters()
        parameters.visiblePath = UIBezierPath(roundedRect: card.bounds, cornerRadius: StemCellsMetrics.cornerRadius)
        return UITargetedDragPreview(view: card, parameters: parameters, target: UIDragPreviewTarget(container: self, center: CGPoint(x: rect.midX, y: rect.midY)))
    }

    func dragInteraction(_ interaction: UIDragInteraction, sessionWillBegin session: any UIDragSession) {
        guard var carry else { return }
        onDragging?(true)
        StemCellsHaptics.play(.lift)
        // The carried rows leave their slot; the gap is where they'll land.
        for row in carry.drag.held { views[row.id]?.isHidden = true }
        arrangedUntil?.cancel()
        arranged = carry.drag.order(to: carry.to)
        let link = CADisplayLink(target: self, selector: #selector(autoscroll(_:)))
        link.add(to: .main, forMode: .common)
        carry.link = link
        self.carry = carry
    }

    func dragInteraction(_ interaction: UIDragInteraction, sessionIsRestrictedToDraggingApplication session: any UIDragSession) -> Bool { true }
    func dragInteraction(_ interaction: UIDragInteraction, sessionAllowsMoveOperation session: any UIDragSession) -> Bool { true }

    func dragInteraction(_ interaction: UIDragInteraction, session: any UIDragSession, willEndWith operation: UIDropOperation) {
        // Let go outside the list: the peers glide back as the row flies home.
        guard carry?.link != nil, operation != .move else { return }
        endCarry()
        UIView.animate(withDuration: 0.16) { self.settle(revealing: false); self.layoutIfNeeded() }
    }

    func dragInteraction(_ interaction: UIDragInteraction, session: any UIDragSession, didEndWith operation: UIDropOperation) {
        // Whatever the previews did, nothing stays hidden or carried.
        if carry?.link != nil { endCarry(); settle() }
        landed()
        for view in views.values { view.isHidden = false }
    }

    func dragInteraction(_ interaction: UIDragInteraction, item: UIDragItem, willAnimateCancelWith animator: any UIDragAnimating) {
        animator.addCompletion { [weak self] _ in
            guard let self else { return }
            for view in views.values { view.isHidden = false }
        }
    }

    func dragInteraction(_ interaction: UIDragInteraction, previewForCancelling item: UIDragItem, withDefault defaultPreview: UITargetedDragPreview) -> UITargetedDragPreview? {
        guard let carry else { return defaultPreview }
        let rect = heldFrame(order: rows, held: carry.drag.held)
        return defaultPreview.retargetedPreview(with: UIDragPreviewTarget(container: self, center: CGPoint(x: rect.midX, y: rect.midY)))
    }
}

extension StemCellsSidebarView: UIDropInteractionDelegate {
    func dropInteraction(_ interaction: UIDropInteraction, canHandle session: any UIDropSession) -> Bool {
        session.localDragSession != nil && carry != nil
    }

    func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: any UIDropSession) -> UIDropProposal {
        guard carry != nil else { return UIDropProposal(operation: .cancel) }
        carry?.hand = superview.map { session.location(in: $0) } ?? session.location(in: self)
        updateCarry()
        return UIDropProposal(operation: .move)
    }

    func dropInteraction(_ interaction: UIDropInteraction, performDrop session: any UIDropSession) {
        guard let carry else { return }
        let drag = carry.drag
        let to = carry.to
        // Held as dropped until the document says the same.
        arranged = drag.order(to: to)
        arrangedUntil?.cancel()
        arrangedUntil = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.settle()
        }
        // Shown again once the preview lands (`landed`), not when the store answers.
        landing = true
        StemCellsHaptics.play(.drop)
        onDrop?(drag, to)
        endCarry()
    }

    func dropInteraction(_ interaction: UIDropInteraction, previewForDropping item: UIDragItem, withDefault defaultPreview: UITargetedDragPreview) -> UITargetedDragPreview? {
        guard let arranged, let id = item.localObject as? String, let held = rowsHeld(id, in: arranged) else { return nil }
        let rect = heldFrame(order: arranged, held: held)
        return defaultPreview.retargetedPreview(with: UIDragPreviewTarget(container: self, center: CGPoint(x: rect.midX, y: rect.midY)))
    }

    func dropInteraction(_ interaction: UIDropInteraction, item: UIDragItem, willAnimateDropWith animator: any UIDragAnimating) {
        animator.addCompletion { [weak self] _ in self?.landed() }
    }

    func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: any UIDropSession) {
        carry?.hand = superview.map { session.location(in: $0) } ?? session.location(in: self)
    }

    /// The carried row and what came with it, from the row's ID.
    private func rowsHeld(_ id: String, in order: [StemCellsRow]) -> [StemCellsRow]? {
        guard let start = order.firstIndex(where: { $0.id == id }) else { return nil }
        let head = order[start]
        var held = [head]
        for row in order[(start + 1)...] {
            let breaks = row.depth == 0 && (head.kind != .section || row.kind == .section || row.kind == .separator)
            if breaks { break }
            held.append(row)
        }
        return held
    }
}

/// The actions behind a row pulled open, revealed as the row slides.
final class StemCellsSwipeActionsView: UIView {
    private var buttons: [UIButton] = []
    let count: Int
    var openWidth: CGFloat { StemCellsSwipeLayout.width(actions: count) }
    /// Whether letting go now would leave them open.
    var wouldOpen = false

    init(actions: [StemCellsSwipeAction], close: @escaping () -> Void) {
        count = actions.count
        super.init(frame: .zero)
        clipsToBounds = true
        layer.cornerRadius = StemCellsMetrics.cornerRadius
        layer.cornerCurve = .continuous
        for action in actions {
            var configuration = UIButton.Configuration.plain()
            configuration.attributedTitle = AttributedString(action.title, attributes: AttributeContainer([.font: StemCellsFonts.ui(.semiBold, size: StemCellsMetrics.labelSize)]))
            configuration.baseForegroundColor = UIColor(Palette.stemCellsSwipeInk)
            configuration.contentInsets = .zero
            let button = UIButton(configuration: configuration)
            button.backgroundColor = UIColor(action.destructive ? Palette.stemCellsSwipeDestructive : Palette.stemCellsSwipeAction)
            button.accessibilityIdentifier = "stem-swipe:\(action.identifier)"
            button.addAction(UIAction { _ in
                close()
                action.handler()
            }, for: .touchUpInside)
            addSubview(button)
            buttons.append(button)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Slides `row` left by `pull`, uncovering the actions.
    func pull(_ pull: CGFloat, row: StemCellsRowView?) {
        let layout = StemCellsSwipeLayout(box: bounds.size, actions: count, pull: pull)
        for (button, frame) in zip(buttons, layout.actions) { button.frame = frame }
        row?.transform = CGAffineTransform(translationX: -layout.offset, y: 0)
        alpha = layout.offset > 0 ? 1 : 0
    }
}
/// A touch-down that shows a row pressed while a tap or a scroll decides.
final class PressRecognizer: UILongPressGestureRecognizer {
    final class Simultaneous: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
    static let simultaneous = Simultaneous()

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        minimumPressDuration = 0.08
        allowableMovement = 8
        cancelsTouchesInView = false
        delaysTouchesBegan = false
    }
}
#endif
