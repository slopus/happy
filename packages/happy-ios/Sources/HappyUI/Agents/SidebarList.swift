#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// Home's list, and search's results over it, on UltraList: the grouped
/// sidebar's rows (`SidebarLayout`'s
/// inset cards), only those near the screen mounted, each one's text drawn
/// off the main thread. Where `SidebarView` keeps a view per row and lays
/// every row out again on each frame it moves, this keeps a window of rows
/// and lays nothing out on the main thread: the rows' frames, slots and
/// drawings are worked out by `ApplyPipeline` off it, and a change applies
/// only the rows it touched.
///
/// What a row looks like and what a finger does to it are `SidebarView`'s:
/// the same frames, cards, hairlines, faces and marks; a press lights the
/// row, a tap opens it, a hold shows its conversation over the blurred
/// screen with its menu. The rows on screen stay where they are when rows
/// change above them, and at the very top new rows are seen arriving.
///
/// Where home allows it, a bot's or task's row moves and archives as
/// desktop's do: held, the row lifts out of the list at once, instead of
/// showing its preview (`holdCarries`), and is carried among its peers
/// (`SidebarReorder`, `SidebarCarryLayout`); swiped toward its leading edge
/// it uncovers Archive (`SidebarSwipeLayout`).
///
/// UltraList is not a scroll view, so the screen's bar shades `edge`
/// instead: a scroll view that never scrolls under a finger and follows the
/// list's place, which iOS 26's soft scroll edge and the scroll indicator
/// read. The list rides inside it, held still on screen as its place
/// changes, so the soft edge shades the rows as it would its own content.
@MainActor
final class SidebarList: UIView {
    let list = UltraListView(engineMode: .keyframe)
    /// The scroll view the bar's edge and the scroll indicator follow.
    let edge = SidebarListEdge()

    var onSelect: ((Row) -> Void)?
    /// A finger came down on a row that opens: it may be opened next.
    var onIntent: ((Row) -> Void)?
    /// What a hold on the row offers, in groups; nil for a row that has nothing.
    var menu: ((Row) -> [[MenuItem]]?)?
    /// What a hold shows of the row over its menu: its conversation, read
    /// only, or nothing for a row that has none.
    var preview: ((Row) -> UIViewController?)?
    /// The preview was tapped: the row opens at once, under it.
    var onOpenPreview: ((Row) -> Void)?
    /// A bot or task was carried somewhere new; nil: nothing is carried.
    var onReorder: ((SidebarReorder.Move) -> Void)?
    /// A bot's or task's swipe let go on Archive; nil: nothing swipes.
    var onArchive: ((Row) -> Void)?
    var images: Images?

    /// The list moved: a finger, a glide or a jump.
    var onScroll: (() -> Void)?
    var onWillBeginDragging: (() -> Void)?
    /// The finger lifted; true when the list glides on.
    var onDidEndDragging: ((Bool) -> Void)?
    /// A glide came to rest.
    var onDidEndDecelerating: (() -> Void)?
    /// The list's place changed, however it moved: a finger, a glide, a
    /// jump, rows changing above it or its insets.
    var onMove: (() -> Void)?

    /// Where the list opens once its first rows come (`place`), if that row
    /// is among them, rather than at the top.
    var opensAt: (rowId: String, top: CGFloat)?

    /// Each new set of rows shows at once from the top (search's results,
    /// replaced as the query changes) rather than gliding in under the
    /// reader's place (home's).
    var startsEachChangeAtTop = false

    /// The row drawn selected: on home, the one whose screen is coming in.
    var selectedRowId: String? {
        didSet {
            guard selectedRowId != oldValue else { return }
            for view in mountedViews { view.selected = view.row.id == selectedRowId }
            update()
        }
    }

    private(set) var rows: [Row] = []
    /// The note over the rows (the last thing the computer refused), the
    /// list's first item: it comes and goes as rows do, the rows under it
    /// moving, and never covers one.
    var notice: String? {
        didSet {
            guard notice != oldValue else { return }
            update()
        }
    }
    /// The room above the rows and below them, and the indicator's.
    private(set) var contentInsets = UIEdgeInsets.zero
    private var prepared: Prepared?
    /// The slots at another width, for a width change that lays the rows
    /// on screen out again before the list derives them there.
    private(set) var replan: ListReplan<Entry>?
    private var items: [String: SidebarItem] = [:]
    private var noticeItem: SidebarNoticeItem?
    private var requested: Input?
    private var observation: ApplyObservation?
    private var hold: HoldOverlay?
    private var indicatorFlashed: CFTimeInterval = 0
    /// Applies waiting for their rows to be drawn.
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// The row standing swiped open, if one is.
    private weak var swiped: SidebarItemView?
    /// The row a finger carries, and the one being set down after it.
    private var carry: Carry?
    private var landing: String?
    /// The rows home gave while one was carried or set down: shown once it lands.
    private var heldRows: [Row]?
    /// The carried row's own view, empty under its picture.
    private weak var hiddenView: SidebarItemView?
    /// When the last carry ended: the lift that ends it is not a tap.
    private var carriedAt: CFTimeInterval = 0

    struct Input: Equatable, Sendable {
        var rows: [Row]
        var width: CGFloat
        var dark: Bool
        var displayScale: CGFloat
        var selected: String?
        var notice: String?
    }

    /// The notice over the rows, as worked out off the main thread.
    struct Notice: Sendable {
        var text: String
        /// Its card and title, the item's height with the room under it.
        var layout: BannerLayout
        var revision: UInt64
    }

    /// One slot of the list, as worked out off the main thread.
    struct Entry: Sendable {
        var row: Row
        var size: CGSize
        /// The row's box, from the slot's top-left.
        var box: CGRect
        /// Where the slot starts in the content.
        var top: CGFloat
        var drawing: SidebarItemDrawing
        var revision: UInt64
        /// How far a shimmering title's words run (`SidebarItemDrawing.shimmers`).
        var titleRun: CGFloat?
    }

