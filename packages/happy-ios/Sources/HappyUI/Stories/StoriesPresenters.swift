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

/// The viewer grows from what it opened from: its canvas starts as the
/// row's circle, round, or as the story drawn inline, with its corners,
/// and becomes the story. Closing it shrinks it back, or, with that out of
/// sight, lets it fall away.
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

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval { presenting ? 0.38 : 0.3 }

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
        }
        let circle = viewer.origin is StoriesCircleView
        let origin = viewer.origin.flatMap { origin -> CGRect? in
            guard origin.window != nil, !origin.isHidden else { return nil }
            let frame = origin.convert(circle ? StoriesRowLayout.item.avatar : origin.bounds, to: container)
            return container.bounds.intersects(frame) ? frame : nil
        }
        let shrunk = origin.map { Self.transform(page: page, canvas: page.canvas.frame, to: $0) }
        let radius = page.canvas.layer.cornerRadius
        // The corners it starts and ends with, before the page's scale.
        let scale = origin.map { page.canvas.frame.width > 0 ? $0.width / page.canvas.frame.width : 1 } ?? 1
        let shrunkRadius = circle ? page.canvas.bounds.width / 2 : (viewer.origin?.layer.cornerRadius ?? 0) / max(scale, 0.01)
        let ground = UIColor(Palette.storiesViewerGround)
        if presenting {
            viewer.view.backgroundColor = ground.withAlphaComponent(0)
            page.backgroundColor = .clear
            if let shrunk {
                page.transform = shrunk
                page.canvas.layer.cornerRadius = shrunkRadius
            } else {
                page.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
                page.alpha = 0
            }
            UIView.animate(withDuration: transitionDuration(using: context), delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
                page.transform = .identity
                page.alpha = 1
                page.canvas.layer.cornerRadius = radius
                viewer.view.backgroundColor = ground
            } completion: { _ in
                page.backgroundColor = ground
                context.completeTransition(!context.transitionWasCancelled)
            }
        } else {
            page.backgroundColor = .clear
            let start = viewer.view.backgroundColor
            viewer.view.backgroundColor = start
            UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: [.curveEaseInOut]) {
                if let shrunk {
                    page.transform = shrunk
                    page.canvas.layer.cornerRadius = shrunkRadius
                    page.alpha = 0
                } else {
                    page.transform = CGAffineTransform(translationX: 0, y: container.bounds.height * 0.3).scaledBy(x: 0.85, y: 0.85)
                    page.alpha = 0
                }
                viewer.view.backgroundColor = ground.withAlphaComponent(0)
            } completion: { _ in
                context.completeTransition(!context.transitionWasCancelled)
            }
        }
    }

    /// Maps the page so its canvas sits on `target`, the circle's avatar.
    static func transform(page: UIView, canvas: CGRect, to target: CGRect) -> CGAffineTransform {
        guard canvas.width > 0 else { return .identity }
        let scale = target.width / canvas.width
        let center = CGPoint(x: page.bounds.midX, y: page.bounds.midY)
        let canvasCenter = CGPoint(x: canvas.midX, y: canvas.midY)
        let tx = target.midX - center.x - scale * (canvasCenter.x - center.x)
        let ty = target.midY - center.y - scale * (canvasCenter.y - center.y)
        return CGAffineTransform(translationX: tx, y: ty).scaledBy(x: scale, y: scale)
    }
}

/// Opens the editor on a new draft, or on `draft`.
@MainActor
enum StoriesEditorPresenter {
    static func present(session: StoriesSession, draft: Story?, from host: UIViewController) {
        _ = (session, draft, host)
    }
}
#endif
