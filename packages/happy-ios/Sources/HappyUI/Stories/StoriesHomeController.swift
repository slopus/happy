#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Stories on Stem Cells home, in the header as Telegram's chat list has
/// them (`ChatListNavigationBar` over `StoryPeerListComponent`): open above
/// the list, or closed into the title as small avatars; opened by pulling
/// the list down past 65 or tapping the avatars, and put away by scrolling
/// the list up past 61 or by seeing everything.
///
/// Home starts with them open when there is something to look at, until
/// the person puts them away; that is remembered, and only a launch with a
/// story posted since opens them again. Telegram keeps no such memory (its
/// row starts closed on every launch and stays as left only while the app
/// lives); this is ours. While home is up nothing else opens them: not new
/// stories, not the list coming back to its top. Nothing here makes a
/// story: that is done in a conversation. With Stories off, or nobody with
/// a story, home is as it was.
///
/// The open row takes 96 above the list (`inset`). The list's pull below
/// its closed top drives everything; the host hands its scroll view over as
/// `list` and forwards its delegate calls. The room above the list only
/// changes when the list is let go of or at rest, never under a finger or
/// while it glides, so the list never jumps.
@MainActor
final class StoriesHomeController {
    /// How the room above the list changed: as the list was let go of or
    /// came to rest (the list stays where it is), on its own as the stories
    /// were seen or new ones came (the list follows, animated), or as home
    /// first shows them (the list follows at once).
    enum Change {
        case held
        case animated
        case immediate
    }

    let view = StoriesHeaderView()
    var onInsetChange: ((Change) -> Void)?
    /// The list the stories open above.
    weak var list: UIScrollView?
    /// A row is being carried: the list's own scrolling then is the carry's.
    var carrying = false {
        didSet { if !carrying, oldValue { listCameToRest() } }
    }
    /// Home shows something else (no computer, one too old): no stories.
    var isSuppressed = false {
        didSet {
            guard isSuppressed != oldValue else { return }
            // Home changed under the viewer: what it held is drawn now.
            let latest = held ?? snapshot
            held = nil
            draw(latest)
        }
    }
    private weak var host: UIViewController?
    private weak var header: HomeHeaderView?
    private(set) var session: StoriesSession?
    private var watch: StemCellsWatch?
    private var snapshot = StoriesSnapshot()
    private var items: [StoriesRowItem] = []
    private(set) var unlocked = false
    /// The room above the list as the host last laid it out.
    private(set) var inset: CGFloat = 0
    /// The drag began, and has stayed, with the list at its top, so pulling
    /// it opens the row.
    private var expansionAllowed = false
    private var dragging = false
    private var motion: StoriesHeaderMotion?
    private var drawn = StoriesHeaderLayout.State(min: 0, max: 0, side: 0)
    /// Something changed what should be open while the list was moving or
    /// the viewer was up: settle once both are done.
    private var settleWhenBack = false
    /// What came while the viewer was up, drawn as it closes back into the
    /// row, so the rings it saw turn grey as Telegram's do, in sight.
    private var viewerUp: Bool { viewer != nil }
    private weak var viewer: StoryViewerViewController?
    private var held: StoriesSnapshot?
    /// A circle tapped whose story is still loading: the viewer opens once
    /// it's here, or after a few seconds regardless.
    private var opening: Task<Void, Never>?
    private weak var loadingCircle: StoriesCircleView?
    /// Telegram's one-time "Tap above to view stories from …", looked for a
    /// second after the stories come, shown once ever.
    static let tooltipShownKey = "stories.feedTooltipShown"
    /// Per computer, the newest story's posting time when the person last
    /// put the row away (`StoriesRow.newest`).
    static let putAwayKey = "stories.putAway"
    /// Whether the row starts open is still to be decided: until a fresh
    /// feed from the computer is drawn, the list is touched or a viewer opens.
    private var launching = false
    private var tooltip: StoriesTooltipView?
    private var tooltipCheck: Task<Void, Never>?
    /// Where it points, in the header's space, as last laid out.
    private var tooltipTip: CGPoint?

