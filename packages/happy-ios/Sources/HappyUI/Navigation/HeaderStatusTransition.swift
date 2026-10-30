#if canImport(UIKit)
import UIKit

@MainActor
enum HeaderStatusTransition {
    static func apply(to view: UIView, change: @escaping () -> Void) {
        guard view.window != nil, UIView.areAnimationsEnabled, !UIAccessibility.isReduceMotionEnabled else {
            change()
            return
        }
        UIView.transition(with: view, duration: 0.2,
                          options: [.transitionCrossDissolve, .beginFromCurrentState, .allowUserInteraction],
                          animations: change)
    }
}
#endif