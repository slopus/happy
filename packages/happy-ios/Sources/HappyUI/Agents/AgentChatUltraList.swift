#if canImport(UIKit)
import HappyLayout
import UIKit
import UltraView

/// The screen a transcript's rows belong to: it planned them, and a row's
/// cards, media and what VoiceOver reads of it are still its to set.
@MainActor
protocol AgentChatTranscriptHost: AnyObject {
    /// `view` is to show `plan`.
    func show(_ plan: ChatRowPlan, in view: ChatPlanView)
    /// A tall row's chunks came or went: what is over them, and what
    /// VoiceOver reads of them, is to be placed again.
    func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView)
    func transcriptScrolled()
    func transcriptWillBeginDragging()
    func transcriptDidEndDragging()
    func transcriptTapped(_ action: ChatRowAction)
    func transcriptOpened(_ url: String)
    func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint)
}

/// The agents' transcript on UltraList. Each row is drawn by a
/// `ChatPlanView` from its plan, which the screen shows (`show`), so its
/// cards, media, hit testing and VoiceOver are the screen's; the library
/// keeps the rows near the screen and moves them.
///
/// The list is turned upside down, as the library's own chat is and as the
/// sessions' chat is (`ChatListView`): rows go in newest first,
/// which reads as the newest at the foot, resting on the composer. The
/// screen keeps planning them oldest first and hands them over that way.
@MainActor
final class AgentChatUltraList: UIView {
    let list = UltraListView(engineMode: .keyframe)
    weak var host: AgentChatTranscriptHost?
    /// The reader reached the oldest row the conversation has read: there
    /// may be more behind it.
    var onReachedOldest: (() -> Void)?
    private(set) var isActive = true
    private var rows: [String: AgentChatRow] = [:]
    /// Where each row starts, measured up from the newest end: the list
    /// keeps only a window of rows, so their places are worked out here.
    private var starts: [String: CGFloat] = [:]
    private var revision: UInt64 = 0
    private var insets = UIEdgeInsets.zero
    private var viewportSize = CGSize.zero
    private var contentHeight: CGFloat = 0
    /// What the list was last given: its rows, and the room a preview's
    /// newest row was placed in.
    private struct Submission: Equatable {
        struct Row: Equatable { var identity: String; var revision: UInt64 }
        var rows: [Row]
        var room: CGFloat?
    }
    private var submitted: Submission?
    /// The newest row is at the foot and the reader is on it.
    private(set) var followsNewest = true
    /// A preview's: the newest row, taller than the room it has, shows
    /// from its start rather than its end.
    var showsNewestFromItsStart = false
    /// As close to the newest row as counts as on it, 24pt, not the
    /// sessions' 200.
    static let followThreshold: CGFloat = 24
    /// A send flying in from the composer: the row it waits for is
    /// veiled from the pass that inserts it until the copy lands.
    var flight: ChatSendFlight? {
        didSet {
            oldValue?.cancel()
            flight?.onFinish = { [weak self, weak flight] in
                guard let self, self.flight === flight else { return }
                self.flight = nil
                self.unveil()
            }
        }
    }
    private(set) var veiled: String?
    /// A reply still arriving comes out a character at a time.
    let reveal = ChatRevealDriver()
    /// What `apply` was last handed, to hand over again as a revealing
    /// row grows a line.
    private var latest: (plans: [ChatRowPlan], intro: (view: UIView, height: CGFloat)?)?
    /// Rows planned again at a new width for the pass that shows it
    /// (`showInPlace`), by identity, each with the plan it stands in for:
    /// the screen's own plans at that width replace them.
    private var inPlace: [String: (replaces: ChatRowPlan, plan: ChatRowPlan)] = [:]

    /// The rows near the screen, by plan ID, newest first: those the list
    /// has loaded and a few past them, which a new width may bring on.
    var planIDsNearScreen: [String] {
        let loaded = list.loadedIndexRange
        guard !loaded.isEmpty else { return [] }
        return (loaded.lowerBound..<min(list.items.count, loaded.upperBound + 8)).compactMap { (list.items[$0] as? AgentChatRow)?.plan.id }
    }