    init(host: UIViewController) {
        self.host = host
        view.isHidden = true
        view.onOpen = { [weak self] item in self?.open(item) }
        view.onExpand = { [weak self] in self?.expand() }
        view.onScroll = { [weak self] in self?.layout() }
        view.onLayout = { [weak self] in self?.layout() }
        view.onTick = { [weak self] in self?.layout() }
    }

    /// Stories are on, somebody has one, and home is showing its list.
    var isShown: Bool { snapshot.isOn && !items.isEmpty && !isSuppressed }

    /// The room the row wants: 96 open, 0 closed or not drawn.
    private var wanted: CGFloat { isShown && unlocked ? StoriesHeaderLayout.Metrics.scrollHeight : 0 }

    /// How far the list sits below its top with the stories closed.
    private var pull: CGFloat {
        guard let list else { return 0 }
        return -(list.contentOffset.y + list.contentInset.top - inset)
    }

    private var listAtRest: Bool {
        guard let list else { return true }
        return !list.isDragging && !list.isDecelerating && !carrying
    }

    /// Puts the stories in `header`, or takes them out with nil.
    func install(in header: HomeHeaderView?) {
        guard header !== self.header else { return }
        if let previous = self.header, previous.accessory === view {
            previous.accessory = nil
            previous.titleX = nil
            previous.backdropExtension = 0
        }
        hideTooltip()
        self.header = header
        header?.accessory = view
        layout()
    }

    func attach(_ stemCells: StemCellsSession?) {
        guard stemCells?.accountID != session?.accountID else { return }
        attach(stemCells.map(StoriesSession.session(for:)), images: stemCells?.images)
    }

    func attach(_ stories: StoriesSession?, images: StemCellsImages?) {
        watch?.invalidate(); watch = nil
        stopOpening()
        hideTooltip()
        viewer = nil
        held = nil
        session = stories
        view.images = images
        snapshot = StoriesSnapshot()
        // Another computer's stories start closed, and decide again.
        unlocked = false
        launching = stories != nil
        motion = nil
        settleWhenBack = false
        applyInset(.immediate)
        if let session { watch = session.watch { [weak self] snapshot in self?.apply(snapshot) } }
        else { draw(StoriesSnapshot()) }
    }

    /// A snapshot from the session: held while the viewer is up.
    private func apply(_ next: StoriesSnapshot) {
        if viewerUp {
            held = next
            return
        }
        draw(next)
    }

    private func draw(_ next: StoriesSnapshot) {
        let hadUnseen = StoriesRow.hasUnseen(items)
        snapshot = next
        items = next.isOn ? StoriesRow.items(next.feed, myStory: Strings.Stories.myStory) : []
        view.apply(items)
        view.isHidden = !isShown
        let hasUnseen = StoriesRow.hasUnseen(items)
        if !isShown {
            stopOpening()
            hideTooltip()
            unlocked = false
            motion = nil
            applyInset(.immediate)
        } else if hasUnseen != hadUnseen || settleWhenBack {
            settle()
        }
        if launching { openAtLaunch() }
        if isShown { lookForTooltip() }
        layout()
    }

    /// Opens the row as home first shows it, if it should, with the list at
    /// rest at its top: at once before home is on screen, else as a tap on
    /// the avatars would.
    private func openAtLaunch() {
        if isShown, !unlocked, listAtRest, !dragging, !viewerUp, abs(pull) < 1,
           StoriesRow.opensAtLaunch(snapshot.feed, stories: snapshot.stories, putAwayThrough: putAwayThrough) {
            launching = false
            change(to: true, haptic: false)
            let offScreen = host?.view.window == nil
            if offScreen {
                motion = nil
                view.ticking = false
            }
            applyInset(offScreen ? .immediate : .animated)
            return
        }
        if snapshot.live { launching = false }
    }

    /// The newest story's time when the person last put the row away here.
    private var putAwayThrough: Int64? {
        guard let account = session?.accountID else { return nil }
        return (UserDefaults.standard.dictionary(forKey: Self.putAwayKey)?[account] as? NSNumber)?.int64Value
    }