    struct Prepared: Sendable {
        var input: Input
        /// The rows, their tops under the notice.
        var entries: [Entry]
        var notice: Notice?
        var contentHeight: CGFloat
        var sequence: UInt64

        /// The list's items, the notice first.
        var identities: [String] { (notice == nil ? [] : [SidebarNoticeItem.id]) + entries.map(\.row.id) }

        /// Where the list's item `index` starts in the content.
        func top(at index: Int) -> CGFloat? {
            guard let row = row(at: index) else { return notice != nil && index == 0 ? 0 : nil }
            return entries[row].top
        }

        /// The row the list's item `index` shows; nil for the notice.
        func row(at index: Int) -> Int? {
            let row = notice == nil ? index : index - 1
            return entries.indices.contains(row) ? row : nil
        }

        /// Each item's box in the content, the notice first.
        var boxes: [CGRect] {
            let card = notice.map { [CGRect(origin: .zero, size: $0.layout.size)] } ?? []
            return card + entries.map { $0.box.offsetBy(dx: 0, dy: $0.top) }
        }
    }

    private lazy var pipeline = ApplyPipeline<Input?, Prepared?, Prepared>(
        input: nil,
        state: nil,
        derive: { input, previous in
            guard let input, input != previous?.input else { return nil }
            let result = Self.derive(input, previous: previous)
            return (result, result)
        },
        apply: { [weak self] result in
            guard let self, let requested, result.input == requested else { return false }
            show(result)
            return true
        }
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
        list.accessibilityIdentifier = "home-list"
        list.onScroll = { [weak self] _ in self?.scrolled() }
        list.onVisibleWindowChanged = { [weak self] in
            self?.mirror()
            self?.hideCarried()
        }
        list.willBeginDragging = { [weak self] in
            self?.closeSwipe()
            self?.flashIndicator(force: true)
            self?.onWillBeginDragging?()
        }
        list.didEndDragging = { [weak self] in
            guard let self else { return }
            onDidEndDragging?(list.isDecelerating)
        }
        list.didEndScrolling = { [weak self] in self?.onDidEndDecelerating?() }
        addSubview(edge)
        edge.addSubview(list)
        observation = pipeline.observation
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in self.update() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        resizeList()
        update()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        list.takingMargins(super.hitTest(point, with: event), of: self)
    }

    /// Where the rows stand: this view less the safe area's sides, so a
    /// phone held sideways keeps them off the camera.
    private var band: CGRect { sidesBand }

    /// The list in its band, laid out now: a new width goes in place,
    /// before an apply that brings rows or insets.
    private func resizeList() {
        let band = band
        guard band.width > 0 else { return }
        if edge.frame != band { edge.frame = band }
        list.resize(to: CGRect(origin: edge.bounds.origin, size: band.size))
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        // Leaving the screen mid-hold: nothing is left behind in the window.
        if newWindow == nil {
            hold?.close(animated: false)
            closeSwipe(animated: false)
        }
    }

    // MARK: Rows

    /// Shows `rows`. They are laid out and drawn off the main thread; the
    /// list takes them in one apply, touching only the rows that changed.
    func apply(_ rows: [Row]) {
        dispatchPrecondition(condition: .onQueue(.main))
        // A row in a finger's hand stays where the finger put it: what came
        // meanwhile shows once it is set down.
        guard carry == nil, landing == nil else {
            heldRows = rows
            return
        }
        self.rows = rows
        update()
    }

    /// Until the rows last given are on the list, measured and drawn
    /// (a second at most).
    func settle() async {
        if requested != prepared?.input { await withCheckedContinuation { waiters.append($0) } }
        let deadline = CACurrentMediaTime() + 1
        while CACurrentMediaTime() < deadline {
            let ids = prepared?.identities ?? []
            let shown = list.items.map(\.identity) == ids
            // A row redrawn takes its new item once it is measured.
            let current = list.loadedItemViews.allSatisfy { view in
                guard let view = view as? SidebarItemView else { return true }
                return items[view.row.id] === view.item
            }
            if shown, current, ids.isEmpty || list.loadedItemViews.allSatisfy(\.isDisplayReady) { return }
            try? await Task.sleep(for: .milliseconds(16))
        }
    }

    private func update() {
        guard band.width > 0 else { return }
        let traits = traitCollection
        let input = Input(
            rows: rows, width: band.width, dark: traits.userInterfaceStyle == .dark,
            displayScale: traits.displayScale > 0 ? traits.displayScale : 3,
            selected: selectedRowId, notice: notice
        )
        guard input != requested else { return }
        requested = input
        pipeline.update { $0 = input }
    }

    /// The rows laid out as grouped cards at `input`'s width, each slot's
    /// drawing, and a new revision only for a slot that draws differently.
    nonisolated static func derive(_ input: Input, previous: Prepared?) -> Prepared {
        typealias G = GroupedSidebarMetrics
        let layoutRows = SidebarView.layoutRows(input.rows, scale: input.displayScale)
        let result = SidebarLayout.layout(layoutRows, width: input.width, top: G.contentTop, bottom: G.contentBottom, scale: input.displayScale, style: .grouped)
        let slots = SidebarLayout.slots(layoutRows, result, width: input.width)
        var old: [String: Entry] = [:]
        for entry in previous?.entries ?? [] { old[entry.row.id] = entry }
        var sequence = previous?.sequence ?? 0
        // The notice heads the content; the rows start under it.
        let notice = input.notice.map { text -> Notice in
            let layout = BannerLayout(width: input.width, title: SidebarNoticeItem.title(text, scale: input.displayScale), detail: nil, button: nil)
            if let kept = previous?.notice, kept.text == text, kept.layout == layout { return kept }
            sequence += 1
            return Notice(text: text, layout: layout, revision: sequence)
        }
        let below = notice?.layout.size.height ?? 0
        let entries = slots.map { slot -> Entry in
            let row = input.rows[slot.row]
            let drawing = SidebarItemDrawing(
                row: row, frame: SidebarLayout.local(result.frames[slot.row], top: slot.frame.minY),
                selected: row.id == input.selected, dark: input.dark, displayScale: input.displayScale
            )
            var entry = Entry(row: row, size: slot.frame.size, box: slot.box, top: below + slot.frame.minY, drawing: drawing, revision: 0, titleRun: drawing.shimmers ? drawing.titleAdvance() : nil)
            if let kept = old[row.id], kept.drawing == drawing, kept.size == entry.size {
                entry.revision = kept.revision
            } else {
                sequence += 1
                entry.revision = sequence
            }
            return entry
        }
        return Prepared(input: input, entries: entries, notice: notice, contentHeight: below + result.contentHeight, sequence: sequence)
    }

