#if canImport(UIKit)
import HappyCore
import HappyStore
import UIKit
import UserNotifications

/// What analytics reads of the app's accounts. It reads which agent is
/// shown (the common properties, and which link `connection_issue` follows),
/// each Happy account's `analyticsOptOut` as its settings arrive, and the
/// state `daily_summary` reports. It reads only the accounts' kinds and
/// counts, never a name or an id that would be sent.
@MainActor
final class AnalyticsBridge {
    private let context: AppContext
    private var accounts: AccountsObservation?
    private var settings: StoreObservation?
    private var settingsSession: ObjectIdentifier?
    /// The open Happy account's Experiments switch; nil without one.
    private var experiments: Bool?

    init(context: AppContext) {
        self.context = context
        let account = context.account
        Analytics.shared.agent = { [weak account] in
            switch account?.state {
            case .signedIn?: .init(location: .relay)
            case .agentConnection?: .init(location: .remote)
            case .signedOut?, nil: nil
            }
        }
        Analytics.shared.dailyConfig = { [weak self, weak account] in
            var config = await Self.dailyConfig(account)
            config.experimentsOn = self?.experiments
            return config
        }
        accounts = account.observeAccounts { [weak self] summaries in self?.accountsChanged(summaries) }
    }

    private func accountsChanged(_ summaries: [AccountSummary]) {
        let account = context.account
        Analytics.shared.consent.keepAccounts(Set(summaries.filter { !$0.isAgentConnection }.map(\.id)))
        switch account.state {
        case .signedIn(let session):
            ConnectionWatch.shared.setActive(LegacyLink.watchID(session))
            follow(session)
        case .agentConnection(let connection):
            ConnectionWatch.shared.setActive("agent:\(connection.id)")
            follow(nil)
        case .signedOut:
            ConnectionWatch.shared.setActive(nil)
            follow(nil)
        }
    }

    /// The open Happy account's synced settings, for its `analyticsOptOut`.
    private func follow(_ session: AccountSession?) {
        let id = session.map(ObjectIdentifier.init)
        guard id != settingsSession else { return }
        settingsSession = id
        settings = nil
        experiments = nil
        guard let session else { return }
        let accountID = session.keys.anonID
        settings = session.store.observeSettings { [weak self] snapshot in
            let settings = AccountSettings(snapshot)
            Analytics.shared.consent.setAccount(accountID, optedOut: settings.analyticsOptOut)
            self?.experiments = settings.experiments
        }
    }

    private static func dailyConfig(_ account: AccountController?) async -> AnalyticsEvent.DailyConfig {
        guard let account else { return .init() }
        let theme: AnalyticsEvent.ThemeChoice = switch account.localSettings.themePreference {
        case .adaptive: .system
        case .light: .light
        case .dark: .dark
        }
        let notifications: AnalyticsEvent.NotificationsState = switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: .granted
        case .denied: .denied
        case .notDetermined: .notAsked
        @unknown default: .notAsked
        }
        let summaries = account.accounts
        let providers = Session.enabledProviders
        return .init(
            theme: theme,
            appLanguage: .init(code: AppLocalization.language),
            notifications: notifications,
            agentsConnected: .init(account.agentConnections.accounts.filter { !$0.revoked }.count),
            accounts: .init(summaries.filter { !$0.isAgentConnection }.count),
            providerKinds: providers.isEmpty ? nil : Set(providers.map { AnalyticsEvent.ProviderKind(type: $0.type) }).sorted { $0.rawValue < $1.rawValue },
            providerAccounts: providers.isEmpty ? nil : .init(providers.count)
        )
    }
}

extension UIViewController {
    /// In `viewDidAppear`: whether the screen was just opened, pushed or
    /// presented, rather than uncovered when what was over it went.
    var isOpening: Bool {
        isMovingToParent || isBeingPresented || navigationController?.isBeingPresented == true
    }
}
#endif
