#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The V2 sidebar as one scrolling column. Rows are views keyed by
/// their ID: a row that did not change is not touched, a changed one is
/// reconfigured in place, and a fold only moves the rows after it. Nothing
/// here ever resets the scroll position.
///
/// A hold on a row opens a preview of its conversation over the blurred
/// screen, with its menu beside it, as Telegram's chat list does. A row's
/// title can turn into a field in place to be renamed.
///
/// Home draws it grouped (`style`): each section a quiet card, as iOS's
/// inset grouped lists are. The cards are views of their own under the
/// rows, keyed by what heads them, so a fold moves and resizes them with
/// the rows.
final class SidebarView: UIScrollView {
    var onSelect: ((Row) -> Void)?
    /// A story row's ring was tapped: its agent's stories, not its conversation.
    var onOpenStory: ((Row, UIView) -> Void)?
    /// A finger came down on a row that opens: it may be opened next.
    var onIntent: ((Row) -> Void)?
    var onFold: ((Row) -> Void)?
    /// What a hold on the row offers, in groups; nil for a row that has nothing.
    var menu: ((Row) -> [[MenuItem]]?)?
    /// What a hold shows of the row over its menu: its conversation, read
    /// only, or nothing for a row that has none.
    var preview: ((Row) -> UIViewController?)?
    /// The preview was tapped: the row opens at once, under it.
    var onOpenPreview: ((Row) -> Void)?
    var images: Images?
    /// Room above the first row and below the last; the sidebar's own when nil.
    var padding: (top: CGFloat, bottom: CGFloat)?
    /// Off where the list is drawn whole inside another screen's scroll.
    var scrolls = true {
        didSet { isScrollEnabled = scrolls }
    }
    /// Desktop's column, or iOS's inset grouped cards (home's).
    var style: SidebarLayout.Style = .plain {
        didSet {
            guard style != oldValue else { return }
            for view in views.values { view.grouped = style == .grouped }
            connectors.isHidden = style == .grouped
            laidOut = nil
            setNeedsLayout()
        }
    }

    /// The row drawn selected: on home, the one whose screen is coming in.
    var selectedRowId: String? {
        didSet {
            guard selectedRowId != oldValue else { return }
            for (id, view) in views { view.selected = id == selectedRowId }
        }
    }

    private(set) var rows: [Row] = []
    private var views: [String: RowView] = [:]
    /// A grouped list's cards, by the heading or separator over each ("top" for the first, unheaded one).
    private var cards: [String: UIView] = [:]
    private let connectors = CAShapeLayer()
    private var laidOut: (width: CGFloat, rows: [SidebarLayout.Row])?
    /// The row IDs `layoutResult`'s frames are for, in its order.
    private var placed: [String] = []
    /// The row a finger just folded or opened. The rows its fold brings or
    /// takes away arrive in a later `apply`, and only those glide; a change
    /// from anywhere else is shown at once, as before.
    private var folding: (id: String, at: CFTimeInterval)?
    /// The next placing glides: rows the fold brought fade in where they
    /// belong, the rest move to make room or close up.
    private var foldGlide = false
    /// Rows the fold took away, fading where they were. One that comes back
    /// before it has gone (the fold opened again at once) is taken back.
    private var leaving: [String: RowView] = [:]
    private var entering: Set<String> = []
    /// The width the rows were last placed at; `laidOut` is cleared when
    /// rows come or go, so it can't say whether the width changed too.
    private var placedWidth: CGFloat = 0
    private(set) var layoutResult: SidebarLayout.Result?
    /// A held row's preview and menu, while shown.
    private var hold: HoldOverlay?
    private var editing: (id: String, commit: (String) -> Void)?
    /// Moves the story rows' times on, once a minute while on screen.
    private var clock: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        alwaysBounceVertical = true
        delaysContentTouches = true
        contentInsetAdjustmentBehavior = .never
        // The indicator insets set below are all of them; UIKit would add the safe area again.
        automaticallyAdjustsScrollIndicatorInsets = false
        connectors.fillColor = UIColor(Palette.rowText).withAlphaComponent(Metrics.connectorAlpha).cgColor
        layer.addSublayer(connectors)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.5
        hold.cancelsTouchesInView = false
        hold.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(hold)
        let away = UITapGestureRecognizer(target: self, action: #selector(tappedAway(_:)))
        away.cancelsTouchesInView = false
        away.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(away)
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in self.setNeedsLayout() }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.connectors.fillColor = UIColor(Palette.rowText).withAlphaComponent(Metrics.connectorAlpha).resolvedColor(with: self.traitCollection).cgColor
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func touchesShouldCancel(in view: UIView) -> Bool { true }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        clock?.invalidate()
        clock = nil
        if newWindow != nil {
            // On the minute, so every time turns together.
            let next = (Date().timeIntervalSince1970 / 60).rounded(.down) * 60 + 60
            let timer = Timer(fire: Date(timeIntervalSince1970: next), interval: 60, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            clock = timer
            tick()
        }
        guard newWindow == nil else { return }
        // Leaving the screen mid-hold: nothing is left behind in the window.
        hold?.close(animated: false)
        // A fold mid-fade is finished, so nothing half-faded is waiting
        // when the screen comes back.
        folding = nil
        foldGlide = false
        settleFold()
    }

