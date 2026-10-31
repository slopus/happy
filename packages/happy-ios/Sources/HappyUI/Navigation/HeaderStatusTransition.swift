#if canImport(UIKit)
import UIKit

@MainActor
enum HeaderStatusTransition {
    static func apply(to view: UIView, change: @escaping () -> Void) {
        guard animates(view) else {
            change()
            return
        }
        UIView.transition(with: view, duration: duration,
                          options: [.transitionCrossDissolve, .beginFromCurrentState, .allowUserInteraction],
                          animations: change)
    }

    /// What holds the status is laid out again for its new width, in the
    /// crossfade's time.
    static func relayout(_ view: UIView) {
        view.setNeedsLayout()
        guard animates(view) else { return }
        UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseInOut]) {
            view.layoutIfNeeded()
        }
    }

    private static let duration = 0.2

    private static func animates(_ view: UIView) -> Bool {
        view.window != nil && UIView.areAnimationsEnabled && !UIAccessibility.isReduceMotionEnabled
    }
}
#endif
