#if canImport(UIKit)
import UIKit

/// The header of a conversation that doesn't exist yet (new work, a legacy
/// compose chat) is Back alone: it is plainly the empty conversation, so
/// it needs no name, and composing another from it has nothing to leave.
/// From the first send the name's capsule fades in and Compose comes back
/// as the bar brings items in. Only the bar's own views animate, never
/// the screen's layout, which the transcript's first-send animation reads.
/// The capsule inside the title view fades, not the title view, whose
/// alpha the bar itself animates through every push and pop.
@MainActor
enum ConversationHeader {
    /// Mostly over early, as the first message's flight into the list is.
    static let fadeDuration: TimeInterval = 0.25

    static func show(_ shown: Bool, title: ChatHeaderView, items: [UIBarButtonItem], on navigationItem: UINavigationItem, animated: Bool) {
        title.isUserInteractionEnabled = shown
        title.accessibilityElementsHidden = !shown
        let alpha: CGFloat = shown ? 1 : 0
        if animated, title.window != nil {
            UIView.animate(withDuration: fadeDuration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
                title.capsule.alpha = alpha
            }
        } else {
            title.capsule.alpha = alpha
        }
        navigationItem.setRightBarButtonItems(shown ? items : nil, animated: animated && title.window != nil)
    }
}
#endif
