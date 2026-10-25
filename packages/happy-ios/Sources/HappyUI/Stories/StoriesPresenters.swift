#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Opens the full-screen viewer on an author of the row, grown out of
/// their circle, and closes it back into the circle.
@MainActor
enum StoriesViewerPresenter {
    @discardableResult
    static func present(session: StoriesSession, feed: StoryFeed, authorIndex: Int, storyId: String? = nil, from host: UIViewController, origin: UIView?) -> StoryViewerViewController? {
        guard host.presentedViewController == nil else { return nil }
        let viewer = StoryViewerViewController(session: session, feed: feed, authorIndex: authorIndex, storyId: storyId)
        viewer.origin = origin
        viewer.transitioningDelegate = StoriesViewerTransition.shared
        viewer.onOpenConversation = { [weak host] source in
            guard let host, let stemCells = session.stemCells, let navigation = host.navigationController ?? host as? UINavigationController else { return }
            let title = stemCells.snapshot.rows.first { $0.agentId == source.agentId }?.label ?? Strings.StemCells.untitledSession
            let chat = StemCellChatViewController(session: stemCells, agentId: source.agentId, title: title, spaceId: nil, stemCell: nil)
            navigation.pushViewController(chat, animated: true)
        }
        StoriesHaptics.play(.open)
        host.present(viewer, animated: true)
        return viewer
    }

    /// Opens one posted story, from where it is drawn inline: among its
    /// author's stories when the row has them, or on its own.
    @discardableResult
    static func present(session: StoriesSession, story: Story, from host: UIViewController, origin: UIView?) -> StoryViewerViewController? {
        let snapshot = session.snapshot
        if var feed = snapshot.feed, let index = feed.authors.firstIndex(where: { $0.storyIds.contains(story.id) }) {
            feed.stories = snapshot.stories
            return present(session: session, feed: feed, authorIndex: index, storyId: story.id, from: host, origin: origin)
        }
        let mine = snapshot.feed?.authors.first(where: \.isSelf)
        let isSelf = story.authorUserId == nil || story.authorUserId == mine?.userId
        let known = isSelf ? mine : snapshot.feed?.authors.first { $0.userId == story.authorUserId }
        let author = StoryFeedAuthor(
            userId: story.authorUserId, name: known?.name ?? (isSelf ? Strings.Stories.myStory : ""),
            photo: known?.photo, thumbhash: known?.thumbhash, isSelf: isSelf,
            storyIds: [story.id], unseenCount: 0, draftCount: nil, latestPostedAt: story.postedAt
        )
        return present(session: session, feed: StoryFeed(authors: [author], stories: [story.id: story], cursor: ""), authorIndex: 0, storyId: story.id, from: host, origin: origin)
    }
}

/// The viewer grows from what it opened from, as Telegram's does
/// (`StoryOpeningLayout`): the story shows through the row's circle, or the
/// story drawn inline with its corners, which grows into the canvas.
/// Closing it goes back into it, or, with that out of sight, lets it fall
/// away.
@MainActor
final class StoriesViewerTransition: NSObject, UIViewControllerTransitioningDelegate, UIViewControllerAnimatedTransitioning {
    static let shared = StoriesViewerTransition()
    private var presenting = true

