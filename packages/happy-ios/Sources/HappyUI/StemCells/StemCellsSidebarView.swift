#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The Stem Cells sidebar as one scrolling column. Rows are views keyed by
/// their ID: a row that did not change is not touched, a changed one is
/// reconfigured in place, and a fold only moves the rows after it. Nothing
/// here ever resets the scroll position.
///
/// A hold on a row opens a preview of its conversation over the blurred
/// screen with its menu under it, as Telegram's chat list does; moving on
/// from the hold drops the preview and
/// carries the row (its peers glide aside, the list scrolls at its edges,
/// and a drop lands where the gap is). A row's title can turn into a field
/// in place to be renamed.
final class StemCellsSidebarView: UIScrollView {
    var onSelect: ((StemCellsRow) -> Void)?
    /// A finger came down on a row that opens: it may be opened next.
    var onIntent: ((StemCellsRow) -> Void)?
    var onFold: ((StemCellsRow) -> Void)?
    /// A section's "+": new work in that section. Sections show it only when set.
    var onAdd: ((StemCellsRow) -> Void)?
    /// What a hold on the row offers, in groups; nil for a row that has nothing.
    var menu: ((StemCellsRow) -> [[StemCellsMenuItem]]?)?
    /// What a hold shows of the row over its menu: its conversation, read
    /// only, or nothing for a row that has none.
    var preview: ((StemCellsRow) -> UIViewController?)?
    /// The preview was tapped: the row opens at once, under it.
    var onOpenPreview: ((StemCellsRow) -> Void)?
    /// A carry for a row, when it can be carried.
    var beginDrag: ((StemCellsRow) -> StemCellsDrag?)?
    /// A carry starts or ends (the document holds still while one is on).
    var onDragging: ((Bool) -> Void)?
    /// Set down in slot `to`.
    var onDrop: ((StemCellsDrag, Int) -> Void)?
    var images: StemCellsImages?
    /// Room above the first row and below the last; the sidebar's own when nil.
    var padding: (top: CGFloat, bottom: CGFloat)?
    /// Off where the list is drawn whole inside another screen's scroll.
    var scrolls = true {
        didSet { isScrollEnabled = scrolls }
    }

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
    /// A held row's preview and menu, while shown.
    private var hold: StemCellsHoldOverlay?
    /// The hold showed the row at the lift, so the lift showed nothing and
    /// the carry draws its own card (`floating`), under the finger.
    private var liftHidden = false
    private var floating: (card: UIView, grab: CGPoint, held: [StemCellsRow], hand: (UIWindow) -> CGPoint)?
    /// Reorder from the menu: the row is lifted and waits for a finger, which
    /// carries it wherever it goes down (`reorderPan`).
    private var armed = false
    private let reorderPan = UIPanGestureRecognizer()
    /// A tap anywhere outside the list while armed (the header, the dock) puts the row back.
    private lazy var outside: UITapGestureRecognizer = {
        let tap = UITapGestureRecognizer(target: self, action: #selector(tappedOutside(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = PressRecognizer.simultaneous
        return tap
    }()
    private var editing: (id: String, commit: (String) -> Void)?

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
        // The hold opens with the drag's lift, whichever comes first; the
        // touch stays the drag's, so moving on carries the row.
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.5
        hold.cancelsTouchesInView = false
        hold.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(hold)
        let drag = UIDragInteraction(delegate: self)
        drag.isEnabled = true
        addInteraction(drag)
        addInteraction(UIDropInteraction(delegate: self))
        reorderPan.addTarget(self, action: #selector(reorderPanned(_:)))
        reorderPan.maximumNumberOfTouches = 1
        reorderPan.isEnabled = false
        addGestureRecognizer(reorderPan)
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

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        guard newWindow == nil else { return }
        // Leaving the screen mid-hold or mid-carry: nothing is left behind
        // in the window, and the display link lets go of the list.
        hold?.close(animated: false)
        liftHidden = false
        armed = false
        isScrollEnabled = scrolls
        reorderPan.isEnabled = false
        outside.view?.removeGestureRecognizer(outside)
        floating?.card.removeFromSuperview()
        floating = nil
        for view in views.values { view.isHidden = false }
        if carry != nil { endCarry(); settle() }
    }

    /// Shows `rows`, touching only the rows that changed. Returns how many it touched.
    @discardableResult
    func apply(_ rows: [StemCellsRow]) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        let previous = Dictionary(self.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // Other rows in the same shapes (one swapped for another) are placed
        // again: their views are new.
        if self.rows.map(\.id) != rows.map(\.id) { laidOut = nil }
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
            if onFold == nil, row.kind == .section { view.accessibilityTraits = .header }
            view.selected = row.id == selectedRowId
            touched += 1
        }
        for (id, view) in views where !live.contains(id) {
            view.removeFromSuperview()
            views.removeValue(forKey: id)
            if editing?.id == id { editing = nil }
            touched += 1
        }
        // A lifted row that went away (archived elsewhere) is put down.
        if armed, let held = carry?.drag.held, held.contains(where: { !live.contains($0.id) }) { disarm() }
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
        // VoiceOver reaches the hold's menu as the row's actions.
        view.actions = { [weak self, weak view] in
            guard let self, editing == nil, let row = view?.row else { return nil }
            var actions: [UIAccessibilityCustomAction] = []
            if row.kind == .section, let onAdd {
                actions.append(UIAccessibilityCustomAction(name: Strings.StemCells.newWorkIn(row.label), image: StemCellsGlyphs.image("add")) { _ in
                    onAdd(row)
                    return true
                })
            }
            return actions + (menu?(row) ?? []).joined().map { item in
                UIAccessibilityCustomAction(name: item.title, image: StemCellsGlyphs.image(item.icon)) { _ in
                    item.run()
                    return true
                }
            }
        }
        return view
    }

