#if canImport(UIKit)
import UIKit

/// A screen that brings its own push (as it comes in) and pop (as it goes)
/// with the screen under it; nil leaves UIKit's slide. The stack's delegate
/// asks it.
@MainActor
protocol NavigationTransitionProviding: AnyObject {
    func navigationTransition(_ operation: UINavigationController.Operation, other: UIViewController) -> UIViewControllerAnimatedTransitioning?
}

/// A screen with home's dock: the composer new work opens on.
@MainActor
protocol StemCellsDockHosting: UIViewController {
    var newWorkDock: UIView { get }
}

/// New work from home's dock without going anywhere: the conversation's
/// composer is drawn where the dock is and rides the keyboard up, while the
/// rest of new work (its ground, intro and glass header) fades in
/// over the sidebar. Going back uses UIKit's normal navigation transition.
@MainActor
final class StemCellsNewWorkTransition: NSObject, UIViewControllerAnimatedTransitioning {
    static let duration: TimeInterval = 0.35

    private weak var chat: StemCellChatViewController?
    private weak var home: StemCellsDockHosting?
    private var animator: UIViewPropertyAnimator?

    init(chat: StemCellChatViewController, home: StemCellsDockHosting) {
        self.chat = chat
        self.home = home
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { Self.duration }

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        interruptibleAnimator(using: transitionContext).startAnimation()
        // Asked once the transition runs, so the composer rides the
        // keyboard's own animation rather than jumping ahead of it.
        DispatchQueue.main.async { [chat] in chat?.takeOpeningFocus() }
    }

    func interruptibleAnimator(using transitionContext: UIViewControllerContextTransitioning) -> UIViewImplicitlyAnimating {
        if let animator { return animator }
        let container = transitionContext.containerView
        let chat = chat
        let dock = home?.newWorkDock
        if let to = transitionContext.viewController(forKey: .to), let view = transitionContext.view(forKey: .to) {
            view.frame = transitionContext.finalFrame(for: to)
            container.addSubview(view)
            view.layoutIfNeeded()
        }
        // The conversation's composer stands in for the dock the whole way.
        dock?.alpha = 0
        chat?.newWorkFade(0)
        let animator = UIViewPropertyAnimator(duration: Self.duration, curve: .easeInOut) {
            chat?.newWorkFade(1)
        }
        animator.addCompletion { [weak self] _ in
            let cancelled = transitionContext.transitionWasCancelled
            dock?.alpha = 1
            chat?.newWorkFade(1)
            transitionContext.completeTransition(!cancelled)
            self?.animator = nil
        }
        self.animator = animator
        return animator
    }
}
#endif
