#if canImport(UIKit)
import HappyLayout
import UIKit

/// A screen that can't be left by dragging it away (one mid-way through
/// something that must be finished or cancelled with its buttons).
@MainActor
protocol SwipeBackRefusing: UIViewController {
    var allowsSwipeBack: Bool { get }
}

/// Going back by dragging the pushed screen right from anywhere on it, as
/// Telegram does: `SwipeBack` in HappyLayout decides when the drag starts
/// and where everything is; this drives UIKit's own pop with it. It
/// replaces UIKit's edge-only gesture, which hidden or custom bars used to
/// switch off.
@MainActor
final class SwipeBackController: NSObject, UIGestureRecognizerDelegate {
    private weak var navigation: UINavigationController?
    let gesture = SwipeBackGestureRecognizer()
    /// The pop the finger is driving, from the drag's start until the pop
    /// has ended.
    private(set) var interaction: SwipeBackInteraction?

    init(navigation: UINavigationController) {
        self.navigation = navigation
        super.init()
        navigation.interactivePopGestureRecognizer?.isEnabled = false
        if #available(iOS 26.0, *) {
            navigation.interactiveContentPopGestureRecognizer?.isEnabled = false
        }
        gesture.addTarget(self, action: #selector(pan(_:)))
        gesture.delegate = self
        gesture.maximumNumberOfTouches = 1
        navigation.view.addGestureRecognizer(gesture)
    }

    /// Whether the delegate should hand UIKit the swipe's animator.
    var isInteractive: Bool { interaction != nil }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let navigation, navigation.viewControllers.count > 1, navigation.transitionCoordinator == nil,
              navigation.presentedViewController == nil else { return false }
        if let top = navigation.topViewController as? SwipeBackRefusing, !top.allowsSwipeBack { return false }
        return SwipeBack.shouldBegin(velocity: gesture.velocity(in: navigation.view))
    }

    /// Other drags wait for this one to fail, as Telegram's do (NC:202-210);
    /// it fails within a couple of points of anything but a drag right.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        other is UIPanGestureRecognizer && other.view?.isDescendant(of: gestureRecognizer.view ?? UIView()) == true
    }

    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        guard let view = navigation?.view else { return }
        let translation = gesture.translation(in: view).x
        switch gesture.state {
        case .began: begin()
        case .changed: update(translation: translation)
        case .ended: end(translation: translation, velocity: gesture.velocity(in: view).x, lifted: true)
        case .cancelled, .failed: end(translation: translation, velocity: 0, lifted: false)
        default: break
        }
    }

    /// The drag decided to go back: UIKit's pop, driven from here.
    func begin() {
        guard let navigation, interaction == nil else { return }
        let interaction = SwipeBackInteraction()
        interaction.completionCurve = .easeInOut
        interaction.onEnd = { [weak self, weak interaction] in
            if self?.interaction === interaction { self?.interaction = nil }
        }
        self.interaction = interaction
        if navigation.popViewController(animated: true) == nil { self.interaction = nil }
    }

    func update(translation: CGFloat) {
        guard let width = navigation?.view.bounds.width else { return }
        interaction?.drive(SwipeBack.progress(translation: translation, width: width))
    }

    /// The finger let go (`lifted`), or the drag was taken away: on to
    /// the screen under it, or back to where it was.
    func end(translation: CGFloat, velocity: CGFloat, lifted: Bool) {
        guard let interaction, let width = navigation?.view.bounds.width else { return }
        let progress = SwipeBack.progress(translation: translation, width: width)
        let driven = SwipeBackAnimator.drivenDuration
        interaction.drive(progress)
        if lifted, SwipeBack.completes(progress: progress, velocity: velocity) {
            let duration = SwipeBack.finishDuration(progress: progress, width: width, velocity: velocity)
            interaction.settle(finish: true, speed: max(0.01, (1 - progress) * driven / duration))
        } else {
            interaction.settle(finish: false, speed: max(0.01, progress * driven / SwipeBack.Metrics.cancelDuration))
        }
    }
}

/// UIKit starts a pop on a later turn of the run loop, and ignores
/// `update`, `finish` and `cancel` until it has: a quick flick can end
/// before then. This keeps where the finger last was and how it let go,
/// and applies them once the pop has started.
final class SwipeBackInteraction: UIPercentDrivenInteractiveTransition {
    /// The pop is over, gone on or gone back.
    var onEnd: (() -> Void)?
    private var started = false
    private var progress: CGFloat = 0
    private var ending: (finish: Bool, speed: CGFloat)?

    override func startInteractiveTransition(_ transitionContext: any UIViewControllerContextTransitioning) {
        super.startInteractiveTransition(transitionContext)
        started = true
        update(progress)
        // Finished inside its own start, the pop never runs on: UIKit is
        // still setting it up. The next turn it can.
        if let ending { DispatchQueue.main.async { self.apply(ending) } }
    }

    func drive(_ progress: CGFloat) {
        self.progress = progress
        if started, ending == nil { update(progress) }
    }

    func settle(finish: Bool, speed: CGFloat) {
        guard ending == nil else { return }
        ending = (finish, speed)
        if started { apply((finish, speed)) }
    }

    private func apply(_ ending: (finish: Bool, speed: CGFloat)) {
        completionSpeed = ending.speed
        if ending.finish { finish() } else { cancel() }
    }

    /// Called by the animator as the pop completes.
    func ended() {
        onEnd?()
        onEnd = nil
    }
}