    /// Shows `rows`, touching only the rows that changed. Returns how many it touched.
    @discardableResult
    func apply(_ rows: [Row]) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        let previous = Dictionary(self.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // Other rows in the same shapes (one swapped for another) are placed
        // again: their views are new.
        if self.rows.map(\.id) != rows.map(\.id) { laidOut = nil }
        self.rows = rows
        // The rows a fold the finger made brings or takes away, and nothing
        // else: the folded row is still there and only rows came or went.
        // Not under Reduce Motion, and not off screen, where there is
        // nothing to watch.
        // The fold is spent by the change that brings its rows, or after a
        // second; one that only turns the chevron leaves it waiting.
        let ids = Set(rows.map(\.id))
        let changed = ids != Set(previous.keys)
        if let fold = folding, CACurrentMediaTime() - fold.at > 1 { folding = nil }
        let glides = folding.map { ids.contains($0.id) } == true && changed
            && window != nil && !UIAccessibility.isReduceMotionEnabled
        if changed { folding = nil }
        if glides { foldGlide = true }
        var touched = 0
        var live = Set<String>()
        for row in rows {
            live.insert(row.id)
            let view: RowView
            if let existing = views[row.id] {
                view = existing
                if previous[row.id] == row { continue }
            } else if let back = leaving.removeValue(forKey: row.id) {
                // Folded away and opened again before it had gone: the same
                // view comes back from wherever its fade had got to.
                view = back
                views[row.id] = view
                view.isUserInteractionEnabled = true
                view.accessibilityElementsHidden = false
                if glides { entering.insert(row.id) } else { view.alpha = 1 }
            } else {
                view = makeRow()
                views[row.id] = view
                if glides {
                    view.alpha = 0
                    entering.insert(row.id)
                }
            }
            view.configure(row)
            // Rows a tap doesn't open (a proposal's) read as what they are.
            if onSelect == nil, row.kind != .section, row.kind != .separator { view.accessibilityTraits = .staticText }
            if onFold == nil || row.collapsed == nil, row.kind == .section { view.accessibilityTraits = .header }
            view.selected = row.id == selectedRowId
            touched += 1
        }
        for (id, view) in views where !live.contains(id) {
            views.removeValue(forKey: id)
            if editing?.id == id { editing = nil }
            touched += 1
            guard glides else {
                view.removeFromSuperview()
                continue
            }
            // Fades where it is while the rows under it close up; it takes
            // no touch and says nothing to VoiceOver meanwhile.
            view.isUserInteractionEnabled = false
            view.accessibilityElementsHidden = true
            leaving[id] = view
        }
        setNeedsLayout()
        return touched
    }