    /// The person put the row away, or opened it: remembered for the next launch.
    private func remember(putAway: Bool) {
        guard let account = session?.accountID else { return }
        var all = UserDefaults.standard.dictionary(forKey: Self.putAwayKey) ?? [:]
        all[account] = putAway ? NSNumber(value: StoriesRow.newest(snapshot.feed, stories: snapshot.stories)) : nil
        UserDefaults.standard.set(all, forKey: Self.putAwayKey)
    }

    /// Lays the list out for the room the row now wants.
    private func applyInset(_ change: Change) {
        guard inset != wanted else { return }
        inset = wanted
        onInsetChange?(change)
    }

    // MARK: The list

    func listWillBeginDragging() {
        hideTooltip()
        launching = false
        dragging = true
        expansionAllowed = pull >= -1
    }

    func listDidScroll() {
        guard isShown, !carrying else {
            layout()
            return
        }
        let pull = pull
        if dragging, pull < -1 { expansionAllowed = false }
        let next = StoriesHeaderLayout.unlocked(unlocked, pull: pull)
        // Opens only under a finger that began at the top; closes as the
        // list goes up, however it moves, a flick's glide too, with its tap
        // of feedback as Telegram's. The room follows on release.
        if next != unlocked, !next || (dragging && expansionAllowed) {
            change(to: next, haptic: true)
            remember(putAway: !next)
        }
        layout()
    }

    /// The finger lifts: the room above the list becomes what the row
    /// wants, and a list let go of part way into the open row goes to it
    /// or past it, never stopping half way.
    func listWillEndDragging(target: UnsafeMutablePointer<CGPoint>) {
        dragging = false
        guard let list, isShown else { return }
        let current = pull
        let closedTop = list.contentInset.top - inset
        var resting = -(target.pointee.y + closedTop)
        // Let go above the top it had: it would have gone back to that top.
        let bouncing = current > inset && abs(resting - inset) < 1
        if bouncing { resting = current }
        // A list too short to scroll can't glide past its top: where a flick
        // up would have taken it, as a scroll view decelerates (0.998 a ms).
        let velocity = -list.panGestureRecognizer.velocity(in: list).y / 1000
        if unlocked, !bouncing, abs(resting - inset) < 1, velocity > 0 {
            resting = min(resting, current - velocity * 499)
        }
        // A glide that will put the row away puts it away now, so the list
        // goes straight to its closed top rather than back to the row first.
        if unlocked, resting <= StoriesHeaderLayout.Metrics.lockPull {
            change(to: false, haptic: true)
            remember(putAway: true)
        }
        applyInset(.held)
        resting = StoriesHeaderLayout.resting(unlocked: unlocked, glide: resting)
        // Never past the top the room now has.
        resting = min(resting, inset)
        target.pointee.y = -(resting + closedTop)
    }

    func listDidEndDragging(decelerate: Bool) {
        dragging = false
        if !decelerate { listCameToRest() }
    }

    func listDidEndDecelerating() { listCameToRest() }

    /// The list stopped: what changed while it moved takes its room, and a
    /// settle that waited for it runs.
    private func listCameToRest() {
        guard listAtRest else { return }
        if pull < -1 { expansionAllowed = false }
        if inset != wanted {
            // Closing with the list in the open row's room: the list goes up.
            applyInset(wanted < inset && pull > 1 ? .animated : .held)
        }
        if settleWhenBack { settle() }
        layout()
    }

    // MARK: Acts

    private func change(to unlocked: Bool, haptic: Bool) {
        guard unlocked != self.unlocked else { return }
        self.unlocked = unlocked
        if !unlocked { stopOpening() } else { hideTooltip() }
        if haptic { StoriesHaptics.play(unlocked ? .headerOpen : .headerClose) }
        motion = StoriesHeaderMotion(from: drawn, start: CACurrentMediaTime(), opening: unlocked)
        view.ticking = true
    }