    @objc private func rowTapped(_ gesture: UITapGestureRecognizer) {
        // The touch that opened a hold, let go: the hold stays and that is all.
        guard hold == nil, let view = gesture.view as? StemCellsRowView, let row = view.row else { return }
        // A lifted row put back by a tap that didn't move it.
        if armed { return disarm() }
        // A tap while something is open closes it and does nothing else; a
        // tap in the title being edited is the field's.
        if editing != nil {
            if let id = editing?.id, id != row.id { finishRename() }
            return
        }
        switch row.kind {
        case .section:
            // Its "+", with a finger's room around it, makes new work in it.
            if let add = view.frames?.add, let onAdd, gesture.location(in: self).x >= add.minX - 7, gesture.location(in: self).x < add.maxX + StemCellsMetrics.trailingGap / 2 {
                onAdd(row)
            } else {
                onFold?(row)
            }
        case .separator: break
        default:
            // A row's fold is its chevron, with a finger's room around it;
            // a row that opens nothing (a proposal's) folds wherever it's tapped.
            if let chevron = view.frames?.chevron, onSelect == nil || gesture.location(in: self).x >= chevron.minX - 14 {
                onFold?(row)
            } else {
                onSelect?(row)
            }
        }
    }

    @objc private func tappedAway(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        // The lifted row's own slot is hidden and takes no tap: any tap puts it back.
        if armed { return disarm() }
        // A row's own tap closes what is open, and only that.
        guard row(at: point) == nil else { return }
        if editing != nil { finishRename() }
    }

    @objc private func rowPressed(_ gesture: PressRecognizer) {
        guard let view = gesture.view as? StemCellsRowView else { return }
        let opens = view.row?.kind == .section ? onFold != nil : onSelect != nil
        view.pressed = opens && hold == nil && (gesture.state == .began || gesture.state == .changed)
        if gesture.state == .began, onSelect != nil, let row = view.row { onIntent?(row) }
    }

    /// The rows on screen now, top first.
    var visibleRows: [StemCellsRow] {
        let shown = arranged ?? rows
        guard let frames = layoutResult?.frames, frames.count == shown.count else { return [] }
        let window = bounds.inset(by: contentInset)
        return zip(shown, frames).filter { $0.1.box.intersects(window) }.map(\.0)
    }

