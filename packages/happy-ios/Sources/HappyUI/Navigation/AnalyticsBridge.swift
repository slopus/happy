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
        Analytics.shared.dailyConfig = { [weak account] in
            await Self.dailyConfig(account)
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
        guard let session else { return }
        let accountID = session.keys.anonID
        settings = session.store.observeSettings { snapshot in
            Analytics.shared.consent.setAccount(accountID, optedOut: AccountSettings(snapshot).analyticsOptOut)
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
        return .init(
            theme: theme,
            appLanguage: .init(code: AppLocalization.language),
            notifications: notifications,
            agentsConnected: .init(account.agentConnections.accounts.filter { !$0.revoked }.count),
            accounts: .init(summaries.filter { !$0.isAgentConnection }.count)
        )
    }
}
#endif