    /// `plans`, by plan ID, made at a new width for the rows shown now: the
    /// pass that lays the rows out at that width shows them (`AgentChatRowView.update`).
    /// A row coming out as it streams keeps its plan.
    func showInPlace(_ plans: [String: ChatRowPlan]) {
        for row in rows.values {
            guard let plan = plans[row.plan.id], plan !== row.plan, !reveal.isRevealing(row.identity) else { continue }
            inPlace[row.identity] = (row.plan, plan)
        }
    }

    /// The plan `row` shows at a new width, if one was made for it.
    func inPlacePlan(for row: AgentChatRow) -> ChatRowPlan? {
        inPlace[row.identity].flatMap { $0.replaces === row.plan ? $0.plan : nil }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        list.contentView.transform = ChatListView.flip
        list.keyboardDismissMode = .interactive
        list.accessibilityIdentifier = "transcript"
        list.onScroll = { [weak self] _ in self?.scrolled() }
        list.onVisibleWindowChanged = { [weak self] in self?.scrolled() }
        list.willBeginDragging = { [weak self] in self?.host?.transcriptWillBeginDragging() }
        list.didEndDragging = { [weak self] in self?.host?.transcriptDidEndDragging() }
        // Upside down, the oldest row is at the list's far end.
        list.onLoadedEdgeReached = { [weak self] edge in
            guard let self, isActive, edge == .bottom else { return }
            onReachedOldest?()
        }
        addSubview(list)
        reveal.host = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        list.frame = bounds
    }

    /// The room the rows have between the bar and the composer.
    var viewportHeight: CGFloat { max(0, bounds.height - insets.top - insets.bottom) }

    var distanceFromOldest: CGFloat { max(0, contentHeight - viewportHeight - distanceFromNewest) }

    /// How far the reader is from the newest row, which is at the foot:
    /// zero on it, growing as they read up into history, from the first
    /// row the list has loaded (`ChatUltraListAdapter.visibleMinY`).
    var distanceFromNewest: CGFloat {
        for index in list.loadedIndexRange {
            guard let row = list.items[index] as? AgentChatRow,
                  let start = starts[row.identity],
                  let frame = list.settledFrame(at: index) else { continue }
            return start - frame.minY + insets.top
        }
        return 0
    }

    func setViewport(size: CGSize, insets: UIEdgeInsets, keyboard: ChatUltraKeyboard.Change? = nil) {
        guard size.width > 0, size.height > 0 else { return }
        let sizeChanged = viewportSize != size
        let changed = self.insets != insets || sizeChanged
        if abs(viewportSize.width - size.width) > 0.5 {
            // New insets first, at the old width, then the new width alone:
            // the rows the change puts on screen are laid out again in
            // place (`showInPlace`), where the new insets put them, on the
            // curve of the animation it is in.
            if self.insets != insets {
                self.insets = insets
                list.applyChanges(newInsets: .init(top: insets.top, bottom: insets.bottom), anchorMode: .preserveVisibleContent,
                                  compensatesInsetChange: keyboard?.compensates ?? !list.isTracking, transition: keyboard?.transition ?? .none)
            }
            list.resize(to: CGRect(origin: list.frame.origin, size: size))
            viewportSize = size
            flight?.follow(in: list)
            return
        }
        self.insets = insets
        viewportSize = size
        guard changed else {
            if keyboard?.finishes == true { list.finishViewportTransition() }
            return
        }
        list.applyChanges(newSize: keyboard == nil || sizeChanged ? size : nil,
                          newInsets: .init(top: insets.top, bottom: insets.bottom),
                          anchorMode: .preserveVisibleContent,
                          compensatesInsetChange: keyboard?.compensates ?? !list.isTracking,
                          transition: keyboard?.transition ?? .none)
        flight?.follow(in: list)
    }

