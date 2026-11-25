#if canImport(UIKit)
import HappyCore
import UIKit

/// The viewers' slot as a header's bar item, on agent conversations and
/// every Surface screen. Only a team has viewers; a computer that turns
/// out not to serve them (an older daemon's 404) hides the item.
@MainActor
enum ViewersBar {
    /// The slot for `target` on a screen whose ground is `ground` (the
    /// faces' dot and badge are cut out of it), or nil outside a team.
    /// `changed` hears the item hidden or shown again.
    static func item(session: Session, target: ViewerTarget, ground: UIColor, changed: (() -> Void)? = nil) -> UIBarButtonItem? {
        guard session.isCloud || session.home.userId != nil else { return nil }
        let slot = ViewersSlotView(session: session, target: target, ground: ground)
        let item = UIBarButtonItem(customView: slot)
        // Faces in colour on the bar, not on a glass capsule of their own.
        if #available(iOS 26.0, *) { item.hidesSharedBackground = true }
        slot.onAvailable = { [weak item] available in
            guard let item, item.isHidden == available else { return }
            item.isHidden = !available
            changed?()
        }
        return item
    }
}
#endif