    /// Closed once everything is seen, when the list is at rest and the
    /// viewer gone, wherever the list is. Never opens: only the person does.
    private func settle() {
        guard isShown, unlocked, !StoriesRow.hasUnseen(items) else {
            settleWhenBack = false
            return
        }
        if dragging || !listAtRest || host?.presentedViewController != nil {
            settleWhenBack = true
            return
        }
        settleWhenBack = false
        change(to: false, haptic: false)
        applyInset(pull > 1 ? .animated : .held)
    }

    /// The avatars by the title were tapped: the row opens, the list moving
    /// down to make room.
    private func expand() {
        guard isShown, !unlocked else { return }
        launching = false
        change(to: true, haptic: false)
        remember(putAway: false)
        applyInset(.animated)
    }

    private func open(_ item: StoriesRowItem) {
        guard opening == nil, !viewerUp, let session, let host, let feed = snapshot.feed,
              let index = feed.authors.firstIndex(where: { $0.key == item.id }) else { return }
        // As Telegram's row does: the picture it opens on first, the circle's
        // ring turning to dashes if that takes more than a moment.
        let author = feed.authors[index]
        let stories = session.snapshot.stories.merging(feed.stories) { held, _ in held }
        let start = StoriesRow.start(author, stories: stories)
        if author.storyIds.indices.contains(start), let story = stories[author.storyIds[start]], let frame = story.frames.first,
           frame.kind == .image, frame.available, let circle = view.circle(item.id) {
            // The size the viewer reads it at: full screen, laid out before
            // it is in a window.
            let canvas = StoryViewerLayout(size: host.view.window?.bounds.size ?? host.view.bounds.size, safeArea: LayoutInsets()).canvas.size
            let pixels = StoryCanvasView.pixels(canvas, scale: host.traitCollection.displayScale)
            let media = session.media
            if media.cachedFrame(story.id, frame.id, pixels: pixels) == nil {
                loadingCircle = circle
                opening = Task { [weak self, weak circle] in
                    let ring = Task { @MainActor [weak circle] in
                        try? await Task.sleep(for: .milliseconds(200))
                        if !Task.isCancelled { circle?.isLoadingStory = true }
                    }
                    await StoriesOpening.first(of: { _ = await media.frame(story.id, frame, pixels: pixels) }, orAfter: .seconds(5))
                    ring.cancel()
                    circle?.isLoadingStory = false
                    guard let self, !Task.isCancelled else { return }
                    opening = nil
                    guard isShown, unlocked else { return }
                    present(item)
                }
                return
            }
        }
        present(item)
    }

    /// The row closed or went away while a story loaded: no viewer after all.
    private func stopOpening() {
        opening?.cancel()
        opening = nil
        loadingCircle?.isLoadingStory = false
        loadingCircle = nil
    }