    /// The conversation's rows, oldest first as the screen plans them,
    /// and the intro that opens it, which the screen has laid out. A row
    /// whose plan has not changed keeps the view it had, drawn as it was:
    /// only a new plan is shown again.
    ///
    /// The intro goes in last, which is at the top, scrolling away as the
    /// rows under it fill the screen.
    /// `animated` eases rows in while the newest is followed; `moves` eases
    /// a turn opening or folding wherever the reader is, the rows they see
    /// staying put. `streaming`: the agent is at work, so its newest words
    /// may grow, and come out as they do (`ChatRevealDriver`). The last
    /// `queued` rows are the person's sends waiting under the work: the
    /// agent's newest row is the one above them.
    func apply(_ plans: [ChatRowPlan], intro: (view: UIView, height: CGFloat)? = nil, animated: Bool = false, moves: Bool = false, streaming: Bool = false, queued: Int = 0) {
        if isActive { startReveals(plans.dropLast(queued), streaming: streaming) }
        latest = (plans, intro)
        submit(plans, intro: intro, transition: (animated || moves) && !UIAccessibility.isReduceMotionEnabled ? .easeInOut(0.2) : .none, followOnly: !moves)
    }

    /// Only the newest row comes out as it streams, and only with words
    /// that arrive while the chat is on screen; any other finishes coming
    /// out (`RevealFocus`).
    private func startReveals(_ plans: ArraySlice<ChatRowPlan>, streaming: Bool) {
        var focus: [RevealFocus.Row] = []
        focus.reserveCapacity(plans.count)
        for plan in plans {
            let identity = "chat:row:\(plan.id)"
            focus.append(.init(id: identity, revealable: plan.revealable, change: ChatRevealMapping.change(from: rows[identity]?.plan, to: plan)))
        }
        let steps = reveal.focus(focus, streaming: streaming, onScreen: window != nil)
        // The rows revealing are at the newest end, where the search starts.
        func plan(_ identity: String) -> ChatRowPlan? {
            let id = identity.dropFirst("chat:row:".count)
            return plans.last { $0.revealable && $0.id == id }
        }
        _ = reveal.perform(steps, plan: plan, previous: { [rows] in rows[$0]?.plan })
        reveal.keep { plan($0) != nil }
    }

    private func submit(_ plans: [ChatRowPlan], intro: (view: UIView, height: CGFloat)?, transition: ListTransition, followOnly: Bool) {
        var items: [any ListRow] = []
        var next: [String: AgentChatRow] = [:]
        var places: [String: CGFloat] = [:]
        var start: CGFloat = 0
        // What moves: a row's height or the rows there are, and of that, a
        // revealing row growing a line.
        var moved = false
        var grew = false
        items.reserveCapacity(plans.count + 1)
        var landing: (identity: String, plan: ChatRowPlan)?
        for plan in plans.reversed() {
            let identity = "chat:row:\(plan.id)"
            if rows[identity] == nil, landing == nil, let flight, flight.awaits(plan) {
                landing = (identity, plan)
                veiled = identity
            }
            // A row coming out is as tall as what of it shows.
            let revealing = reveal.height(identity)
            let height = revealing ?? plan.size.height
            if let kept = rows[identity], kept.height != height {
                if revealing != nil { grew = true } else { moved = true }
            }
            let row: AgentChatRow
            if let kept = rows[identity], kept.plan === plan, kept.height == height {
                row = kept
            } else {
                // A revision is never reused, even where an identity comes back.
                revision &+= 1
                row = AgentChatRow(identity: identity, revision: revision, plan: plan, height: height, transcript: self)
            }
            next[identity] = row
            places[identity] = start
            start += height
            items.append(row)
        }
        rows = next
        starts = places
        // The screen's plans replace what a width change made.
        inPlace = inPlace.filter { next[$0.key]?.plan === $0.value.replaces }
        if let intro {
            items.append(AgentChatIntroRow(content: intro.view, height: intro.height))
            start += intro.height
        }
        if contentHeight != start || submitted?.rows.map(\.identity) != items.map(\.identity) { moved = true }
        contentHeight = start
        // The screen hands its rows over on every layout, the keyboard's
        // included. The same rows again are no pass: one would land the
        // viewport's keyboard motion where it ends, at once.
        let submission = Submission(rows: items.map { .init(identity: $0.identity, revision: $0.revision) },
                                    room: showsNewestFromItsStart ? viewportHeight : nil)
        guard submission != submitted || !transition.isImmediate else { return }
        submitted = submission
        let follows = followsNewest && !list.isTracking && !list.isDragging && !list.isDecelerating
        let target: ListScrollTarget?
        if showsNewestFromItsStart {
            // Upside down, a row's place is its newest end's: one taller
            // than the room goes up until its start meets the far edge.
            let room = Double(viewportHeight)
            target = .init(index: 0, identity: items.first?.identity, resolve: { height, _ in min(0, room - height) })
        } else {
            target = follows ? .init(index: 0, identity: items.first?.identity) : nil
        }
        let eased: ListTransition = if landing != nil && follows {
            // The rows above make room as the send flies in.
            ChatSendFlight.Motion.list
        } else {
            followOnly && !follows ? .none : transition
        }
        list.applyChanges(items: items, newSize: viewportSize,
                          newInsets: .init(top: insets.top, bottom: insets.bottom),
                          scrollTo: target,
                          anchorMode: .preserveVisibleContent,
                          transition: Self.transition(eased, moved: moved, grew: grew))
        if let landing { land(landing.identity, plan: landing.plan) }
    }