    private func show(_ next: Prepared) {
        let previousIDs = prepared?.identities
        let target = startsEachChangeAtTop ? top(next, previous: previousIDs) : opening(next) ?? anchor(next)
        prepared = next
        var shown: [any ListRow] = []
        if let notice = next.notice {
            let item = noticeItem.flatMap { $0.revision == notice.revision ? $0 : nil } ?? SidebarNoticeItem(notice: notice)
            noticeItem = item
            shown.append(item)
        } else {
            noticeItem = nil
        }
        var kept: [String: SidebarItem] = [:]
        var touched = 0
        // The slots at another width, laid out together when a row first asks.
        let input = next.input
        replan = ListReplan { width in
            var input = input
            input.width = width
            return Dictionary(Self.derive(input, previous: nil).entries.map { ($0.row.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        for entry in next.entries {
            let item: SidebarItem
            if let existing = items[entry.row.id], existing.revision == entry.revision {
                // Drawn the same: a row that changed only what isn't drawn
                // keeps its node, so it is neither measured nor drawn again.
                item = existing.entry.row == entry.row ? existing : SidebarItem(entry: entry, owner: self, node: existing.node)
            } else {
                item = SidebarItem(entry: entry, owner: self)
                touched += 1
            }
            shown.append(item)
            kept[entry.row.id] = item
        }
        items = kept
        let structural = previousIDs != nil && previousIDs != next.identities
        let animated = structural && !startsEachChangeAtTop && window != nil && !UIAccessibility.isReduceMotionEnabled
        if animated, next.notice == nil, previousIDs?.first == SidebarNoticeItem.id { departNotice() }
        resizeList()
        ApplyPerf.measure(.homeList) {
            list.applyChanges(items: shown, newSize: band.size, scrollTo: target, anchorMode: .automatic, compensatesInsetChange: false, transition: animated ? .easeInOut(0.25) : .none)
            // A notice coming in slides down from above with the rows it
            // pushes, rather than fading in over them where they were.
            if animated, next.notice != nil, previousIDs?.first != SidebarNoticeItem.id {
                list.animateInsertedBlock(identities: [SidebarNoticeItem.id], from: .top, transition: .easeInOut(0.25))
            }
            return touched
        }
        edge.contentSize = CGSize(width: band.width, height: next.contentHeight)
        mirror()
        hideCarried()
        if carry != nil { follow() }
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume() }
    }

    /// The notice going: UltraList fades a departing top row where it
    /// stood, over the rows rising into its room. Instead its picture rises
    /// with them into the bar, on the list's curve, fading, and what the
    /// list fades is empty.
    private func departNotice() {
        guard let view = list.loadedItemViews.lazy.compactMap({ $0 as? SidebarNoticeView }).first,
              let ghost = view.snapshotView(afterScreenUpdates: false) else { return }
        ghost.frame = view.convert(view.bounds, to: edge)
        ghost.isUserInteractionEnabled = false
        ghost.accessibilityIdentifier = SidebarNoticeView.leavingIdentifier
        edge.addSubview(ghost)
        view.isLeaving = true
        let rise = view.bounds.height
        let animator = UIViewPropertyAnimator(duration: 0.25, controlPoint1: CGPoint(x: 0.42, y: 0), controlPoint2: CGPoint(x: 0.58, y: 1)) {
            ghost.frame.origin.y -= rise
            ghost.alpha = 0
        }
        animator.addCompletion { _ in ghost.removeFromSuperview() }
        animator.startAnimation()
    }

    /// The reader's place, kept: rows that changed above what is on screen
    /// would otherwise push everything under the eye (a conversation added
    /// or archived elsewhere, Prioritizing's reordering). The unchanged row
    /// `SidebarScrollAnchor` picks stays where it is; at its top the list
    /// stays at its top, so arrivals show. The notice is one of the rows
    /// here: coming or going above the screen, it moves nothing on it.
    private func anchor(_ next: Prepared) -> ListScrollTarget? {
        guard let previous = prepared, !previous.identities.isEmpty, bounds.height > 0, !isAtTop else { return nil }
        let ids = previous.identities
        let nextIDs = next.identities
        guard ids != nextIDs || previous.notice?.layout.size != next.notice?.layout.size else { return nil }
        let offset = contentOffsetY
        let viewport = CGRect(x: 0, y: offset + contentInsets.top, width: bounds.width, height: bounds.height - contentInsets.top - contentInsets.bottom)
        let boxes = previous.boxes
        let nextBoxes = next.boxes
        guard let index = SidebarScrollAnchor.index(previous: ids, next: nextIDs, boxes: boxes, nextBoxes: nextBoxes, viewport: viewport),
              let nextIndex = nextIDs.firstIndex(of: ids[index]), let nextTop = next.top(at: nextIndex) else { return nil }
        let moved = nextBoxes[nextIndex].minY - boxes[index].minY
        let top = -contentInsets.top
        let bottom = max(top, next.contentHeight + contentInsets.bottom - bounds.height)
        let place = min(bottom, max(top, offset + moved))
        // The anchor's slot top lands this far past the inset's edge.
        return ListScrollTarget(index: nextIndex, identity: nextIDs[nextIndex], pointOffset: nextTop - place - contentInsets.top)
    }

    /// The first rows, where the list was left (`opensAt`).
    private func opening(_ next: Prepared) -> ListScrollTarget? {
        guard let place = opensAt, !next.entries.isEmpty, bounds.height > 0 else { return nil }
        opensAt = nil
        return next.identities.firstIndex(of: place.rowId).map { ListScrollTarget(index: $0, identity: place.rowId, pointOffset: Double(place.top)) }
    }

    /// Other rows than before: the first at the top, where a scroll view
    /// given new content would be put back.
    private func top(_ next: Prepared, previous: [String]?) -> ListScrollTarget? {
        let ids = next.identities
        guard let first = ids.first, previous != nil, previous != ids else { return nil }
        return ListScrollTarget(index: 0, identity: first, pointOffset: 0)
    }

    // MARK: Place

    /// Where the rows start and end, under the bar and above the toolbar,
    /// and the indicator's run. `keepsTop`: the list rests at its top and
    /// stays there; otherwise what is on screen stays where it is.
    func setInsets(_ insets: UIEdgeInsets, indicator: UIEdgeInsets, keepsTop: Bool) {
        edge.verticalScrollIndicatorInsets = indicator
        guard insets != contentInsets else { return }
        contentInsets = insets
        edge.contentInset = insets
        resizeList()
        list.applyChanges(newSize: band.width > 0 ? band.size : nil, newInsets: .init(top: insets.top, bottom: insets.bottom), anchorMode: keepsTop ? .automatic : .preserveVisibleContent, compensatesInsetChange: keepsTop, transition: .none)
        mirror()
    }

    /// The list's place as a scroll view's `contentOffset.y`: `-top` at rest
    /// at its top, less past it under a pull, more as it is read down.
    var contentOffsetY: CGFloat {
        guard let prepared else { return -contentInsets.top }
        for index in list.loadedIndexRange {
            guard let top = prepared.top(at: index), let frame = list.settledFrame(at: index) else { continue }
            return top - frame.minY
        }
        return -contentInsets.top
    }

    var isAtTop: Bool { contentOffsetY <= -contentInsets.top + 1 }

    /// The row read at the top and how far its top is under the inset, to
    /// open there again (`opensAt`); nil at the top.
    var place: (rowId: String, top: CGFloat)? {
        guard !isAtTop else { return nil }
        for index in list.loadedIndexRange {
            guard list.items[index] is SidebarItem, let frame = list.settledFrame(at: index), frame.maxY > contentInsets.top else { continue }
            return (list.items[index].identity, frame.minY - contentInsets.top)
        }
        return nil
    }

    /// The finger's pan that moves the list.
    var panGestureRecognizer: UIPanGestureRecognizer? {
        list.contentView.gestureRecognizers?.lazy.compactMap { $0 as? UIPanGestureRecognizer }.first { $0.minimumNumberOfTouches == 1 }
    }
    var isDragging: Bool { list.isDragging }
    var isDecelerating: Bool { list.isDecelerating }
    var isTracking: Bool { list.isTracking }

    /// Straight to the top, or gliding there.
    func scrollToTop(animated: Bool) {
        list.scrollToTop(animated: animated)
    }

    /// Moves the list to `offset` (a scroll view's `contentOffset.y`), at
    /// once or gliding there.
    func setContentOffsetY(_ offset: CGFloat, animated: Bool = false) {
        setContentOffsetY(offset, transition: animated ? .uiKitScroll() : .immediate)
    }

    private func setContentOffsetY(_ offset: CGFloat, transition: ListTransition) {
        guard let prepared else { return }
        let ids = prepared.identities
        guard !ids.isEmpty else { return }
        // Item `index`'s top lands `offset` past the inset's edge: its content
        // place, less where the screen starts in the content.
        let index = ids.indices.last { (prepared.top(at: $0) ?? 0) <= max(0, offset + contentInsets.top) } ?? 0
        let distance = (prepared.top(at: index) ?? 0) - offset - contentInsets.top
        list.scrollTo(ListScrollTarget(index: index, identity: ids[index], pointOffset: distance), transition: transition)
        mirror()
    }

    /// Brings the row that opens `agentId` to the middle of the list,
    /// gliding as a finger's scroll would (at once when `glides` is
    /// false), and returns its view once the list stands still, with how
    /// long the glide took. A row wholly on screen leaves the list where
    /// it is; nil for one the list doesn't have.
    func reveal(agentId: String, glides: Bool) async -> (view: SidebarItemView, scrolled: Double)? {
        guard let prepared, let row = prepared.entries.firstIndex(where: { $0.row.agentId == agentId && $0.row.kind != .section }) else { return nil }
        let entry = prepared.entries[row]
        let box = entry.box.offsetBy(dx: 0, dy: entry.top)
        let offset = contentOffsetY
        let margin: CGFloat = 12
        let shown = bounds.height - contentInsets.top - contentInsets.bottom
        var scrolled = 0.0
        if box.minY < offset + contentInsets.top + margin || box.maxY > offset + contentInsets.top + shown - margin {
            let lowest = -contentInsets.top
            let highest = max(lowest, prepared.contentHeight - bounds.height + contentInsets.bottom)
            let wanted = box.midY - contentInsets.top - shown / 2
            let target = min(max(wanted, lowest), highest)
            let distance = abs(target - offset)
            if distance > 0.5 {
                // A short way is quick; a long one takes a little longer, never past 0.6 s.
                scrolled = glides ? min(0.6, 0.3 + Double(distance) / 4000) : 0
                list.haltScrolling()
                setContentOffsetY(target, transition: glides ? .uiKitScroll(scrolled) : .immediate)
                if glides { try? await Task.sleep(for: .seconds(scrolled + 0.03)) }
                layoutIfNeeded()
            }
        }
        // Its view is mounted within a frame or two of the list stopping.
        for _ in 0..<12 where view(for: entry.row.id) == nil { try? await Task.sleep(for: .milliseconds(16)) }
        return view(for: entry.row.id).map { ($0, scrolled) }
    }

    private func scrolled() {
        if list.isDecelerating, !list.isTracking { glidedAt = CACurrentMediaTime() }
        mirror()
        flashIndicator(force: false)
        onScroll?()
    }

    /// The edge follows the list, so the bar's shade and the indicator read
    /// its place.
    private func mirror() {
        let offset = contentOffsetY
        guard abs(edge.contentOffset.y - offset) > 0.01 else { return }
        edge.contentOffset.y = offset
        // The list stays where it is on screen.
        list.frame.origin = edge.bounds.origin
        onMove?()
    }

    /// While the list moves under a finger or glides, the indicator shows.
    private func flashIndicator(force: Bool) {
        guard force || list.isTracking || list.isDecelerating || list.isDragging else { return }
        let now = CACurrentMediaTime()
        guard force || now - indicatorFlashed > 0.4 else { return }
        indicatorFlashed = now
        edge.flashScrollIndicators()
    }

    /// The list glides on with no finger on it: a touch now only stops it.
    var isGliding: Bool {
        list.isDecelerating && !list.isTracking || CACurrentMediaTime() - glidedAt < 0.05
    }
    private var glidedAt: CFTimeInterval = 0

    // MARK: Reading

    /// The rows on the list now, near the screen.
    var mountedViews: [SidebarItemView] { list.loadedItemViews.compactMap { $0 as? SidebarItemView } }

    func view(for rowId: String) -> SidebarItemView? { mountedViews.first { $0.row.id == rowId } }

    /// The rows shown, in the order drawn.
    var shownRows: [Row] { rows }

    /// The places among `shownRows` on screen now; nil before they are drawn.
    var visibleRange: ClosedRange<Int>? {
        let on = visibleEntries.compactMap { entry in rows.firstIndex { $0.id == entry.row.id } }
        guard let first = on.min(), let last = on.max() else { return nil }
        return first...last
    }

    /// The rows on screen now, top first.
    var visibleRows: [Row] { visibleEntries.map(\.row) }

    private var visibleEntries: [Entry] {
        guard let prepared else { return [] }
        let window = bounds.inset(by: UIEdgeInsets(top: contentInsets.top, left: 0, bottom: contentInsets.bottom, right: 0))
        return list.loadedIndexRange.compactMap { index in
            guard let row = prepared.row(at: index), let frame = list.settledFrame(at: index) else { return nil }
            let entry = prepared.entries[row]
            return entry.box.offsetBy(dx: frame.minX, dy: frame.minY).intersects(window) ? entry : nil
        }
    }

    // MARK: Touch

    /// A press began on `view`'s row.
    func pressed(_ view: SidebarItemView) {
        guard onSelect != nil, hold == nil, swiped == nil, carry == nil else { return }
        onIntent?(view.row)
    }

    /// Whether a press lights `row`: it opens something.
    func lightsOnPress(_ row: Row) -> Bool {
        guard hold == nil, swiped == nil, carry == nil else { return false }
        return row.kind == .section ? false : onSelect != nil
    }

    /// A tap on `view` at `point`, in the view.
    func tap(_ view: SidebarItemView, at point: CGPoint) {
        // The touch that opened a hold, let go: the hold stays and that is all.
        guard hold == nil, carry == nil, CACurrentMediaTime() - carriedAt > 0.3 else { return }
        // A row stands swiped open: a tap on its action does it, any other
        // tap only puts it back.
        if let open = swiped {
            if open === view, view.isOnAction(point) { archive(view) } else { closeSwipe() }
            return
        }
        let row = view.row
        switch row.kind {
        case .section, .separator:
            // Home folds nothing.
            break
        default:
            onSelect?(row)
        }
    }

    /// Telegram's hold: the screen blurs, the row's conversation grows out
    /// of it with the menu under it, and a light tap is felt. A row with
    /// neither a menu nor a conversation shows nothing.
    ///
    /// A bot or task that moves lifts at once instead (`holdCarries`),
    /// under the finger at `point`, in this view.
    func openHold(_ view: SidebarItemView, at point: CGPoint? = nil) {
        closeSwipe()
        guard hold == nil, carry == nil, let window else { return }
        let row = view.row
        if Self.holdCarries, carries(row) {
            lift(view, at: point ?? view.convert(CGPoint(x: view.box.midX, y: view.box.midY), to: self))
            return
        }
        let items = menu?(row) ?? []
        let preview = preview?(row)
        guard !items.isEmpty || preview != nil else { return }
        Haptics.play(.hold)
        let source = view.convert(view.box, to: window)
        // The row as it rests, not pressed.
        view.pressed = false
        let snapshot = preview == nil ? view.resizableSnapshotView(from: view.box, afterScreenUpdates: true, withCapInsets: .zero) : nil
        let overlay = HoldOverlay(window: window, items: items, preview: preview, source: source, snapshot: snapshot)
        overlay.onOpen = { [weak self] in self?.onOpenPreview?(row) }
        overlay.onLeave = { [weak self, weak overlay] in
            if self?.hold === overlay { self?.hold = nil }
        }
        hold = overlay
        // Under the blur the list holds still.
        for pan in list.contentView.gestureRecognizers ?? [] where pan is UIPanGestureRecognizer {
            pan.isEnabled = false
            pan.isEnabled = true
        }
        list.haltScrolling()
        overlay.present()
    }

    /// What VoiceOver offers on `row`: its hold's menu, and Archive where
    /// it swipes.
    func actions(for view: SidebarItemView) -> [UIAccessibilityCustomAction] {
        var actions = (menu?(view.row) ?? []).joined().map { item in
            UIAccessibilityCustomAction(name: item.title, image: Glyphs.image(item.icon)) { _ in
                item.run()
                return true
            }
        }
        let row = view.row
        if swipes(row) {
            actions.append(UIAccessibilityCustomAction(name: Strings.archive) { [weak self] _ in
                self?.onArchive?(row)
                return true
            })
        }
        return actions
    }

    // MARK: Swipe

    /// Whether `row` swipes to Archive: a bot or task the person may archive,
    /// on a list that archives.
    func swipes(_ row: Row) -> Bool {
        onArchive != nil && row.canArchive && SidebarReorder.movable(row) && hold == nil && carry == nil
    }

    /// A swipe began on `view`: any other row standing open closes.
    func swipeBegan(_ view: SidebarItemView) {
        if let other = swiped, other !== view { other.setReveal(0, full: false, animated: true) }
        swiped = view
    }

    /// The finger let go of `view`'s swipe.
    func swipeEnded(_ view: SidebarItemView, outcome: SidebarSwipeLayout.Outcome) {
        switch outcome {
        case .closed:
            view.setReveal(0, full: false, animated: true)
            if swiped === view { swiped = nil }
        case .open:
            view.setReveal(SidebarSwipeLayout.reveal(.open, width: view.box.width), full: false, animated: true)
            swiped = view
        case .full:
            archive(view)
        }
    }

    /// Archives `view`'s row: its action fills it, then it goes as the
    /// list loses it. One the list still has a moment later (the phone
    /// could not keep the archive) closes again.
    private func archive(_ view: SidebarItemView) {
        let row = view.row
        if swiped === view { swiped = nil }
        Haptics.play(.putAway)
        view.setReveal(view.box.width, full: true, animated: true) { [weak self, weak view] in
            self?.onArchive?(row)
            Task { @MainActor [weak self, weak view] in
                try? await Task.sleep(for: .seconds(1.5))
                guard let self, let view, view.row.id == row.id, view.reveal > 0, rows.contains(where: { $0.id == row.id }) else { return }
                view.setReveal(0, full: false, animated: true)
            }
        }
    }

    /// Puts a row standing swiped open back.
    func closeSwipe(animated: Bool = true) {
        swiped?.setReveal(0, full: false, animated: animated)
        swiped = nil
    }

    // MARK: Carry

    /// A row in a finger's hand: its picture over the list, where the finger
    /// took it, and the rows as they were when it was lifted.
    private final class Carry {
        let rowId: String
        let lifted: [Row]
        let picture: UIView
        /// The row's box in this view when lifted, and the finger's height in it.
        let box: CGRect
        let grab: CGFloat
        var finger: CGFloat
        var link: CADisplayLink?
        var ticked: CFTimeInterval = 0

        init(rowId: String, lifted: [Row], picture: UIView, box: CGRect, grab: CGFloat) {
            self.rowId = rowId
            self.lifted = lifted
            self.picture = picture
            self.box = box
            self.grab = grab
            finger = box.minY + grab
        }
    }

    /// Whether a hold lifts a bot's or task's row at once, with no preview:
    /// for now it does. false: the hold shows the preview, and the row
    /// lifts once the held finger moves (`SidebarCarryLayout.liftDistance`).
    static let holdCarries = true

    /// Whether `row` is carried: a bot or task, on a list that moves them.
    private func carries(_ row: Row) -> Bool {
        onReorder != nil && SidebarReorder.movable(row) && landing == nil
    }

    /// A held finger moved, from `start` to `point` in this view: far enough,
    /// on a bot or task where the list moves them, it lifts the row;
    /// carried, the row follows it.
    func holdMoved(_ view: SidebarItemView, to point: CGPoint, from start: CGPoint) {
        if carry == nil {
            guard carries(view.row), hypot(point.x - start.x, point.y - start.y) >= SidebarCarryLayout.liftDistance else { return }
            lift(view, at: start)
        }
        guard let carry else { return }
        carry.finger = point.y
        follow()
    }

    /// The held finger lifted: a carried row is set down where it is, and the
    /// computer told; `cancelled`, it goes back.
    func holdEnded(_ view: SidebarItemView, cancelled: Bool) {
        guard let carry else { return }
        self.carry = nil
        carry.link?.invalidate()
        carriedAt = CACurrentMediaTime()
        landing = carry.rowId
        // The row's place among its peers now, as a move from where it was.
        var move: SidebarReorder.Move?
        if !cancelled, let index = rows.firstIndex(where: { $0.id == carry.rowId }),
           let place = SidebarReorder.family(rows, at: index)?.firstIndex(where: { $0.lowerBound == index }),
           let from = carry.lifted.firstIndex(where: { $0.id == carry.rowId }) {
            move = SidebarReorder.move(carry.lifted, at: from, to: place)
        }
        Haptics.play(.drop)
        if let move { onReorder?(move) }
        let target = self.view(for: carry.rowId).map { $0.convert($0.box, to: self) } ?? carry.box
        let picture = carry.picture
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            picture.transform = .identity
            picture.center = CGPoint(x: target.midX, y: target.midY)
            picture.layer.shadowOpacity = 0
        } completion: { [weak self] _ in
            picture.removeFromSuperview()
            guard let self else { return }
            landing = nil
            hideCarried()
            // What home sent meanwhile, with the move laid over it until home
            // has it too; else the rows as they were, the row put back.
            let base = heldRows ?? carry.lifted
            heldRows = nil
            rows = move.map { SidebarReorder.moved(base, $0) } ?? base
            update()
        }
    }

    /// Lifts `view`'s row out of the list under the finger that held it at
    /// `start`: its picture grows over the list and its own place empties;
    /// what nests under it folds away until it is set down.
    private func lift(_ view: SidebarItemView, at start: CGPoint) {
        guard let index = rows.firstIndex(where: { $0.id == view.row.id }),
              let unit = SidebarReorder.family(rows, at: index)?.first(where: { $0.lowerBound == index }) else { return }
        hold?.close(animated: false)
        closeSwipe(animated: false)
        view.pressed = false
        let box = view.convert(view.box, to: self)
        // The row's card as it rests, drawn once: a picture, not a live
        // snapshot, so whatever draws the window (a recording) has it too.
        let card = view.box
        let snapshot = UIImageView(image: UIGraphicsImageRenderer(size: card.size).image { _ in
            view.drawHierarchy(in: CGRect(origin: CGPoint(x: -card.minX, y: -card.minY), size: view.bounds.size), afterScreenUpdates: true)
        })
        let picture = UIView(frame: box)
        picture.isUserInteractionEnabled = false
        picture.layer.shadowColor = UIColor.black.cgColor
        picture.layer.shadowRadius = SidebarCarryLayout.shadowRadius
        picture.layer.shadowOffset = CGSize(width: 0, height: SidebarCarryLayout.shadowOffset)
        picture.layer.shadowOpacity = 0
        snapshot.frame = picture.bounds
        snapshot.layer.cornerRadius = GroupedSidebarMetrics.radius
        snapshot.layer.cornerCurve = .continuous
        snapshot.layer.masksToBounds = true
        picture.addSubview(snapshot)
        picture.accessibilityIdentifier = "home-carry"
        addSubview(picture)
        let carry = Carry(rowId: view.row.id, lifted: rows, picture: picture, box: box, grab: start.y - box.minY)
        self.carry = carry
        // The finger carries the row now, not the list.
        for pan in list.contentView.gestureRecognizers ?? [] where pan is UIPanGestureRecognizer {
            pan.isEnabled = false
            pan.isEnabled = true
        }
        list.haltScrolling()
        Haptics.play(.lift)
        UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
            picture.transform = CGAffineTransform(scaleX: SidebarCarryLayout.liftScale, y: SidebarCarryLayout.liftScale)
            picture.layer.shadowOpacity = SidebarCarryLayout.shadowOpacity
        }
        hideCarried()
        let link = CADisplayLink(target: CarryTicker(self), selector: #selector(CarryTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        carry.link = link
        if unit.count > 1 {
            rows.removeSubrange(unit.lowerBound + 1..<unit.upperBound)
            update()
        }
    }

    /// The carried row's picture under the finger, and the row's place
    /// among its peers where the picture's middle now is.
    private func follow() {
        guard let carry else { return }
        let frame = SidebarCarryLayout.frame(box: carry.box, grab: carry.grab, finger: carry.finger, top: contentInsets.top, bottom: bounds.height - contentInsets.bottom)
        carry.picture.center = CGPoint(x: frame.midX, y: frame.midY)
        // Until the list shows the rows last given, their places are not known.
        guard let prepared, prepared.input.rows == rows, let index = rows.firstIndex(where: { $0.id == carry.rowId }),
              let units = SidebarReorder.family(rows, at: index), let from = units.firstIndex(where: { $0.lowerBound == index }) else { return }
        var spans: [String: CGRect] = [:]
        for entry in prepared.entries { spans[entry.row.id] = entry.box.offsetBy(dx: 0, dy: entry.top) }
        let peers = units.enumerated().filter { $0.offset != from }.compactMap { _, unit -> ClosedRange<CGFloat>? in
            guard let first = spans[rows[unit.lowerBound].id], let last = spans[rows[unit.upperBound - 1].id] else { return nil }
            return first.minY...last.maxY
        }
        guard peers.count == units.count - 1 else { return }
        // The picture's middle in the content: the list's place under it.
        let center = convert(CGPoint(x: frame.midX, y: frame.midY), to: list).y + contentOffsetY
        let place = SidebarCarryLayout.place(center: center, peers: peers)
        guard let move = SidebarReorder.move(rows, at: index, to: place) else { return }
        rows = SidebarReorder.moved(rows, move)
        Haptics.play(.slot)
        update()
    }

    /// One frame of a carry: held near the view's top or bottom, the list
    /// scrolls under the row.
    fileprivate func tick(_ link: CADisplayLink) {
        guard let carry else { return link.invalidate() }
        let elapsed = carry.ticked == 0 ? 0 : min(link.timestamp - carry.ticked, 0.05)
        carry.ticked = link.timestamp
        let frame = SidebarCarryLayout.frame(box: carry.box, grab: carry.grab, finger: carry.finger, top: contentInsets.top, bottom: bounds.height - contentInsets.bottom)
        let speed = SidebarCarryLayout.scrollSpeed(frame: frame, top: contentInsets.top, bottom: bounds.height - contentInsets.bottom)
        guard speed != 0, elapsed > 0, let prepared else { return }
        let lowest = -contentInsets.top
        let highest = max(lowest, prepared.contentHeight + contentInsets.bottom - bounds.height)
        let offset = contentOffsetY
        let next = min(max(offset + speed * CGFloat(elapsed), lowest), highest)
        guard abs(next - offset) > 0.1 else { return }
        setContentOffsetY(next)
        follow()
    }

    /// The carried row's own view stays hidden under its picture, whichever
    /// view shows it as the list mounts rows.
    private func hideCarried() {
        let shown = (carry?.rowId ?? landing).flatMap(view(for:))
        if hiddenView !== shown { hiddenView?.isCarried = false }
        hiddenView = shown
        shown?.isCarried = true
    }
}

/// The carry's display link, which holds its target strongly: this holds
/// the list weakly.
@MainActor
private final class CarryTicker: NSObject {
    weak var list: SidebarList?
    init(_ list: SidebarList) { self.list = list }
    @objc func tick(_ link: CADisplayLink) {
        guard let list else { return link.invalidate() }
        list.tick(link)
    }
}


/// The scroll view home's bar shades: it holds the list, never scrolls
/// under a finger, and follows the list's place and size.
final class SidebarListEdge: UIScrollView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        // The list inside takes the touches; this only follows it.
        isScrollEnabled = false
        panGestureRecognizer.isEnabled = false
        backgroundColor = .clear
        contentInsetAdjustmentBehavior = .never
        automaticallyAdjustsScrollIndicatorInsets = false
        showsHorizontalScrollIndicator = false
        // The list answers the status bar.
        scrollsToTop = false
        isAccessibilityElement = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

/// One row of home's list: its slot's size and drawing, and the row it shows.
@MainActor
final class SidebarItem: ListRow {
    let identity: String
    let revision: UInt64
    let entry: SidebarList.Entry
    let node: NodeRow
    weak var owner: SidebarList?
    /// The list's slots at another width (`SidebarList.replan`).
    var replan: ListReplan<SidebarList.Entry>? { owner?.replan }
    var measuresAsynchronously: Bool { true }
    /// A slot is as tall as its kind's row, at any width.
    var hasFixedHeight: Bool { true }

    /// `node`: the one an item of the same revision already drew, for a
    /// row that changed only what isn't drawn.
    init(entry: SidebarList.Entry, owner: SidebarList, node: NodeRow? = nil) {
        identity = entry.row.id
        revision = entry.revision
        self.entry = entry
        self.owner = owner
        self.node = node ?? NodeRow(identity: entry.row.id, revision: entry.revision) { Self.root(entry) }
    }

    /// The revision is what is drawn; the row itself changes more often
    /// (a tap opens where it says), and its view takes the new row in place.
    func isEqual(to other: any ListRow) -> Bool {
        guard let other = other as? SidebarItem else { return false }
        return identity == other.identity && revision == other.revision && entry.row == other.entry.row
    }

    private nonisolated static func root(_ entry: SidebarList.Entry) -> UltraNode {
        var style = Style()
        style.height = .points(entry.size.height)
        let root = UltraNode(style: style)
        root.drawing = entry.drawing
        return root
    }

    /// The slot as the list shows it at `width`: its own, or the one made
    /// there for a width change, once it is made.
    func entry(at width: Double) -> SidebarList.Entry {
        guard abs(width - entry.size.width) > 0.5, let replan else { return entry }
        return replan.made(identity, width: CGFloat(width)) ?? entry
    }

    /// The node row at `width`: its own, or one that lays the slot out
    /// again there before it is measured and drawn.
    private func node(at width: Double) -> NodeRow {
        guard let replan, abs(width - entry.size.width) > 0.5 else { return node }
        let id = identity, kept = entry
        return NodeRow(identity: identity, revision: revision) {
            Self.root(replan.value(id, width: CGFloat(width)) ?? kept)
        }
    }

    func prepare(width: Double, environment: RenderEnvironment) async -> ListPreparation? { await node(at: width).prepare(width: width, environment: environment) }
    func prepareInPlace(width: Double, environment: RenderEnvironment) -> ListInPlacePreparation? { node(at: width).prepareInPlace(width: width, environment: environment) }
    func makeView() -> ListRowView { SidebarItemView(item: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? SidebarItemView)?.apply(self, transition: transition) }
}

/// The notice at the top of home's list: the last thing the computer
/// refused, in a quiet card (`BannerLayout`), measured off the main thread
/// with the rows.
@MainActor
final class SidebarNoticeItem: ListRow {
    nonisolated static let id = "home:notice"
    let identity = SidebarNoticeItem.id
    let revision: UInt64
    let notice: SidebarList.Notice

    init(notice: SidebarList.Notice) {
        self.notice = notice
        revision = notice.revision
    }

    static var font: UIFont { Fonts.ui(.semiBold, size: 15) }

    /// The title's size at a width, on any thread, rounded up to `scale`'s pixels.
    nonisolated static func title(_ text: String, scale: CGFloat) -> Measurable {
        let string = NSAttributedString(string: text, attributes: [.font: Fonts.ui(.semiBold, size: 15)])
        return Measurable { width in
            let size = string.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).size
            return CGSize(width: min(width, (size.width * scale).rounded(.up) / scale), height: (size.height * scale).rounded(.up) / scale)
        }
    }

    func makeView() -> ListRowView { SidebarNoticeView(item: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? SidebarNoticeView)?.apply(self) }
}

/// The notice's card on the list, its frames worked out off the main thread.
@MainActor
final class SidebarNoticeView: ListRowView {
    private(set) var item: SidebarNoticeItem
    private let card = UIView()
    let title = UILabel()

