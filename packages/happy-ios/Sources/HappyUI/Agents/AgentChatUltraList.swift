#if canImport(UIKit)
import HappyLayout
import UIKit
import UltraView

/// The screen a transcript's rows belong to: it planned them, and a row's
/// cards, media and what VoiceOver reads of it are still its to set, as
/// they are for the rows it mounts itself.
@MainActor
protocol AgentChatTranscriptHost: AnyObject {
    /// `view` is to show `plan`, exactly as a mounted row shows it.
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

/// The agents' transcript on UltraList, in place of the rows the screen
/// mounts in a scroll view of its own. Each row is drawn by the same
/// `ChatPlanView` as before, with the same plan, so its cards, media, hit
/// testing and VoiceOver are what they were: what changes is who keeps
/// the rows near the screen and who moves them.
///
/// The list is turned upside down, as the library's own chat is and as the
/// sessions' chat is (`ChatUltraListAdapter`): rows go in newest first,
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
    /// Where each row starts, measured up from the newest end, as the
    /// mounted transcript's stack measures it: the list keeps only a
    /// window of rows, so their places are worked out here.
    private var starts: [String: CGFloat] = [:]
    private var revision: UInt64 = 0
    private var insets = UIEdgeInsets.zero
    private var viewportSize = CGSize.zero
    private var contentHeight: CGFloat = 0
    /// The newest row is at the foot and the reader is on it.
    private(set) var followsNewest = true
    /// As close to the newest row as the mounted transcript counts as on
    /// it (`ChatViewController`'s own 24pt), not the sessions' 200.
    static let followThreshold: CGFloat = 24

    override init(frame: CGRect) {
        super.init(frame: frame)
        list.contentView.transform = ChatCollectionLayout.flip
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
    }

    /// The conversation's rows, oldest first as the screen plans them,
    /// and the intro that opens it, which the screen has laid out. A row
    /// whose plan has not changed keeps the view it had, drawn as it was:
    /// only a new plan is shown again.
    ///
    /// The intro goes in last, which is at the top: where the mounted
    /// transcript puts it, scrolling away as the rows under it fill the
    /// screen (`ChatStackLayout(pinsFirst:)`).
    func apply(_ plans: [ChatRowPlan], intro: (view: UIView, height: CGFloat)? = nil, animated: Bool = false) {
        var items: [any ListRow] = []
        var next: [String: AgentChatRow] = [:]
        var places: [String: CGFloat] = [:]
        var start: CGFloat = 0
        items.reserveCapacity(plans.count + 1)
        for plan in plans.reversed() {
            let identity = "chat:row:\(plan.id)"
            let row: AgentChatRow
            if let kept = rows[identity], kept.plan === plan {
                row = kept
            } else {
                // A revision is never reused, even where an identity comes back.
                revision &+= 1
                row = AgentChatRow(identity: identity, revision: revision, plan: plan, transcript: self)
            }
            next[identity] = row
            places[identity] = start
            start += plan.size.height
            items.append(row)
        }
        rows = next
        starts = places
        if let intro {
            items.append(AgentChatIntroRow(content: intro.view, height: intro.height))
            start += intro.height
        }
        contentHeight = start
        let follows = followsNewest && !list.isTracking && !list.isDragging && !list.isDecelerating
        list.applyChanges(items: items, newSize: viewportSize,
                          newInsets: .init(top: insets.top, bottom: insets.bottom),
                          scrollTo: follows ? .init(index: 0, identity: items.first?.identity) : nil,
                          anchorMode: .preserveVisibleContent,
                          transition: animated && follows && !UIAccessibility.isReduceMotionEnabled ? .easeInOut(0.2) : .none)
    }

    func scrollToNewest(animated: Bool) {
        followsNewest = true
        list.scrollTo(newestTarget(), transition: animated && !UIAccessibility.isReduceMotionEnabled ? .easeInOut(0.2) : .none)
    }

    /// What arrives next is followed: a send by a reader at the end, or
    /// near it (`SendFollow`), carries them to it.
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
        isActive = false
        host = nil
        list.onScroll = nil
        list.onVisibleWindowChanged = nil
        list.willBeginDragging = nil
        list.didEndDragging = nil
        list.applyChanges(items: [], transition: .none)
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
        transform = ChatCollectionLayout.flip
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
    weak var transcript: AgentChatUltraList?

    init(identity: String, revision: UInt64, plan: ChatRowPlan, transcript: AgentChatUltraList) {
        self.identity = identity
        self.revision = revision
        self.plan = plan
        self.transcript = transcript
    }

    func makeView() -> ListRowView { AgentChatRowView(row: self) }
    func apply(to view: ListRowView, transition: ListTransition) { (view as? AgentChatRowView)?.apply(self) }
}

@MainActor
final class AgentChatRowView: ListRowView, UIGestureRecognizerDelegate {
    private(set) var row: AgentChatRow
    /// The row's own view, as the mounted transcript's rows are: it draws
    /// the plan's marks itself, keeps its media and cards, and is what is
    /// read out.
    let canvas = ChatPlanView()
    private let hold = UILongPressGestureRecognizer()

    init(row: AgentChatRow) {
        self.row = row
        super.init(frame: .zero)
        // The list is upside down; each row stands the right way up in it.
        transform = ChatCollectionLayout.flip
        clipsToBounds = true
        canvas.drawsStaticContent = true
        canvas.cutsTallPlans = true
        canvas.drawsTextOffMain = true
        canvas.isAccessibilityElement = true
        canvas.accessibilityIdentifier = "message"
        canvas.onChunksPlaced = { [weak self] in
            guard let self else { return }
            self.row.transcript?.placedChunks(of: self.row.plan, in: self.canvas)
        }
        canvas.onAction = { [weak self] action in self?.row.transcript?.tapped(action) }
        addSubview(canvas)
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

    func apply(_ row: AgentChatRow) {
        self.row = row
        row.transcript?.show(row.plan, in: canvas)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        canvas.frame = bounds
    }

    override func update(width: Double, transition: ListTransition) -> Double { row.plan.size.height }

    /// A tall row has views only for the part on screen (`ChatChunks`).
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
