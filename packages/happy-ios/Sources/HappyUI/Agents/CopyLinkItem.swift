#if canImport(UIKit)
import HappyCore
import HappyWire
import UIKit

/// Copy Link: what's on screen as its link.happy.page share link, which
/// carries the instance link (`happy://<instanceId>/…`) so it keeps naming
/// this installation outside Happy and opens from a browser. Named by what
/// it copies ("Copy link to task"), as desktop's are. Not offered when the
/// daemon reports no `instanceId`.
@MainActor
enum CopyLinkItem {
    /// The share link for `target` on the installation `instanceId`, saying
    /// what an agent is; nil without an installation.
    static func link(_ target: HappyLink.Target, as role: HappyShareLink.Role? = nil, instanceId: String?) -> String? {
        guard let instanceId, let url = HappyLink(target, instanceId: instanceId).url else { return nil }
        return HappyShareLink.format(url, as: role)
    }

    /// "Copy link to bot", "Copy link to artifact".
    static func title(_ target: HappyLink.Target, as role: HappyShareLink.Role?) -> String {
        guard case .reference(let reference) = target else { return Strings.InstanceLinks.copyLink }
        if reference.kind == .agent, let role { return Strings.InstanceLinks.copyLink(to: role.rawValue) }
        return reference.kind == .artifact ? Strings.InstanceLinks.copyLink(to: "artifact") : Strings.InstanceLinks.copyLink
    }

    static func copy(_ link: String) {
        UIPasteboard.general.string = link
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        UIAccessibility.post(notification: .announcement, argument: Strings.InstanceLinks.copied)
    }

    /// The bar's button.
    static func make(_ target: HappyLink.Target, as role: HappyShareLink.Role? = nil, instanceId: String?, identifier: String) -> UIBarButtonItem? {
        guard let link = link(target, as: role, instanceId: instanceId) else { return nil }
        let item = UIBarButtonItem(image: .icon(.ionicons("link-outline"), size: 22), primaryAction: UIAction { _ in copy(link) })
        item.accessibilityLabel = title(target, as: role)
        item.accessibilityIdentifier = identifier
        return item
    }

    /// A menu's item.
    static func action(_ target: HappyLink.Target, as role: HappyShareLink.Role? = nil, instanceId: String?, identifier: String) -> UIAction? {
        guard let link = link(target, as: role, instanceId: instanceId) else { return nil }
        return UIAction(title: title(target, as: role), image: Glyphs.image("link-outline", size: 20), identifier: .init(identifier)) { _ in copy(link) }
    }
}
#endif