    private func makeRow() -> RowView {
        let view = RowView()
        view.images = images
        view.grouped = style == .grouped
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
            if (row.story?.segments ?? 0) > 0, let onOpenStory, let ring = view?.ringView {
                actions.append(UIAccessibilityCustomAction(name: Strings.Stories.watchStory) { _ in
                    onOpenStory(row, ring)
                    return true
                })
            }
            return actions + (menu?(row) ?? []).joined().map { item in
                UIAccessibilityCustomAction(name: item.title, image: Glyphs.image(item.icon)) { _ in
                    item.run()
                    return true
                }
            }
        }
        return view
    }

    @objc private func rowTapped(_ gesture: UITapGestureRecognizer) {
        guard let view = gesture.view as? RowView else { return }
        tap(view, at: gesture.location(in: self))
    }

    /// A tap on a row at `point`, in the list's content.
    func tap(_ view: RowView, at point: CGPoint) {
        // The touch that opened a hold, let go: the hold stays and that is all.
        guard hold == nil, let row = view.row else { return }
        // A tap while something is open closes it and does nothing else; a
        // tap in the title being edited is the field's.
        if editing != nil {
            if let id = editing?.id, id != row.id { finishRename() }
            return
        }
        switch row.kind {
        case .section where row.collapsed == nil:
            // Search's heading: nothing folds under it.
            break
        case .section:
            // A heading is a fold and nothing else: anywhere along it.
            fold(row)
        case .separator: break
        default:
            // A ring with stories in it opens them, with a finger's room around it.
            if let ring = view.frames?.ring, (row.story?.segments ?? 0) > 0, let onOpenStory,
               ring.insetBy(dx: -8, dy: -8).contains(point), let ringView = view.ringView {
                onOpenStory(row, ringView)
                return
            }
            // A row's fold is its chevron, with a finger's room around it;
            // a row that opens nothing (a proposal's) folds wherever it's tapped.
            if let chevron = view.frames?.chevron, onSelect == nil || point.x >= chevron.minX - 14 {
                fold(row)
            } else {
                onSelect?(row)
            }
        }
    }

    /// A fold the finger made: what it brings or takes away glides in when
    /// it arrives (`apply`).
    private func fold(_ row: Row) {
        folding = (row.id, CACurrentMediaTime())
        onFold?(row)
    }

    @objc private func tappedAway(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        // A row's own tap closes what is open, and only that.
        guard row(at: point) == nil else { return }
        if editing != nil { finishRename() }
    }

    @objc private func rowPressed(_ gesture: PressRecognizer) {
        guard let view = gesture.view as? RowView else { return }
        let opens = view.row?.kind == .section ? onFold != nil && view.row?.collapsed != nil : onSelect != nil
        view.pressed = opens && hold == nil && (gesture.state == .began || gesture.state == .changed)
        if gesture.state == .began, onSelect != nil, let row = view.row { onIntent?(row) }
    }

    /// The rows shown, folds applied, in the order drawn.
    var shownRows: [Row] { rows }

    /// The places among `shownRows` on screen now; nil before they are
    /// laid out.
    var visibleRange: ClosedRange<Int>? {
        let shown = shownRows
        guard let frames = layoutResult?.frames, frames.count == shown.count else { return nil }
        let window = bounds.inset(by: contentInset)
        let on = frames.indices.filter { frames[$0].box.intersects(window) }
        guard let first = on.first, let last = on.last else { return nil }
        return first...last
    }

    /// The rows on screen now, top first.
    var visibleRows: [Row] {
        let shown = rows
        guard let frames = layoutResult?.frames, frames.count == shown.count else { return [] }
        let window = bounds.inset(by: contentInset)
        return zip(shown, frames).filter { $0.1.box.intersects(window) }.map(\.0)
    }

    private func layoutRows(_ rows: [Row]) -> [SidebarLayout.Row] {
        Self.layoutRows(rows, textScale: StoryRowText.scale(traitCollection))
    }

    /// `input` laid out at this list's width, room and style.
    private func layout(_ input: [SidebarLayout.Row]) -> SidebarLayout.Result {
        let grouped = style == .grouped
        let top = padding?.top ?? (grouped ? GroupedSidebarMetrics.contentTop : Metrics.contentTop)
        let bottom = padding?.bottom ?? (grouped ? GroupedSidebarMetrics.contentBottom : Metrics.contentBottom)
        return SidebarLayout.layout(input, width: bounds.width, top: top, bottom: bottom, scale: traitCollection.displayScale, style: style)
    }

    /// The rows as the layout needs them; story rows measured at `textScale`.
    nonisolated static func layoutRows(_ rows: [Row], textScale: CGFloat = 1) -> [SidebarLayout.Row] {
        rows.map { row in
            let kind: SidebarLayout.Kind = switch row.kind {
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            default: .row
            }
            let corner: SidebarLayout.Corner = switch row.corner {
            case .none: .none
            case .dot: .dot
            case .braille: .braille
            }
            let story = row.story.map { _ in
                SidebarLayout.StoryRow(corner: corner, timeWidth: StoryRowText.timeWidth(row, scale: textScale), last: StoryRowText.lastLine(row), text: StoryRowText.text(textScale))
            }
            return SidebarLayout.Row(kind: kind, depth: row.depth, hasMark: row.mark != .none, hasTrailing: row.hasTrailingMark, hasWorkingSignal: row.status == .working, hasFold: (row.kind == .space || row.kind == .session) && row.collapsed != nil, foldClosed: row.collapsed == true || row.hasHiddenSessions, story: story, amongStories: row.amongStories)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let shown = rows
        let input = layoutRows(shown)
        let width = bounds.width
        if laidOut?.width != width || laidOut?.rows != input || layoutResult?.frames.count != shown.count {
            // A width change lays out at once even mid-fold: rotation is
            // not the fold's to animate.
            let glide = foldGlide && placedWidth == width
            foldGlide = false
            if glide { placeFold(shown) } else { place(shown, animated: false); settleFold() }
        }
        // A row scrolled out of sight stops its title's sweep. Drawn whole
        // inside another screen's scroll, every row counts as seen.
        for view in views.values { view.onScreen = !scrolls || view.frame.intersects(bounds) }
    }

    /// Lays `shown` out and moves each row to its place, gliding when asked.
    private func place(_ shown: [Row], animated: Bool) {
        let input = layoutRows(shown)
        // Where the reader is, before the new places are known.
        let anchor = anchor()
        let offset = contentOffset.y
        let oldBottom = max(-contentInset.top, contentSize.height + contentInset.bottom - bounds.height)
        let overscroll = max(0, offset - oldBottom)
        let result = layout(input)
        layoutResult = result
        laidOut = (bounds.width, input)
        placedWidth = bounds.width
        placed = shown.map(\.id)
        let cardFrames = placeCards(shown, result, animated: animated)
        let move = {
            for (key, frame) in cardFrames { self.cards[key]?.frame = frame }
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
        keep(anchor, in: shown, result, offset: offset, overscroll: overscroll)
    }

    /// The cards `result` draws, by what heads each: a card that is new
    /// opens down from its top when the rows glide (a section unfolding)
    /// and is simply there otherwise; one that went closes up into its top
    /// and goes. Returns where each card goes.
    private func placeCards(_ shown: [Row], _ result: SidebarLayout.Result, animated: Bool) -> [(String, CGRect)] {
        let frames = result.groups.map { group in
            (group.rows.lowerBound > 0 ? shown[group.rows.lowerBound - 1].id : "top", group.frame)
        }
        let live = Set(frames.map(\.0))
        for (key, card) in cards where !live.contains(key) {
            cards.removeValue(forKey: key)
            guard animated else {
                card.removeFromSuperview()
                continue
            }
            UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
                card.frame.size.height = 0
                card.alpha = 0
            } completion: { _ in card.removeFromSuperview() }
        }
        for (key, frame) in frames where cards[key] == nil {
            let card = UIView()
            card.isUserInteractionEnabled = false
            card.backgroundColor = UIColor(Palette.groupedCard)
            card.layer.cornerRadius = GroupedSidebarMetrics.radius
            card.layer.cornerCurve = .continuous
            card.frame = animated ? CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: 0) : frame
            insertSubview(card, at: 0)
            cards[key] = card
        }
        return frames
    }

    /// The cards drawn now, top first, for the hosted tests.
    var cardFrames: [CGRect] { cards.values.map(\.frame).sorted { $0.minY < $1.minY } }

    /// A fold's rows: the ones it brought are put where they belong at once
    /// and fade in there, the others glide to their new places as desktop's
    /// do, and the ones it took away fade where they stood while the rows
    /// under them close up.
    private func placeFold(_ shown: [Row]) {
        // Arrivals start in place, so they don't fly in from wherever a new
        // view begins.
        let arriving = entering.filter { id in views[id]?.frames == nil }
        if !arriving.isEmpty {
            let input = layoutRows(shown)
            let result = layout(input)
            UIView.performWithoutAnimation {
                for (row, frame) in zip(shown, result.frames) where arriving.contains(row.id) {
                    guard let view = views[row.id] else { continue }
                    view.bounds = CGRect(origin: .zero, size: frame.box.size)
                    view.center = CGPoint(x: frame.box.midX, y: frame.box.midY)
                    view.frames = frame
                    view.layoutIfNeeded()
                }
            }
        }
        place(shown, animated: true)
        let fadingIn = entering.compactMap { views[$0] }
        entering = []
        let fadingOut = leaving
        UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            for view in fadingIn { view.alpha = 1 }
            for view in fadingOut.values { view.alpha = 0 }
        } completion: { _ in
            // Only what is still leaving: a row taken back meanwhile stays.
            for (id, view) in fadingOut where self.leaving[id] === view {
                view.removeFromSuperview()
                self.leaving.removeValue(forKey: id)
            }
        }
    }

    /// Anything a fold left half done, finished at once: what arrived is
    /// shown whole and what left is gone.
    private func settleFold() {
        for id in entering { views[id]?.alpha = 1 }
        entering = []
        for view in leaving.values { view.removeFromSuperview() }
        leaving = [:]
    }

    /// The first row on screen and where it sits in the content: what the
    /// reader is looking at. Nil at the very top, where new rows are meant
    /// to be seen arriving, or before a layout.
    private func anchor() -> (id: String, y: CGFloat)? {
        guard scrolls, let frames = layoutResult?.frames, frames.count == placed.count else { return nil }
        guard contentOffset.y > -contentInset.top + 0.5 else { return nil }
        let window = bounds.inset(by: contentInset)
        guard let index = frames.firstIndex(where: { $0.box.intersects(window) }) else { return nil }
        return (placed[index], frames[index].box.minY)
    }

    /// The reader's place, kept: rows that changed above what is on screen
    /// would otherwise push everything under the eye (a conversation added
    /// or archived elsewhere, Prioritizing's reordering). The list moves by
    /// what the content above moved, so the rows on screen stay where they
    /// are. UIKit can adjust the offset when contentSize changes, so the
    /// correction starts from the offset before that change. A bounce's
    /// existing overscroll is preserved instead of snapping to the edge.
    private func keep(_ anchor: (id: String, y: CGFloat)?, in shown: [Row], _ result: SidebarLayout.Result, offset: CGFloat, overscroll: CGFloat) {
        guard let anchor, let index = shown.firstIndex(where: { $0.id == anchor.id }),
              result.frames.indices.contains(index) else { return }
        let moved = result.frames[index].box.minY - anchor.y
        let top = -contentInset.top
        let bottom = max(top, result.contentHeight + contentInset.bottom - bounds.height)
        let next = min(bottom + overscroll, max(top, offset + moved))
        guard abs(next - contentOffset.y) > 0.01 else { return }
        contentOffset.y = next
    }

    func view(for rowId: String) -> RowView? { views[rowId] }

    /// The times as the clock reads them now; a width that changed lays the list out again.
    private func tick() {
        guard rows.contains(where: { $0.story != nil }) else { return }
        for view in views.values { view.refreshTime() }
        setNeedsLayout()
    }

    private func row(at point: CGPoint) -> RowView? {
        for view in views.values where view.frame.contains(point) { return view }
        return nil
    }

    // MARK: Hold

    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        openHold(at: gesture.location(in: self))
    }

    /// Telegram's hold: the screen blurs, the row's conversation grows out
    /// of it with the menu under it, and a light tap is felt. A row with
    /// neither a menu nor a conversation shows nothing.
    func openHold(at point: CGPoint) {
        guard hold == nil, editing == nil, let window, let view = row(at: point), let row = view.row else { return }
        let items = menu?(row) ?? []
        let preview = preview?(row)
        guard !items.isEmpty || preview != nil else { return }
        Haptics.play(.hold)
        let source = view.convert(view.bounds, to: window)
        // The row as it rests, not pressed.
        view.pressed = false
        let snapshot = preview == nil ? view.snapshotView(afterScreenUpdates: true) : nil
        let overlay = HoldOverlay(window: window, items: items, preview: preview, source: source, snapshot: snapshot)
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
            Haptics.play(.renamed)
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