    /// Flies the send in over its row once the pass placed it.
    private func land(_ identity: String, plan: ChatRowPlan) {
        list.performAfterCurrentPass { [weak self] in
            guard let self, let flight, veiled == identity else { return }
            guard let index = list.items.firstIndex(where: { $0.identity == identity }),
                  let view = list.loadedItemView(at: index) as? AgentChatRowView else {
                flight.cancel()
                return
            }
            flight.land(on: view, plan: plan, drawn: { [weak view] in view?.canvas.isDrawn ?? true }, reveal: { [weak self] in self?.unveil() })
        }
    }

    private func unveil() {
        guard let identity = veiled else { return }
        veiled = nil
        guard let index = list.items.firstIndex(where: { $0.identity == identity }) else { return }
        (list.loadedItemView(at: index) as? AgentChatRowView)?.canvas.veiled = false
    }

    /// A pass's motion: a revealing row growing a line takes Telegram's
    /// 0.15 s even in a pass that would land at once; a pass that moves
    /// nothing lands at once, so it never retimes a growth in flight onto
    /// a curve of its own.
    static func transition(_ transition: ListTransition, moved: Bool, grew: Bool) -> ListTransition {
        if UIAccessibility.isReduceMotionEnabled { return .none }
        if transition.isImmediate { return grew ? .easeInOut(StreamingRevealMotion.heightDuration) : .none }
        return moved || grew ? transition : .none
    }

    /// The plan whose message is lifted over the chat (`MessageLiftOverlay`):
    /// its row draws nothing meanwhile, whatever view shows it.
    var liftedId: String? {
        didSet {
            guard liftedId != oldValue else { return }
            for case let view as AgentChatRowView in list.loadedItemViews { view.isLifted = view.row.plan.id == liftedId }
        }
    }

    /// The view plan `id` is drawn in now, in its coordinates, if on screen.
    func canvas(forPlan id: String) -> ChatPlanView? {
        list.loadedItemViews.lazy.compactMap { $0 as? AgentChatRowView }.first { $0.row.plan.id == id }?.canvas
    }

    func scrollToNewest(animated: Bool) {
        followsNewest = true
        list.scrollTo(newestTarget(), transition: animated && !UIAccessibility.isReduceMotionEnabled ? .easeInOut(0.2) : .none)
    }

    /// What arrives next is followed: a send carries the reader to it
    /// (`SendFollow`).
    func follow() { followsNewest = true }

    private func newestTarget() -> ListScrollTarget {
        .init(index: 0, identity: list.items.first?.identity)
    }

