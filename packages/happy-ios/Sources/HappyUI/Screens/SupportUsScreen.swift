#if canImport(UIKit)
import HappyLayout
import UIKit

/// A useful destination even before purchases are configured. No purchase
/// SDK is initialized and no paywall, restore, or network request runs on
/// opening this screen. Subscription access remains the server's decision.
///
/// happy-app's SettingsView opens its hosted voluntary_support paywall;
/// its title, subtitle, heart and unavailable copy are retained here. Until
/// a purchase provider can verify this account's subscriptions, status is
/// unknown rather than "not subscribed". Add that provider here when its
/// configuration is available, keeping receipt validation on the server.
public final class SupportUsViewController: UIViewController {
    private let openURL: @MainActor (URL) async -> Bool
    private let list = GroupedListView()

    public convenience init() {
        self.init(openURL: { await UIApplication.shared.open($0) })
    }

    /// The external URL boundary is injectable so tests never open a store
    /// or browser. It does not grant purchase or entitlement access.
    init(openURL: @escaping @MainActor (URL) async -> Bool) {
        self.openURL = openURL
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = list
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.SupportUs.title
        showsBackTitle()

        let support = ItemRowView(
            title: Strings.SupportUs.title,
            subtitle: Strings.SupportUs.subtitle,
            icon: ItemIcon(.ionicons("heart"), tint: Palette.iconRed)
        )
        support.accessibilityIdentifier = "supportUs.summary"

        let subscribe = unavailableRow(
            title: Strings.SupportUs.subscribe,
            explanation: Strings.SupportUs.unavailable,
            identifier: "supportUs.subscribe"
        )
        let restore = unavailableRow(
            title: Strings.SupportUs.restore,
            explanation: Strings.SupportUs.restoreUnavailable,
            identifier: "supportUs.restore"
        )
        let manage = linkRow(
            title: Strings.SupportUs.manage,
            subtitle: Strings.SupportUs.appStore,
            icon: ItemIcon(.ionicons("card-outline"), tint: Palette.iconBlue),
            url: Self.manageSubscriptionsURL,
            identifier: "supportUs.manage"
        )

        // Existing measured components own all frames. Their pure layouts
        // grow with content/text size and the list scrolls on small screens.
        list.sections = [
            ItemGroupView(footer: Strings.SupportUs.unavailable, rows: [support]),
            ItemGroupView(
                title: Strings.SupportUs.subscriptions,
                footer: Strings.SupportUs.statusUnavailable,
                rows: [subscribe, restore]
            ),
            ItemGroupView(footer: Strings.SupportUs.manageFooter, rows: [manage]),
            ItemGroupView(rows: [
                linkRow(
                    title: Strings.Settings.github,
                    subtitle: Strings.Links.githubDetail,
                    icon: ItemIcon(.ionicons("logo-github"), tint: Palette.text),
                    url: Strings.Links.github,
                    identifier: "supportUs.project"
                ),
                linkRow(
                    title: Strings.Settings.privacyPolicy,
                    icon: ItemIcon(.ionicons("shield-checkmark-outline"), tint: Palette.iconBlue),
                    url: Strings.Links.privacy,
                    identifier: "supportUs.privacy"
                ),
                linkRow(
                    title: Strings.Settings.termsOfService,
                    icon: ItemIcon(.ionicons("document-text-outline"), tint: Palette.iconBlue),
                    url: Strings.Links.terms,
                    identifier: "supportUs.terms"
                ),
            ]),
        ]
        // Groups configure row dividers, which reapplies ItemRowView's
        // default enabled state. Apply the unavailable state afterward.
        for row in [subscribe, restore] {
            row.isEnabled = false
            row.titleLabel.color = Palette.textSecondary
        }
        // These short groups can grow vertically. Keep all their words
        // visible at accessibility text sizes instead of Item's usual caps.
        for group in list.sections.compactMap({ $0 as? ItemGroupView }) {
            for row in group.rows.compactMap({ $0 as? ItemRowView }) {
                row.titleLabel.numberOfLines = 0
                row.subtitleLabel.numberOfLines = 0
            }
        }
    }

    /// Apple's account-wide subscription management page works independently
    /// of a purchase SDK. It makes no claim about this Happy account's status.
    static let manageSubscriptionsURL = URL(string: "https://apps.apple.com/account/subscriptions")!

    private func unavailableRow(title: String, explanation: String, identifier: String) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: Strings.SupportUs.notAvailable)
        row.accessibilityHint = explanation
        row.accessibilityIdentifier = identifier
        return row
    }

    private func linkRow(
        title: String,
        subtitle: String? = nil,
        icon: ItemIcon,
        url: URL,
        identifier: String
    ) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: subtitle, icon: icon) { [weak self] in
            guard let self else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if !(await self.openURL(url)), self.viewIfLoaded?.window != nil {
                    Alerts.show(Strings.Common.error, Strings.SupportUs.linkFailed, on: self)
                }
            }
        }
        row.accessibilityIdentifier = identifier
        return row
    }
}
#endif
