#if canImport(UIKit)
import UIKit

/// A screen that brings its own push (as it comes in) and pop (as it goes)
/// with the screen under it; nil leaves UIKit's slide. The stack's delegate
/// asks it.
@MainActor
protocol NavigationTransitionProviding: AnyObject {
    func navigationTransition(_ operation: UINavigationController.Operation, other: UIViewController) -> UIViewControllerAnimatedTransitioning?
}

/// A transition a finger may drive: the interaction it brings, if one is.
@MainActor
protocol InteractiveNavigationTransition: AnyObject {
    var interaction: UIViewControllerInteractiveTransitioning? { get }
}

/// A screen with home's dock: the composer new work opens on.
@MainActor
protocol StemCellsDockHosting: UIViewController {
    var newWorkDock: UIView { get }
}

/// New work from home's dock without going anywhere: the conversation's
/// composer is drawn where the dock is and rides the keyboard up, while the
/// rest of new work (its ground, intro and glass header) fades in
/// over the sidebar. Popping is the same backwards, the keyboard going down
/// with the composer to the dock; an edge swipe drives it with the finger.
@MainActor
final class StemCellsNewWorkTransition: NSObject, UIViewControllerAnimatedTransitioning, InteractiveNavigationTransition {
    static let duration: TimeInterval = 0.35

    private let operation: UINavigationController.Operation
    private weak var chat: StemCellChatViewController?
    private weak var home: StemCellsDockHosting?
    let interaction: UIViewControllerInteractiveTransitioning?
    private var animator: UIViewPropertyAnimator?

    init(_ operation: UINavigationController.Operation, chat: StemCellChatViewController, home: StemCellsDockHosting, interaction: UIViewControllerInteractiveTransitioning?) {
        self.operation = operation
        self.chat = chat
        self.home = home
        self.interaction = interaction
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { Self.duration }

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        interruptibleAnimator(using: transitionContext).startAnimation()
        // Asked once the transition runs, so the composer rides the
        // keyboard's own animation rather than jumping ahead of it.
        if operation == .push {
            DispatchQueue.main.async { [chat] in chat?.takeOpeningFocus() }
        }
    }

    func interruptibleAnimator(using transitionContext: UIViewControllerContextTransitioning) -> UIViewImplicitlyAnimating {
        if let animator { return animator }
        let container = transitionContext.containerView
        let pushing = operation == .push
        let chat = chat
        let dock = home?.newWorkDock
        if let to = transitionContext.viewController(forKey: .to), let view = transitionContext.view(forKey: .to) {
            view.frame = transitionContext.finalFrame(for: to)
            if pushing {
                container.addSubview(view)
            } else if let from = transitionContext.view(forKey: .from) {
                container.insertSubview(view, belowSubview: from)
            }
            view.layoutIfNeeded()
        }
        // The conversation's composer stands in for the dock the whole way;
        // one holding something the dock doesn't crossfades with it.
        let standsIn = chat?.composerIsEmpty ?? true
        dock?.alpha = 0
        chat?.newWorkFade(pushing ? 0 : 1)
        let animator = UIViewPropertyAnimator(duration: Self.duration, curve: .easeInOut) {
            chat?.newWorkFade(pushing ? 1 : 0)
            if !pushing, !standsIn { dock?.alpha = 1 }
        }
        animator.addCompletion { [weak self] _ in
            let cancelled = transitionContext.transitionWasCancelled
            dock?.alpha = 1
            chat?.newWorkFade(1)
            if cancelled, !pushing { chat?.newWorkPopCancelled() }
            transitionContext.completeTransition(!cancelled)
            self?.animator = nil
        }
        self.animator = animator
        return animator
    }
}
#endif
