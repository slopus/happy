#if canImport(UIKit)
import HappyWire
import UIKit

/// The bar's Copy Link: what's on screen as an instance link
/// (`happy://<instanceId>/…`), which keeps naming this installation
/// outside Happy. Not offered when the daemon reports no `instanceId`.
@MainActor
enum CopyLinkItem {
    static func make(_ target: HappyLink.Target, instanceId: String?, identifier: String) -> UIBarButtonItem? {
        guard let instanceId, let link = HappyLink(target, instanceId: instanceId).url else { return nil }
        let item = UIBarButtonItem(image: .icon(.ionicons("link-outline"), size: 22), primaryAction: UIAction { _ in
            UIPasteboard.general.string = link
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            UIAccessibility.post(notification: .announcement, argument: Strings.InstanceLinks.copied)
        })
        item.accessibilityLabel = Strings.InstanceLinks.copyLink
        item.accessibilityIdentifier = identifier
        return item
    }
}
#endif