    private func present(_ item: StoriesRowItem) {
        guard let session, let host, let feed = snapshot.feed,
              let index = feed.authors.firstIndex(where: { $0.key == item.id }) else { return }
        guard !viewerUp, let viewer = StoriesViewerPresenter.present(session: session, feed: feed, authorIndex: index, from: host, origin: view.circle(item.id)) else { return }
        hideTooltip()
        launching = false
        self.viewer = viewer
        viewer.originFor = { [weak self] key in self?.view.circle(key) }
        viewer.onClosing = { [weak self, weak viewer] in
            guard let self, let viewer, viewer === self.viewer else { return }
            self.release()
        }
        viewer.onClose = { [weak self, weak viewer] in
            guard let self else { return }
            if let viewer, viewer === self.viewer { self.release() }
            // Once the presentation has let go of it.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.settleWhenBack else { return }
                self.settle()
            }
        }
    }

    // MARK: The tooltip

    /// As Telegram's chat list does each time its stories come: a second
    /// later, if the tip was never shown, the row is closed and someone
    /// else has a story, it shows under the avatars by the title.
    private func lookForTooltip() {
        guard tooltip == nil, tooltipCheck == nil, !UserDefaults.standard.bool(forKey: Self.tooltipShownKey) else { return }
        tooltipCheck = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled else { return }
            tooltipCheck = nil
            showTooltip()
        }
    }

    private func showTooltip() {
        let names = items.filter { !$0.isSelf }.prefix(3).map(\.title)
        guard tooltip == nil, isShown, !unlocked, !viewerUp, opening == nil, !names.isEmpty, listAtRest, !dragging,
              !UserDefaults.standard.bool(forKey: Self.tooltipShownKey),
              let host, host.presentedViewController == nil, host.view.window != nil,
              let header, let container = header.superview, let tip = tooltipTip else { return }
        // Over the header and everything else on the screen, so it sees
        // the first touch anywhere, the header's buttons too.
        let tooltip = StoriesTooltipView(text: Strings.Stories.tooltip(names))
        tooltip.frame = container.bounds
        tooltip.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tooltip.point(at: header.convert(tip, to: container))
        tooltip.onDismiss = { [weak self, weak tooltip] in
            guard let self, self.tooltip === tooltip else { return }
            self.tooltip = nil
        }
        container.addSubview(tooltip)
        tooltip.show()
        self.tooltip = tooltip
        UserDefaults.standard.set(true, forKey: Self.tooltipShownKey)
    }

    private func hideTooltip() {
        tooltipCheck?.cancel()
        tooltipCheck = nil
        tooltip?.dismiss()
    }

    /// The viewer goes: what came meanwhile is drawn, as it closes.
    private func release() {
        viewer = nil
        if let held {
            self.held = nil
            draw(held)
        }
    }

    // MARK: Drawing

    private func layout() {
        guard let header, header.accessory === view else {
            view.ticking = false
            return
        }
        guard isShown else {
            header.titleX = nil
            header.backdropExtension = 0
            view.ticking = false
            return
        }
        let now = CACurrentMediaTime()
        // Closed, a pull leans the avatars out only when it may open them.
        let shownPull = unlocked || (dragging && expansionAllowed) ? pull : min(0, pull)
        let target = StoriesHeaderLayout.State.target(unlocked: unlocked, pull: shownPull)
        var state = target
        if let motion {
            if motion.isFinished(at: now) {
                self.motion = nil
                view.ticking = false
            } else {
                state = motion.state(toward: target, at: now)
            }
        } else {
            view.ticking = false
        }
        drawn = state
        let width = header.bounds.width
        let base = header.layout(width: width)
        let layout = StoriesHeaderLayout(.init(
            width: width, title: base.title, bandMinX: base.logoControl.maxX, bandMaxX: base.actions.minX,
            count: items.count, collapseStart: StoriesRow.collapseStart(items),
            scroll: view.pager.contentOffset.x, state: state
        ))
        view.place(layout, unlocked: unlocked, side: state.side)
        tooltipTip = layout.tooltipTip
        if let tooltip, let container = tooltip.superview {
            if let tip = layout.tooltipTip { tooltip.point(at: header.convert(tip, to: container)) } else { hideTooltip() }
        }
        header.titleX = layout.titleX
        header.backdropExtension = StoriesHeaderLayout.Metrics.scrollHeight * max(0, min(1, state.max))
    }
}

/// Waits for the work, the limit or cancellation, whichever is first; the
/// work goes on alone.
@MainActor
private final class StoriesOpening {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false
    private var timer: Task<Void, Never>?

    private func finish() {
        finished = true
        timer?.cancel()
        timer = nil
        continuation?.resume()
        continuation = nil
    }

    static func first(of work: @escaping @MainActor () async -> Void, orAfter limit: Duration) async {
        let gate = StoriesOpening()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !gate.finished else { return continuation.resume() }
                gate.continuation = continuation
                Task { @MainActor in
                    await work()
                    gate.finish()
                }
                gate.timer = Task { @MainActor in
                    try? await Task.sleep(for: limit)
                    if !Task.isCancelled { gate.finish() }
                }
            }
        } onCancel: {
            Task { @MainActor in gate.finish() }
        }
    }
}
#endif