    init(item: SidebarNoticeItem) {
        self.item = item
        super.init(frame: .zero)
        card.backgroundColor = UIColor(Palette.rowSelected)
        card.layer.cornerRadius = 12
        card.layer.cornerCurve = .continuous
        addSubview(card)
        title.font = SidebarNoticeItem.font
        title.textColor = UIColor(Palette.rowTextActive)
        title.numberOfLines = 0
        card.addSubview(title)
        // VoiceOver reads the card as one line, the list's first.
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        accessibilityIdentifier = "home-notice"
        apply(item)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The picture of a notice rising away (`SidebarList.departNotice`).
    static let leavingIdentifier = "home-notice-leaving"

    /// Gone from the list: its picture rises in its place, so it draws nothing.
    var isLeaving = false {
        didSet {
            card.isHidden = isLeaving
            isAccessibilityElement = !isLeaving
        }
    }

    func apply(_ item: SidebarNoticeItem) {
        self.item = item
        isLeaving = false
        title.text = item.notice.text
        accessibilityLabel = item.notice.text
        setNeedsLayout()
    }

    override func update(width: Double, transition: ListTransition) -> Double { item.notice.layout.size.height }

    override func layoutSubviews() {
        super.layoutSubviews()
        card.frame = item.notice.layout.card
        title.frame = item.notice.layout.title
    }
}
#endif