    private func scrolled() {
        guard isActive else { return }
        followsNewest = distanceFromNewest <= Self.followThreshold
        host?.transcriptScrolled()
    }

    /// Let go of: the rows go, and nothing of this list answers a touch.
    func deactivate() {
        flight = nil
        isActive = false
        host = nil
        list.onScroll = nil
        list.onVisibleWindowChanged = nil
        list.willBeginDragging = nil
        list.didEndDragging = nil
        reveal.stopAll()
        list.applyChanges(items: [], transition: .none)
        submitted = nil
        latest = nil
        rows.removeAll()
        removeFromSuperview()
    }

    fileprivate func tapped(_ action: ChatRowAction) {
        guard isActive else { return }
        host?.transcriptTapped(action)
    }

    fileprivate func opened(_ url: String) {
        guard isActive else { return }
        host?.transcriptOpened(url)
    }

    fileprivate func held(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) {
        guard isActive else { return }
        host?.transcriptHeld(action, in: view, frame: frame, at: point)
    }

    fileprivate func show(_ plan: ChatRowPlan, in view: ChatPlanView) {
        guard isActive else { return }
        host?.show(plan, in: view)
    }

    fileprivate func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) {
        guard isActive else { return }
        host?.placedChunks(of: plan, in: view)
    }
}

extension AgentChatUltraList: ChatRevealHost {
    func revealPresenter(_ identity: String) -> ChatRevealPresenter? {
        guard let index = list.items.firstIndex(where: { $0.identity == identity }) else { return nil }
        return (list.loadedItemView(at: index) as? AgentChatRowView)?.reveal
    }

    /// A reply came onto a new line: the row grows on Telegram's 0.15 s,
    /// the rows above it riding up by as much.
    func revealHeightsChanged() {
        guard isActive, let latest else { return }
        submit(latest.plans, intro: latest.intro, transition: .easeInOut(StreamingRevealMotion.heightDuration), followOnly: false)
    }
}

/// The conversation's intro, which the screen lays out and owns: the row
/// only gives it the width and the height it asked for.
@MainActor
private struct AgentChatIntroRow: ListRow {
    let identity = "chat:intro"
    let content: UIView
    let height: CGFloat
    var revision: UInt64 { UInt64(height.rounded()) }
    func makeView() -> ListRowView { AgentChatIntroView(content: content, height: height) }
    func apply(to view: ListRowView, transition: ListTransition) {
        (view as? AgentChatIntroView)?.height = height
    }
}

@MainActor
private final class AgentChatIntroView: ListRowView {
    private let content: UIView
    var height: CGFloat

    init(content: UIView, height: CGFloat) {
        self.content = content
        self.height = height
        super.init(frame: .zero)
        transform = ChatListView.flip
        content.transform = .identity
        addSubview(content)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.frame = bounds
    }

    override func update(width: Double, transition: ListTransition) -> Double { height }
}

/// One planned row. The plan is already measured, so the row has nothing
/// to measure: it is as tall as its plan says.
@MainActor
final class AgentChatRow: ListRow {
    let identity: String
    let revision: UInt64
    let plan: ChatRowPlan
    /// The plan's height, or less while its words are coming out.
    let height: CGFloat
    weak var transcript: AgentChatUltraList?

    init(identity: String, revision: UInt64, plan: ChatRowPlan, height: CGFloat? = nil, transcript: AgentChatUltraList) {
        self.identity = identity
        self.revision = revision
        self.plan = plan
        self.height = height ?? plan.size.height
        self.transcript = transcript
    }

    func makeView() -> ListRowView { AgentChatRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? AgentChatRowView)?.apply(self) }
}

@MainActor
final class AgentChatRowView: ListRowView, UIGestureRecognizerDelegate {
    private(set) var row: AgentChatRow
    /// What the row shows: its plan, or the one a width change made for it
    /// (`AgentChatUltraList.showInPlace`).
    private(set) var plan: ChatRowPlan
    /// The row's own view: it draws the plan's marks itself, keeps its
    /// media and cards, and is what is read out.