    func animationController(forPresented presented: UIViewController, presenting: UIViewController, source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        self.presenting = true
        return self
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        presenting = false
        return self
    }

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval { StoryOpeningLayout.Metrics.duration }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        let key: UITransitionContextViewControllerKey = presenting ? .to : .from
        guard let viewer = context.viewController(forKey: key) as? StoryViewerViewController else {
            context.completeTransition(true)
            return
        }
        let container = context.containerView
        let page = viewer.currentPage
        if presenting {
            viewer.view.frame = context.finalFrame(for: viewer)
            container.addSubview(viewer.view)
            viewer.view.layoutIfNeeded()
            // Laid out again now it has the window's safe area.
            page.setNeedsLayout()
            page.layoutIfNeeded()
            // Nothing takes a touch until it is open.
            viewer.view.isUserInteractionEnabled = false
        }
        // Closing goes into the circle of whoever it shows now.
        let source = presenting ? viewer.origin : viewer.closingOrigin
        let circle = source is StoriesCircleView
        let origin = source.flatMap { origin -> CGRect? in
            guard origin.window != nil, !origin.isHidden else { return nil }
            let frame = origin.convert(circle ? StoriesRowLayout.item.avatar : origin.bounds, to: container)
            return container.bounds.intersects(frame) ? frame : nil
        }
        // The page fills the screen at rest, so its space is the screen's.
        let opening = origin.map {
            StoryOpeningLayout(source: $0, sourceRadius: circle ? $0.width / 2 : source?.layer.cornerRadius ?? 0, sourceIsAvatar: circle, viewer: page.layout, height: container.bounds.height)
        }
        let M = StoryOpeningLayout.Metrics.self
        let ground = UIColor(Palette.storiesViewerGround)
        func move(_ duration: Double, _ changes: @escaping () -> Void, completion: (() -> Void)? = nil) {
            let animator = UIViewPropertyAnimator(duration: duration, timingParameters: UICubicTimingParameters(controlPoint1: M.curve.0, controlPoint2: M.curve.1))
            animator.isUserInteractionEnabled = true
            animator.addAnimations(changes)
            if let completion { animator.addCompletion { _ in completion() } }
            animator.startAnimation()
        }
        func fade(_ duration: Double, _ changes: @escaping () -> Void) {
            UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseInOut, .allowUserInteraction], animations: changes)
        }
        if presenting {
            viewer.view.backgroundColor = ground.withAlphaComponent(0)
            page.backgroundColor = .clear
            if let opening {
                // Out of the source, as Telegram's: the story through a window
                // that grows from it, the author's avatar leaving it for its
                // corner, the controls fading in, the bar rising from below.
                page.beginOpening()
                page.placeOpening(opening, atSource: true)
                page.showOpeningControls(false, opening: opening, duration: 0)
                page.placeOpeningBar(opening, risen: false)
                page.showOpeningBar(false)
                move(M.duration, { page.placeOpening(opening, atSource: false) }) {
                    page.endOpening()
                    page.backgroundColor = ground
                    viewer.view.isUserInteractionEnabled = true
                    context.completeTransition(!context.transitionWasCancelled)
                }
                fade(M.controlsFade) { page.showOpeningControls(true, opening: opening, duration: M.controlsFade) }
                move(M.barIn) { page.placeOpeningBar(opening, risen: true) }
                fade(M.groundIn) {
                    page.showOpeningBar(true)
                    viewer.view.backgroundColor = ground
                }
            } else {
                page.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
                page.alpha = 0
                UIView.animate(withDuration: M.duration, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
                    page.transform = .identity
                    page.alpha = 1
                    viewer.view.backgroundColor = ground
                } completion: { _ in
                    page.backgroundColor = ground
                    viewer.view.isUserInteractionEnabled = true
                    context.completeTransition(!context.transitionWasCancelled)
                }
            }
        } else {
            page.backgroundColor = .clear
            if let opening {
                // Back into the source, from wherever a drag left it.
                page.beginOpening()
                move(M.duration, {
                    page.transform = .identity
                    page.placeOpening(opening, atSource: true)
                }) {
                    context.completeTransition(!context.transitionWasCancelled)
                }
                fade(M.controlsFade) { page.showOpeningControls(false, opening: opening, duration: M.controlsFade) }
                move(M.barOut) {
                    page.placeOpeningBar(opening, risen: false)
                    page.showOpeningBar(false)
                }
                fade(M.groundOut) { viewer.view.backgroundColor = ground.withAlphaComponent(0) }
                return
            }
            UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: [.curveEaseInOut]) {
                // On from where a drag left it, never back up or larger.
                let dragged = page.transform
                let y = max(container.bounds.height * 0.3, dragged.ty + container.bounds.height * 0.15)
                let s = min(0.85, hypot(dragged.a, dragged.c) * 0.9)
                page.transform = CGAffineTransform(translationX: 0, y: y).scaledBy(x: s, y: s)
                page.alpha = 0
                viewer.view.backgroundColor = ground.withAlphaComponent(0)
            } completion: { _ in
                context.completeTransition(!context.transitionWasCancelled)
            }
        }
    }
}

extension StoryOpeningLayout.Placement {
    var transform: CGAffineTransform {
        CGAffineTransform(translationX: offset.x, y: offset.y).scaledBy(x: scale, y: scale)
    }
}

/// Opens the editor on a draft: the story a conversation drafted, from its
/// card's Edit. Stories are only ever started in a conversation.
@MainActor
enum StoriesEditorPresenter {
    static func present(session: StoriesSession, draft: Story, from host: UIViewController) {
        open(StoryEditorViewController(session: session, draft: StoryDraft(editing: draft)), from: host)
    }

    /// A new story on what was picked, not yet on the computer.
    static func present(session: StoriesSession, picked: [StoriesMediaChooser.Picked], from host: UIViewController) {
        guard !picked.isEmpty else { return }
        var draft = StoryDraft()
        var local: [String: StoryLocalMedia] = [:]
        for one in picked {
            draft.add(one.frame)
            local[one.frame.id] = one.local
        }
        draft.select(0)
        open(StoryEditorViewController(session: session, draft: draft, local: local), from: host)
    }

    /// Presents once what the host shows (a picker on its way out) is gone.
    private static func open(_ editor: StoryEditorViewController, from host: UIViewController, attempt: Int = 0) {
        if let shown = host.presentedViewController {
            guard shown.isBeingDismissed || attempt < 20 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { open(editor, from: host, attempt: attempt + 1) }
            return
        }
        host.present(editor, animated: true)
    }
}
#endif