/// A pan that only starts once `SwipeBack.decide` says the drag goes back,
/// and gives way to a scroll or a swipe left at once. On something that
/// drags sideways itself (a horizontal scroller, a text selection), only
/// the left edge goes back (ITGR:114-116).
final class SwipeBackGestureRecognizer: UIPanGestureRecognizer {
    private var start: CGPoint?
    private var edgeOnly = false
    private var decided = false

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let view, let touch = touches.first, touches.count == 1 else { state = .failed; return }
        let location = touch.location(in: view)
        edgeOnly = Self.dragsSideways(touch.view, below: view)
        guard SwipeBack.allows(startX: location.x, width: view.bounds.width, edgeOnly: edgeOnly) else { state = .failed; return }
        start = location
        decided = false
        super.touchesBegan(touches, with: event)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard !decided else { return super.touchesMoved(touches, with: event) }
        guard let view, let start, let touch = touches.first else { return }
        let location = touch.location(in: view)
        let translation = CGPoint(x: location.x - start.x, y: location.y - start.y)
        switch SwipeBack.decide(startX: start.x, width: view.bounds.width, translation: translation, edgeOnly: edgeOnly) {
        case .undecided:
            return
        case .fail:
            state = .failed
        case .begin:
            decided = true
            super.touchesMoved(touches, with: event)
        }
    }

    override func reset() {
        super.reset()
        start = nil
        decided = false
        edgeOnly = false
    }

    /// Something between the touched view and the stack's view that takes
    /// a sideways drag of its own.
    private static func dragsSideways(_ touched: UIView?, below root: UIView) -> Bool {
        var view = touched
        while let current = view, current !== root {
            if let text = current as? UITextView, text.isFirstResponder, text.selectedRange.length > 0 { return true }
            if let field = current as? UITextField, field.isFirstResponder { return true }
            if let scroll = current as? UIScrollView, !(current is UITextView), scroll.isScrollEnabled,
               scroll.contentSize.width > scroll.bounds.width + 1 {
                return true
            }
            if current is UISlider || current is UISwitch { return true }
            view = current.superview
        }
        return false
    }
}

/// Telegram's pop (NTC:141-176): the screen leaving follows the finger,
/// the one under it comes back from 30% to the left, dimmed, with a
/// shadow along the leaving screen's edge. Driven linearly by the finger;
/// `SwipeBack.frames` is linear in progress, so its ends are all it needs.
final class SwipeBackAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    /// The finger's pop this animates; told when it is over.
    weak var interaction: SwipeBackInteraction?

    init(interaction: SwipeBackInteraction?) {
        self.interaction = interaction
    }

    /// The length of the driven animation; the finger sets where in it,
    /// and the completion speed how fast the rest goes.
    static let drivenDuration: TimeInterval = 0.5

    func transitionDuration(using transitionContext: (any UIViewControllerContextTransitioning)?) -> TimeInterval {
        Self.drivenDuration
    }

    /// The pop's one animator: UIKit's percent-driven transition scrubs it
    /// with the finger and runs it on, or back, when the finger lets go.
    /// (A plain `UIView.animate` paused in the container's layer was never
    /// run on by `finish()`, and the pop hung half-way.)
    private var animator: UIViewPropertyAnimator?

    func animateTransition(using context: any UIViewControllerContextTransitioning) {
        interruptibleAnimator(using: context).startAnimation()
    }

    func interruptibleAnimator(using context: any UIViewControllerContextTransitioning) -> any UIViewImplicitlyAnimating {
        if let animator { return animator }
        let animator = UIViewPropertyAnimator(duration: Self.drivenDuration, curve: .linear)
        self.animator = animator
        guard let fromVC = context.viewController(forKey: .from), let toVC = context.viewController(forKey: .to),
              let from = context.view(forKey: .from) ?? fromVC.view, let to = context.view(forKey: .to) ?? toVC.view else {
            animator.addCompletion { _ in context.completeTransition(false) }
            return animator
        }
        let container = context.containerView
        let width = container.bounds.width
        let scale = container.traitCollection.displayScale
        to.frame = context.finalFrame(for: toVC)
        container.insertSubview(to, belowSubview: from)
        let dim = UIView(frame: container.bounds)
        dim.backgroundColor = .black
        dim.isUserInteractionEnabled = false
        container.insertSubview(dim, aboveSubview: to)
        let shadow = SwipeBackShadowView(frame: CGRect(x: from.frame.minX - SwipeBack.Metrics.shadowWidth, y: from.frame.minY,
                                                       width: SwipeBack.Metrics.shadowWidth, height: from.frame.height))
        container.insertSubview(shadow, belowSubview: from)

        func apply(_ frames: SwipeBack.Frames) {
            from.transform = CGAffineTransform(translationX: frames.topX, y: 0)
            shadow.transform = CGAffineTransform(translationX: frames.topX, y: 0)
            to.transform = CGAffineTransform(translationX: frames.bottomX, y: 0)
            dim.alpha = frames.dimAlpha
            shadow.alpha = frames.shadowAlpha
        }
        apply(SwipeBack.frames(progress: 0, width: width, scale: scale))
        animator.addAnimations {
            apply(SwipeBack.frames(progress: 1, width: width, scale: scale))
        }
        animator.addCompletion { [weak self] _ in
            let cancelled = context.transitionWasCancelled
            from.transform = .identity
            to.transform = .identity
            dim.removeFromSuperview()
            shadow.removeFromSuperview()
            if cancelled { to.removeFromSuperview() }
            context.completeTransition(!cancelled)
            self?.interaction?.ended()
            self?.animator = nil
        }
        return animator
    }
}

/// Clear to dark, left to right, ending at the leaving screen's edge.
private final class SwipeBackShadowView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        let gradient = layer as! CAGradientLayer
        gradient.colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.withAlphaComponent(0.2).cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }
}
#endif