    let canvas = ChatPlanView()
    /// Its words coming out while a reply streams.
    let reveal = ChatRevealPresenter()
    private let hold = UILongPressGestureRecognizer()

    init(row: AgentChatRow) {
        self.row = row
        plan = row.plan
        super.init(frame: .zero)
        // The list is upside down; each row stands the right way up in it.
        transform = ChatListView.flip
        clipsToBounds = true
        canvas.drawsStaticContent = true
        canvas.cutsTallPlans = true
        canvas.drawsTextOffMain = true
        canvas.isAccessibilityElement = true
        canvas.accessibilityIdentifier = "message"
        canvas.onChunksPlaced = { [weak self] in
            guard let self else { return }
            self.row.transcript?.placedChunks(of: self.plan, in: self.canvas)
        }
        canvas.onAction = { [weak self] action in self?.row.transcript?.tapped(action) }
        addSubview(canvas)
        reveal.attach(content: canvas, host: self)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        hold.addTarget(self, action: #selector(held(_:)))
        hold.minimumPressDuration = CopyMenuLayout.Metrics.pressDuration
        hold.delegate = self
        addGestureRecognizer(tap)
        addGestureRecognizer(hold)
        tap.require(toFail: hold)
        apply(row)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Its message is lifted over the chat: the copy shows, not the row.
    var isLifted = false {
        didSet {
            canvas.isHidden = isLifted
            reveal.overlay.isHidden = isLifted
        }
    }

    func apply(_ row: AgentChatRow) {
        self.row = row
        plan = row.transcript?.inPlacePlan(for: row) ?? row.plan
        canvas.veiled = row.transcript?.veiled == row.identity
        row.transcript?.show(plan, in: canvas)
        layoutCanvas()
        // In the same transaction as the plan it draws: none of its new
        // words show before they come out.
        if let state = row.transcript?.reveal.state(row.identity) { reveal.show(state.map, count: state.count) }
        else if reveal.isActive { reveal.clear() }
        isLifted = row.transcript?.liftedId == row.plan.id
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutCanvas()
    }

    /// The plan at its own size from the row's top: a row coming out is
    /// shorter, and clips what is still to come.
    private func layoutCanvas() {
        let frame = CGRect(x: 0, y: 0, width: bounds.width, height: max(bounds.height, plan.size.height))
        if canvas.frame != frame { canvas.frame = frame }
        reveal.layout(frame)
    }

    /// The row's height: its own, or a width change's plan's, which it
    /// shows from the pass that lays the rows out at that width.
    private var height: CGFloat { plan === row.plan ? row.height : plan.size.height }

    override func update(width: Double, transition: ListTransition) -> Double {
        if let shown = row.transcript?.inPlacePlan(for: row), shown !== plan {
            plan = shown
            row.transcript?.show(shown, in: canvas)
            layoutCanvas()
        }
        return height
    }

    /// A tall row has views only for the part on screen (`ChatChunks`).
    /// The list says which part in its own coordinates, which run the
    /// other way up from the row's (the list is upside down and the row
    /// stands the right way up in it), so the part is turned over: taken
    /// as it came, the foot of a long reply on screen mounted its head,
    /// and the screen showed nothing.
    override func visibleRectUpdated(_ rect: CGRect?) {
        canvas.band = rect.map { Self.band(of: $0, height: height) } ?? .null
    }

    /// `rect`, the part on screen in the list's coordinates, in the row's.
    static func band(of rect: CGRect, height: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
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
        let point = gesture.location(in: canvas)
        if let url = canvas.link(at: point) { row.transcript?.opened(url) }
        else if let action = canvas.action(at: point) { row.transcript?.tapped(action) }
    }

    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let hit = canvas.hold(at: gesture.location(in: canvas)) else { return }
        row.transcript?.held(hit.action, in: canvas, frame: hit.frame, at: gesture.location(in: canvas))
    }
}
#endif