    private func layoutRows(_ rows: [StemCellsRow]) -> [StemCellsSidebarLayout.Row] {
        Self.layoutRows(rows, adds: onAdd != nil)
    }

    nonisolated static func layoutRows(_ rows: [StemCellsRow], adds: Bool = false) -> [StemCellsSidebarLayout.Row] {
        rows.map { row in
            let kind: StemCellsSidebarLayout.Kind = switch row.kind {
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            default: .row
            }
            return StemCellsSidebarLayout.Row(kind: kind, depth: row.depth, hasMark: row.mark != .none, hasTrailing: row.status == .waiting || row.status == .awaitingInput, hasFold: (row.kind == .space || row.kind == .session) && row.collapsed != nil, hasAdd: adds && row.kind == .section, foldClosed: row.collapsed == true || row.hasHiddenSessions)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let shown = arranged ?? rows
        let input = layoutRows(shown)
        let width = bounds.width
        if laidOut?.width != width || laidOut?.rows != input || layoutResult?.frames.count != shown.count {
            place(shown, animated: false)
        }
    }

    /// Lays `shown` out and moves each row to its place, gliding when asked.
    private func place(_ shown: [StemCellsRow], animated: Bool) {
        let input = layoutRows(shown)
        let result = StemCellsSidebarLayout.layout(input, width: bounds.width, top: padding?.top ?? StemCellsMetrics.contentTop, bottom: padding?.bottom ?? StemCellsMetrics.contentBottom, scale: traitCollection.displayScale)
        layoutResult = result
        laidOut = (bounds.width, input)
        let move = {
            for (row, frame) in zip(shown, result.frames) {
                guard let view = self.views[row.id] else { continue }
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

    // MARK: Hold

    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        openHold(at: gesture.location(in: self))
    }

    /// The items a hold at `point` would show, and the row they are for.
    private func holdTarget(at point: CGPoint) -> (view: StemCellsRowView, row: StemCellsRow, items: [[StemCellsMenuItem]])? {
        guard editing == nil, let view = row(at: point), let row = view.row,
              let items = menu?(row), !items.isEmpty else { return nil }
        return (view, row, items)
    }

    /// Telegram's hold: the screen blurs, the row's conversation grows out
    /// of it with the menu under it, and a light tap is felt.
    private func openHold(at point: CGPoint) {
        guard hold == nil, !armed, carry?.link == nil, let window, let target = holdTarget(at: point) else { return }
        // Warmed as the hold begins: a carry may follow at once.
        StemCellsHaptics.prepare(.lift)
        StemCellsHaptics.prepare(.slot)
        StemCellsHaptics.play(.hold)
        let row = target.row
        let preview = preview?(row)
        let source = target.view.convert(target.view.bounds, to: window)
        // The row as it rests, not pressed.
        target.view.pressed = false
        let snapshot = preview == nil ? target.view.snapshotView(afterScreenUpdates: true) : nil
        let overlay = StemCellsHoldOverlay(window: window, items: target.items, preview: preview, source: source, snapshot: snapshot)
        overlay.onOpen = { [weak self] in self?.onOpenPreview?(row) }
        overlay.onLeave = { [weak self, weak overlay] in
            if self?.hold === overlay { self?.hold = nil }
        }
        hold = overlay
        // Under the blur the list holds still.
        panGestureRecognizer.isEnabled = false
        panGestureRecognizer.isEnabled = true
        overlay.present()
    }

    // MARK: Reorder from the menu

    /// Lifts `rowId` where it is, as if just picked up: the next finger to
    /// go down and move carries it, and where it is let go it stays. A tap
    /// that doesn't move puts it back.
    func armReorder(_ rowId: String) {
        // A carry the lift warmed and never used is replaced.
        guard window != nil, !armed, carry?.link == nil, arranged == nil, editing == nil, let row = rows.first(where: { $0.id == rowId }),
              let drag = beginDrag?(row) else { return }
        let frames = StemCellsSidebarLayout.layout(layoutRows(rows), width: bounds.width, scale: traitCollection.displayScale).frames
        guard let last = drag.units.last?.last, last < frames.count else { return }
        let rect = heldFrame(order: rows, held: drag.held)
        guard !rect.isNull else { return }
        scrollRectToVisible(rect.insetBy(dx: 0, dy: -24), animated: false)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        carry = Carry(drag: drag, start: center, hand: convert(center, to: superview), to: drag.from, heights: heights(drag, frames: frames))
        // Lifted in place, holding still until a finger takes it.
        let home = convert(center, to: nil)
        float { _ in home }
        // What a test (and VoiceOver's screen) finds while it waits for a finger.
        floating?.card.isAccessibilityElement = true
        floating?.card.accessibilityIdentifier = "stem-lifted"
        floating?.card.accessibilityLabel = row.label
        for row in drag.held { views[row.id]?.isHidden = true }
        armed = true
        isScrollEnabled = false
        reorderPan.isEnabled = true
        window?.addGestureRecognizer(outside)
        // The list holds still under the lifted row until it's set down.
        onDragging?(true)
        StemCellsHaptics.play(.lift)
        UIAccessibility.post(notification: .announcement, argument: Strings.StemCells.reorderHint)
    }

    /// Put back where it was, nothing moved; at once when the screen is going.
    func disarm(animated: Bool = true) {
        guard armed else { return }
        unarm()
        if animated {
            land(in: nil, home: true)
        } else {
            floating?.card.removeFromSuperview()
            floating = nil
            for view in views.values { view.isHidden = false }
        }
        endCarry()
        settle()
    }

    private func unarm() {
        armed = false
        isScrollEnabled = scrolls
        reorderPan.isEnabled = false
        outside.view?.removeGestureRecognizer(outside)
    }

    /// The header and the dock sit over the list, so any tap counts: a tap
    /// on a row was the list's own and disarmed already.
    @objc private func tappedOutside(_ gesture: UITapGestureRecognizer) {
        disarm()
    }

    @objc private func reorderPanned(_ gesture: UIPanGestureRecognizer) {
        guard armed, var carry else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            // Wherever the finger went down, the row moves with it from there.
            let travel = gesture.translation(in: self)
            let down = CGPoint(x: point.x - travel.x, y: point.y - travel.y)
            if let floating {
                let window = floating.card.window
                let downInWindow = window.map { convert(down, to: $0) } ?? down
                self.floating?.grab = CGPoint(x: floating.card.center.x - downInWindow.x, y: floating.card.center.y - downInWindow.y)
                self.floating?.hand = { [weak gesture] window in gesture?.location(in: window) ?? .zero }
            }
            carry.start = down
            carry.hand = convert(point, to: superview)
            startCarry(&carry)
            self.carry = carry
            updateCarry()
        case .changed:
            self.carry?.hand = convert(point, to: superview)
            updateCarry()
        case .ended:
            self.carry?.hand = convert(point, to: superview)
            updateCarry()
            unarm()
            guard let to = self.carry?.to, let drag = self.carry?.drag else { return land(in: nil, home: true) }
            drop()
            land(in: drag.order(to: to), home: false)
        default:
            disarm()
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

    // MARK: Carry

    private func heights(_ drag: StemCellsDrag, frames: [StemCellsSidebarLayout.Frame]) -> [Double] {
        drag.units.map { unit in
            Double(frames[unit.last!].box.maxY - frames[unit.first!].box.minY + StemCellsMetrics.rowGap)
        }
    }

    /// The drawn order's frames for the carried rows, and their union.
    private func heldFrame(order: [StemCellsRow], held: [StemCellsRow]) -> CGRect {
        let result = StemCellsSidebarLayout.layout(layoutRows(order), width: bounds.width, scale: traitCollection.displayScale)
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
        moveFloat()
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

extension StemCellsSidebarView: UIDragInteractionDelegate {
    func dragInteraction(_ interaction: UIDragInteraction, itemsForBeginning session: any UIDragSession) -> [UIDragItem] {
        let point = session.location(in: self)
        // Asked at the lift, which may only ever show the menu: a carry not
        // yet under way is replaced.
        guard !armed, carry?.link == nil, editing == nil, let view = row(at: point), let row = view.row,
              let drag = beginDrag?(row) else { return [] }
        // The carry's indices are the document's drawn rows: measured on
        // those, never on an order still held from a drop.
        let frames = StemCellsSidebarLayout.layout(layoutRows(rows), width: bounds.width, scale: traitCollection.displayScale).frames
        guard arranged == nil, let last = drag.units.last?.last, last < frames.count else { return [] }
        carry = Carry(drag: drag, start: point, hand: convert(point, to: superview), to: drag.from, heights: heights(drag, frames: frames))
        let item = UIDragItem(itemProvider: NSItemProvider())
        item.localObject = row.id
        return [item]
    }

    /// The carried rows drawn as they are, on a rounded card.
    private func carriedCard() -> (card: UIView, parameters: UIDragPreviewParameters, center: CGPoint)? {
        guard let carry else { return nil }
        let rect = heldFrame(order: rows, held: carry.drag.held)
        // The rows as they rest, not pressed.
        for row in carry.drag.held { views[row.id]?.pressed = false }
        guard !rect.isNull, let snapshot = resizableSnapshotView(from: rect, afterScreenUpdates: true, withCapInsets: .zero) else { return nil }
        let card = UIView(frame: CGRect(origin: .zero, size: rect.size))
        card.backgroundColor = UIColor(Palette.stemCellsBackground)
        card.layer.cornerRadius = StemCellsMetrics.cornerRadius
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        snapshot.frame = card.bounds
        card.addSubview(snapshot)
        let parameters = UIDragPreviewParameters()
        parameters.visiblePath = UIBezierPath(roundedRect: card.bounds, cornerRadius: StemCellsMetrics.cornerRadius)
        return (card, parameters, CGPoint(x: rect.midX, y: rect.midY))
    }

    func dragInteraction(_ interaction: UIDragInteraction, previewForLifting item: UIDragItem, session: any UIDragSession) -> UITargetedDragPreview? {
        liftHidden = false
        guard let carried = carriedCard() else { return nil }
        let target = UIDragPreviewTarget(container: self, center: carried.center)
        guard holdTarget(at: session.location(in: self)) != nil else {
            return UITargetedDragPreview(view: carried.card, parameters: carried.parameters, target: target)
        }
        // The hold shows the row at the lift, so the lift itself shows
        // nothing; once the finger moves the carry draws its own card. (A
        // lift's look is fixed when it begins, and a drag's own preview is
        // shrunk on the way.)
        liftHidden = true
        let parameters = UIDragPreviewParameters()
        parameters.backgroundColor = .clear
        parameters.shadowPath = UIBezierPath()
        parameters.visiblePath = UIBezierPath(rect: carried.card.bounds)
        return UITargetedDragPreview(view: UIView(frame: carried.card.bounds), parameters: parameters, target: target)
    }

    /// The carried card the carry draws itself, with a lifted row's shadow,
    /// over everything in the window where the rows are.
    private func float(hand: @escaping (UIWindow) -> CGPoint) {
        guard let window, let held = carry?.drag.held, let carried = carriedCard() else { return }
        let card = carried.card
        let room: CGFloat = 24
        let float = UIView(frame: card.bounds.insetBy(dx: -room, dy: -room))
        float.isUserInteractionEnabled = false
        let shadow = UIView(frame: card.frame.offsetBy(dx: room, dy: room))
        shadow.layer.shadowColor = UIColor.black.cgColor
        shadow.layer.shadowOpacity = 0.14
        shadow.layer.shadowRadius = 12
        shadow.layer.shadowOffset = CGSize(width: 0, height: 4)
        shadow.layer.shadowPath = UIBezierPath(roundedRect: shadow.bounds, cornerRadius: StemCellsMetrics.cornerRadius).cgPath
        card.frame = shadow.frame
        float.addSubview(shadow)
        float.addSubview(card)
        let center = convert(carried.center, to: window)
        float.center = center
        floating?.card.removeFromSuperview()
        window.addSubview(float)
        let at = hand(window)
        floating = (float, CGPoint(x: center.x - at.x, y: center.y - at.y), held, hand)
        float.alpha = 0
        UIView.animate(withDuration: 0.15) { float.alpha = 1 }
    }

    /// The floating card follows the finger.
    private func moveFloat() {
        guard let floating, let window = floating.card.window else { return }
        let hand = floating.hand(window)
        floating.card.center = CGPoint(x: hand.x + floating.grab.x, y: hand.y + floating.grab.y)
    }

    /// The floating card flies with `animator` to where its rows are drawn
    /// in `order` (back home when nil), and goes once there; without an
    /// animator it fades where it is.
    private func land(in order: [StemCellsRow]?, with animator: (any UIDragAnimating)?) {
        guard let floating else { return }
        self.floating = nil
        let card = floating.card
        let rect = animator == nil ? CGRect.null : heldFrame(order: order ?? rows, held: floating.held)
        let target = rect.isNull ? nil : card.window.map { convert(CGPoint(x: rect.midX, y: rect.midY), to: $0) }
        let fly = {
            if let target { card.center = target } else { card.alpha = 0 }
        }
        if let animator {
            animator.addAnimations(fly)
            animator.addCompletion { _ in card.removeFromSuperview() }
        } else {
            UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut], animations: fly) { _ in card.removeFromSuperview() }
        }
    }

    /// The floating card flies to where its rows are drawn in `order` (or
    /// back home) on its own, and the rows show once it's there.
    private func land(in order: [StemCellsRow]?, home: Bool) {
        guard let floating else { return }
        self.floating = nil
        let card = floating.card
        let rect = heldFrame(order: order ?? rows, held: floating.held)
        let target = rect.isNull ? nil : card.window.map { convert(CGPoint(x: rect.midX, y: rect.midY), to: $0) }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut]) {
            if let target { card.center = target } else { card.alpha = 0 }
        } completion: { [weak self] _ in
            card.removeFromSuperview()
            guard let self else { return }
            if home { for view in views.values { view.isHidden = false } } else { landed() }
        }
    }

    func dragInteraction(_ interaction: UIDragInteraction, willAnimateLiftWith animator: any UIDragAnimating, session: any UIDragSession) {
        openHold(at: session.location(in: self))
    }

    func dragInteraction(_ interaction: UIDragInteraction, sessionWillBegin session: any UIDragSession) {
        // Moving after the lift: the preview goes and the row is carried.
        hold?.close(animated: true, duration: 0.15)
        guard var carry else { return }
        if liftHidden {
            liftHidden = false
            float { session.location(in: $0) }
        }
        StemCellsHaptics.play(.lift)
        startCarry(&carry)
        self.carry = carry
    }

    /// The carried rows leave their slot (the gap is where they'll land) and
    /// the list starts scrolling at its edges.
    private func startCarry(_ carry: inout Carry) {
        onDragging?(true)
        for row in carry.drag.held { views[row.id]?.isHidden = true }
        arrangedUntil?.cancel()
        arranged = carry.drag.order(to: carry.to)
        let link = CADisplayLink(target: self, selector: #selector(autoscroll(_:)))
        link.add(to: .main, forMode: .common)
        carry.link = link
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
        liftHidden = false
        land(in: nil, with: nil)
        if carry?.link != nil { endCarry(); settle() }
        landed()
        for view in views.values { view.isHidden = false }
    }

    func dragInteraction(_ interaction: UIDragInteraction, item: UIDragItem, willAnimateCancelWith animator: any UIDragAnimating) {
        // A lift let go without moving (the hold stays) ends here and nowhere else.
        liftHidden = false
        if carry?.link == nil { carry = nil }
        land(in: nil, with: animator)
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
        drop()
    }

    /// Set down where the gap is.
    private func drop() {
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
        land(in: arranged, with: animator)
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
            // A section holds its block; any other row what is nested under it.
            let breaks = head.kind == .section ? row.depth == 0 && (row.kind == .section || row.kind == .separator) : row.depth <= head.depth
            if breaks { break }
            held.append(row)
        }
        return held
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
