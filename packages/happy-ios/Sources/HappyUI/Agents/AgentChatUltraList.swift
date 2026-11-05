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
/// The list stands the natural way up, as the sessions' chat does
/// (`ChatListView`): the intro and the oldest row at the top, the newest
/// at the foot, resting on the composer (`bottomGravity`). The screen
/// plans them oldest first and hands them over that way.
///
/// The list keeps the reader's place itself. At the newest row a reply
/// still streaming is followed by `followBudget`, two lines of text, from
/// its first words on, and then the list holds still until the reader is
/// back at the foot (`ChatFollow`). A finished row arriving there comes
/// into view whole, and a send of the person's own always does
/// (`revealNextSend`).
@MainActor
final class AgentChatUltraList: UIView {
    let list = UltraListView(engineMode: .keyframe)
    weak var host: AgentChatTranscriptHost?
    /// The reader reached the oldest row the conversation has read: there
    /// may be more behind it.
    var onReachedOldest: (() -> Void)?
    private(set) var isActive = true
    private var rows: [String: AgentChatRow] = [:]
    /// How far each row's foot is from the newest end: the list keeps only
    /// a window of rows, so their places are worked out here.
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
    /// The newest row is at the foot and the reader is on it, or near
    /// enough (`followThreshold`).
    private(set) var followsNewest = true
    /// The person sent a message: the next pass that brings a new newest
    /// row scrolls it fully into view.
    private var revealsSend = false
    /// The reader opened or folded something: the pass that shows it
    /// stops following too, whatever moved the list since the tap.
    private var holdsPlace = false
    /// How far the list follows the newest row growing by itself
    /// (`ChatFollow.budget`).
    var followBudget: CGFloat = ChatFollow.budget(body: ChatTextStyles.text, scale: .standard) {
        didSet {
            guard followBudget != oldValue else { return }
            list.bottomGravity = ListBottomGravity(followBudget: Double(followBudget))
        }
    }
    /// The agent is at work and its newest row is its words, still
    /// arriving: followed as growth, within the budget.
    private var streams = false
    /// A preview's: the newest row, taller than the room it has, shows
    /// from its start rather than its end.
    var showsNewestFromItsStart = false
    /// As close to the newest row as counts as on it.
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
        return (max(0, loaded.lowerBound - 8)..<loaded.upperBound).reversed().compactMap { (list.items[$0] as? AgentChatRow)?.plan.id }
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
        list.bottomGravity = ListBottomGravity(followBudget: Double(followBudget))
        list.keyboardDismissMode = .interactive
        list.accessibilityIdentifier = "transcript"
        list.onScroll = { [weak self] _ in self?.scrolled() }
        list.onVisibleWindowChanged = { [weak self] in self?.scrolled() }
        list.willBeginDragging = { [weak self] in self?.host?.transcriptWillBeginDragging() }
        list.didEndDragging = { [weak self] in self?.host?.transcriptDidEndDragging() }
        list.onLoadedEdgeReached = { [weak self] edge in
            guard let self, isActive, edge == .top else { return }
            onReachedOldest?()
        }
        addSubview(list)
        reveal.host = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Then where the screen puts the rows (`setViewport`).
        if viewportSize == .zero { list.frame = bounds }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        list.takingMargins(super.hitTest(point, with: event), of: self)
    }

    /// The room the rows have between the bar and the composer.
    var viewportHeight: CGFloat { max(0, bounds.height - insets.top - insets.bottom) }

    var distanceFromOldest: CGFloat { max(0, contentHeight - viewportHeight - distanceFromNewest) }

    /// How far the reader is from the newest row, which is at the foot:
    /// zero on it, growing as they read up into history
    /// (`ChatUltraListAdapter.visibleMinY`).
    var distanceFromNewest: CGFloat {
        // The list's own while its end is loaded: rows laid out again at a
        // new width hold their old starts until the new plans come.
        if let distance = list.distanceFromBottom { return distance }
        for index in list.loadedIndexRange {
            guard let row = list.items[index] as? AgentChatRow,
                  let start = starts[row.identity],
                  let frame = list.settledFrame(at: index) else { continue }
            return ChatListPosition.distanceFromNewest(rowStart: start, rowMaxY: frame.maxY, viewportHeight: viewportSize.height, bottomInset: insets.bottom)
        }
        return 0
    }

    /// The rows stand in `frame`, in this view: all of it but the safe
    /// area's sides (`ChatScreenLayout.list`), so a phone held sideways
    /// keeps them off the camera while the view runs edge to edge. A touch
    /// in those margins drags the list.
    func setViewport(frame: CGRect, insets: UIEdgeInsets, keyboard: ChatUltraKeyboard.Change? = nil) {
        let size = frame.size
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
    /// The intro goes in first, at the top, scrolling away as the rows
    /// under it fill the screen.
    /// `animated` eases rows in while the newest is followed; `moves` eases
    /// a turn opening or folding wherever the reader is, the rows they see
    /// staying put. `streaming`: the agent is at work, so its newest words
    /// may grow, and come out as they do (`ChatRevealDriver`). The last
    /// `queued` rows are the person's sends waiting under the work: the
    /// agent's newest row is the one above them.
    func apply(_ plans: [ChatRowPlan], intro: (view: UIView, height: CGFloat)? = nil, animated: Bool = false, moves: Bool = false, streaming: Bool = false, queued: Int = 0) {
        if isActive { startReveals(plans.dropLast(queued), streaming: streaming) }
        latest = (plans, intro)
        streams = streaming && plans.last?.revealable == true
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
        let streamingIdentity = plans.last.map { "chat:row:\($0.id)" }
        // Worked out newest first, from the foot, then turned the natural
        // way up.
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
                row = AgentChatRow(identity: identity, revision: revision, plan: plan, height: height, transcript: self,
                                   isStreaming: streams && identity == streamingIdentity)
            }
            next[identity] = row
            places[identity] = start
            start += height
            items.append(row)
        }
        // A send of the person's own, once its row is in, comes fully into view.
        let newest = items.first?.identity
        let reveals = revealsSend && newest.map { rows[$0] == nil } == true
        if reveals { revealsSend = false }
        rows = next
        starts = places
        // The screen's plans replace what a width change made.
        inPlace = inPlace.filter { next[$0.key]?.plan === $0.value.replaces }
        if let intro {
            items.append(AgentChatIntroRow(content: intro.view, height: intro.height))
            start += intro.height
        }
        items.reverse()
        if contentHeight != start || submitted?.rows.map(\.identity) != items.map(\.identity) { moved = true }
        contentHeight = start
        // The screen hands its rows over on every layout, the keyboard's
        // included. The same rows again are no pass: one would land the
        // viewport's keyboard motion where it ends, at once.
        let submission = Submission(rows: items.map { .init(identity: $0.identity, revision: $0.revision) },
                                    room: showsNewestFromItsStart ? viewportHeight : nil)
        guard submission != submitted || !transition.isImmediate else { return }
        submitted = submission
        if holdsPlace {
            holdsPlace = false
            list.stopFollowingBottom()
        }
        let follows = list.isFollowingBottom || reveals
        let target: ListScrollTarget?
        if showsNewestFromItsStart, let newest = items.indices.last {
            // The newest row's top at the top of the room, or its foot on
            // the composer when it is shorter than the room.
            let room = Double(viewportHeight)
            target = .init(index: newest, identity: items[newest].identity, resolve: { height, _ in max(0, room - height) })
        } else {
            // The conversation opens on its newest row.
            target = reveals || list.items.isEmpty ? .bottom : nil
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

    /// Back to the newest row, following what grows there again.
    func scrollToNewest(animated: Bool) {
        followsNewest = true
        list.scrollToBottom(animated: animated && !UIAccessibility.isReduceMotionEnabled)
    }

    /// The person sent a message: back to the newest row now, and the row
    /// it brings brought fully into view when it comes (`SendFollow`).
    func revealNextSend(animated: Bool) {
        revealsSend = true
        scrollToNewest(animated: animated)
    }

    /// Puts the foot of the visible area `distance` from the newest end,
    /// by the row there (`ChatListPosition.rowTop`), or at the top past
    /// the oldest row.
    func scroll(toDistanceFromNewest distance: CGFloat) {
        followsNewest = false
        let distance = max(0, distance)
        for index in list.items.indices.reversed() {
            guard let row = list.items[index] as? AgentChatRow, let start = starts[row.identity], start + row.height > distance else { continue }
            let top = ChatListPosition.rowTop(rowStart: start, rowHeight: row.height, distance: distance, visibleHeight: viewportHeight)
            list.scrollTo(.init(index: index, pointOffset: Double(top)), transition: .none)
            return
        }
        list.scrollToTop(animated: false)
    }

    /// The reader opened or folded something: it grows or shrinks under
    /// their finger, the rows above it holding still, not the newest row.
    func holdPlace() {
        followsNewest = false
        holdsPlace = true
        list.stopFollowingBottom()
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
    /// followed while the list follows the newest row, below the fold once
    /// it has stopped.
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
    /// The agent's words still arriving. Arriving at the foot they are
    /// followed as growth, by the budget; a finished row comes into view
    /// whole.
    let isStreaming: Bool
    weak var transcript: AgentChatUltraList?

    init(identity: String, revision: UInt64, plan: ChatRowPlan, height: CGFloat? = nil, transcript: AgentChatUltraList, isStreaming: Bool = false) {
        self.isStreaming = isStreaming
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

    /// A tall row has views only for the part on screen (`ChatChunks`),
    /// which the list gives in the row's own coordinates.
    override func visibleRectUpdated(_ rect: CGRect?) {
        canvas.band = rect ?? .null
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
