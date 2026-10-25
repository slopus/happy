#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Stories on Stem Cells home, in the header as Telegram's chat list has
/// them (`ChatListNavigationBar` over `StoryPeerListComponent`): open under
/// the header while something is unseen, closed into the title once all of
/// it is seen, and opened again by pulling the list down past 65 or tapping
/// the avatars by the title. Nothing here makes a story: that is done in a
/// conversation. With Stories off, or nobody with a story, home is as it was.
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
        didSet { if isSuppressed != oldValue { apply(snapshot) } }
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
    /// Opened or closed for what the feed first showed.
    private var placed = false
    /// The drag began, and has stayed, with the list at its top, so pulling
    /// it opens the row.
    private var expansionAllowed = false
    private var dragging = false
    private var motion: StoriesHeaderMotion?
    private var drawn = StoriesHeaderLayout.State(min: 0, max: 0, side: 0)
    /// Something changed what should be open while the list was moving or
    /// the viewer was up: settle once both are done.
    private var settleWhenBack = false

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
        session = stories
        view.images = images
        snapshot = StoriesSnapshot()
        placed = false
        if let session { watch = session.watch { [weak self] snapshot in self?.apply(snapshot) } }
        else { apply(StoriesSnapshot()) }
    }

    private func apply(_ next: StoriesSnapshot) {
        let hadUnseen = StoriesRow.hasUnseen(items)
        snapshot = next
        items = next.isOn ? StoriesRow.items(next.feed, myStory: Strings.Stories.myStory) : []
        view.apply(items)
        view.isHidden = !isShown
        let hasUnseen = StoriesRow.hasUnseen(items)
        if !isShown {
            placed = false
            unlocked = false
            motion = nil
            applyInset(.immediate)
        } else if !placed {
            // Open for something new, closed for what was all seen before.
            placed = true
            unlocked = hasUnseen
            motion = nil
            applyInset(.immediate)
        } else if hasUnseen != hadUnseen || settleWhenBack {
            settle()
        }
        layout()
    }

    /// Lays the list out for the room the row now wants.
    private func applyInset(_ change: Change) {
        guard inset != wanted else { return }
        inset = wanted
        onInsetChange?(change)
    }

    // MARK: The list

    func listWillBeginDragging() {
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
        // list goes up, however it moves. The room follows on release.
        if next != unlocked, !next || (dragging && expansionAllowed) {
            change(to: next, haptic: dragging)
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
        applyInset(.held)
        if bouncing { resting = current }
        let height = StoriesHeaderLayout.Metrics.scrollHeight
        if unlocked, resting > 0, resting < height {
            resting = resting >= height / 2 ? height : 0
        }
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
            applyInset(wanted < inset && pull > 0 ? .animated : .held)
        }
        if settleWhenBack { settle() }
        layout()
    }

    // MARK: Acts

    private func change(to unlocked: Bool, haptic: Bool) {
        guard unlocked != self.unlocked else { return }
        self.unlocked = unlocked
        if haptic { StoriesHaptics.play(unlocked ? .headerOpen : .headerClose) }
        motion = StoriesHeaderMotion(from: drawn, start: CACurrentMediaTime(), opening: unlocked)
        view.ticking = true
    }

    /// Open while something is unseen, closed once it's all seen, once the
    /// list is at rest and the viewer gone. Closing happens wherever the
    /// list is; opening only with the list at its top, so nothing moves
    /// what the person is reading.
    private func settle() {
        let wanted = StoriesRow.hasUnseen(items)
        guard isShown, wanted != unlocked else {
            settleWhenBack = false
            return
        }
        if dragging || !listAtRest || host?.presentedViewController != nil {
            settleWhenBack = true
            return
        }
        settleWhenBack = false
        let pull = pull
        if wanted {
            guard abs(pull) < 1 else { return }
            change(to: true, haptic: false)
            applyInset(.animated)
        } else {
            change(to: false, haptic: false)
            applyInset(pull > 0 ? .animated : .held)
        }
    }

    /// The avatars by the title were tapped: the row opens, the list moving
    /// down to make room.
    private func expand() {
        guard isShown, !unlocked else { return }
        change(to: true, haptic: false)
        applyInset(.animated)
    }

    private func open(_ item: StoriesRowItem) {
        guard let session, let host, let feed = snapshot.feed,
              let index = feed.authors.firstIndex(where: { $0.key == item.id }) else { return }
        let viewer = StoriesViewerPresenter.present(session: session, feed: feed, authorIndex: index, from: host, origin: view.circle(item.id))
        viewer?.onClose = { [weak self] in
            // Once the presentation has let go of it.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.settleWhenBack else { return }
                self.settle()
            }
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
        header.titleX = layout.titleX
        header.backdropExtension = StoriesHeaderLayout.Metrics.scrollHeight * max(0, min(1, state.max))
    }
}
#endif
