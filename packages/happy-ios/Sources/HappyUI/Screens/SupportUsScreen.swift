#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Support us, in a Happy account's settings' cards (an agent connection's
/// has Support Happy's boba row instead). Subscribe pushes Support Happy's
/// page (`SupportViewController`, always, on sale or not); Restore
/// restores, on the tap only; a subscriber is thanked. Nothing restores or charges on opening it.
/// The relay's voice access remains the server's decision.
///
/// happy-app's SettingsView opens its hosted voluntary_support paywall;
/// its title, subtitle, heart and unavailable copy are retained here.
final class SupportUsViewController: SettingsPageViewController {
    private let openURL: @MainActor (URL) async -> Bool
    private var observation: SubscriptionObservation?

    convenience init() {
        self.init(openURL: { await UIApplication.shared.open($0) })
    }

    /// The external URL boundary is injectable so tests never open a store
    /// or browser. It does not grant purchase or entitlement access.
    init(openURL: @escaping @MainActor (URL) async -> Bool) {
        self.openURL = openURL
        super.init(title: Strings.SupportUs.title)
        observation = Offers.shared.observe { [weak self] in self?.reload() }
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
        let offers = Offers.shared
        let offer = offers.offer
        let summary = offer == .subscribed
            ? Row(id: "support-summary", title: Text.thankYou, icon: ("heart", .red), accessory: .none)
            : Row(id: "support-summary", title: Text.subtitle, icon: ("heart", .red), accessory: .none, footer: offer.onSale ? nil : Text.unavailable)
        var purchases: [Row] = []
        if offer != .subscribed {
            purchases.append(offer.price.map { price in
                Row(id: "subscribe", title: Text.subscribe, value: Strings.AgentVoice.perMonth(price), action: { [weak self] in self?.navigationController?.pushViewController(SupportViewController(), animated: true) })
            } ?? unavailable("subscribe", Text.subscribe, hint: Text.unavailable))
        }
        purchases.append(offers.canRestore
            ? Row(id: "restore-purchases", title: Text.restore, action: { [weak self] in
                guard let self else { return }
                Task { await Offers.shared.restore(from: self) }
            })
            : unavailable("restore-purchases", Text.restore, hint: Text.restoreUnavailable))
        return [
            [summary],
            offers.canRestore ? purchases : purchases.withFooter(Text.statusUnavailable),
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
