#if canImport(UIKit)
import HappyLayout
import UIKit

/// Support us, in settings' cards, the same on a computer's page and a
/// Happy account's. A useful destination even before purchases are
/// configured: no purchase SDK is initialized and no paywall, restore, or
/// network request runs on opening it. Subscription access remains the
/// server's decision.
///
/// happy-app's SettingsView opens its hosted voluntary_support paywall;
/// its title, subtitle, heart and unavailable copy are retained here. Until
/// a purchase provider can verify this account's subscriptions, status is
/// unknown rather than "not subscribed". Add that provider here when its
/// configuration is available, keeping receipt validation on the server.
final class SupportUsViewController: SettingsPageViewController {
    private let openURL: @MainActor (URL) async -> Bool

    convenience init() {
        self.init(openURL: { await UIApplication.shared.open($0) })
    }

    /// The external URL boundary is injectable so tests never open a store
    /// or browser. It does not grant purchase or entitlement access.
    init(openURL: @escaping @MainActor (URL) async -> Bool) {
        self.openURL = openURL
        super.init(title: Strings.SupportUs.title)
    }

    /// Apple's account-wide subscription management page works independently
    /// of a purchase SDK. It makes no claim about this Happy account's status.
    static let manageSubscriptionsURL = URL(string: "https://apps.apple.com/account/subscriptions")!

    override func makeRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Text = Strings.SupportUs
        // Subscribing and restoring say why they can't be used, and do nothing.
        func unavailable(_ id: String, _ title: String, hint: String) -> Row {
            Row(id: id, title: title, value: Text.notAvailable, accessory: .none, dimmed: true, hint: hint)
        }
        return [
            [Row(id: "support-summary", title: Text.subtitle, icon: ("heart", .red), accessory: .none, footer: Text.unavailable)],
            [
                unavailable("subscribe", Text.subscribe, hint: Text.unavailable),
                unavailable("restore-purchases", Text.restore, hint: Text.restoreUnavailable),
            ].withFooter(Text.statusUnavailable),
            [link("manage-subscriptions", Text.manage, icon: ("card-outline", .blue), value: Text.appStore, url: Self.manageSubscriptionsURL, footer: Text.manageFooter)],
            [
                link("support-github", Strings.Settings.github, icon: ("logo-github", .gray), value: Strings.Links.githubDetail, url: Strings.Links.github),
                link("support-privacy", Strings.Settings.privacyPolicy, icon: ("shield-checkmark-outline", .blue), url: Strings.Links.privacy),
                link("support-terms", Strings.Settings.termsOfService, icon: ("document-text-outline", .gray), url: Strings.Links.terms),
            ],
        ]
    }

    private func link(_ id: String, _ title: String, icon: (String, SettingsRow.Tile), value: String? = nil, url: URL, footer: String? = nil) -> SettingsRow {
        SettingsRow(id: id, title: title, icon: icon, value: value, action: { [weak self] in self?.open(url) }, footer: footer)
    }

    private func open(_ url: URL) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if !(await openURL(url)), viewIfLoaded?.window != nil {
                Alerts.show(Strings.Common.error, Strings.SupportUs.linkFailed, on: self)
            }
        }
    }
}

extension Array where Element == SettingsRow {
    /// The card with `footer` under it, said by its last row.
    func withFooter(_ footer: String) -> [SettingsRow] {
        var rows = self
        if !rows.isEmpty { rows[rows.count - 1].footer = footer }
        return rows
    }
}
#endif
