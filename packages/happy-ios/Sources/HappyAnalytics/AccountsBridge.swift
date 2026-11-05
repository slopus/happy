import Foundation
import HappyCore
import HappyStore
#if canImport(UserNotifications) && os(iOS)
import UserNotifications
#endif

/// What analytics reads of the app's accounts. It reads which agent is
/// shown (the common properties, and which link `agent_connection_lost` follows),
/// each Happy account's `analyticsOptOut` as its settings arrive, and the
/// little `app_opened` carries. It reads only the accounts' kinds and
/// counts, never a name or an id that would be sent.
@MainActor
final class AccountsBridge {
    private weak var account: AccountController?
    private var accounts: AccountsObservation?
    private var settings: StoreObservation?
    private var settingsSession: ObjectIdentifier?

    init(account: AccountController) {
        self.account = account
        Analytics.shared.agent = { [weak account] in
            switch account?.state {
            case .signedIn?: .init(location: .relay)
            case .agentConnection?: .init(location: .remote)
            case .signedOut?, nil: nil
            }
        }
        Analytics.shared.appConfig = { [weak account] in await Self.appConfig(account) }
        accounts = account.observeAccounts { [weak self] summaries in self?.accountsChanged(summaries) }
    }

    /// The accounts are restored: every signed-in account's stored setting
    /// is read, and only then may anything go.
    func restored() async {
        guard let account else { return }
        let optOuts = await account.analyticsOptOuts()
        Analytics.shared.consent.settle(optOuts)
    }

    private func accountsChanged(_ summaries: [AccountSummary]) {
        guard let account else { return }
        Analytics.shared.consent.keepAccounts(Set(summaries.filter { !$0.isAgentConnection }.map(\.id)))
        switch account.state {
        case .signedIn(let session):
            ConnectionWatch.shared.setActive(Analytics.watchID(session))
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

    private static func appConfig(_ account: AccountController?) async -> AnalyticsEvent.AppConfig {
        guard let account else { return .init() }
        #if canImport(UserNotifications) && os(iOS)
        let notifications: AnalyticsEvent.NotificationsState = switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: .granted
        case .denied: .denied
        case .notDetermined: .notAsked
        @unknown default: .notAsked
        }
        #else
        let notifications: AnalyticsEvent.NotificationsState? = nil
        #endif
        return AnalyticsEvent.AppConfig(
            appLanguage: .init(code: AppLocalization.language),
            notifications: notifications,
            agentsConnected: .init(account.agentConnections.accounts.filter { !$0.revoked }.count)
        )
    }
}

extension Analytics {
    /// Follows the app's accounts, once, at launch: which agent is shown,
    /// each Happy account's `analyticsOptOut`, and what `app_opened` says.
    public func follow(_ account: AccountController) {
        accountsBridge = AccountsBridge(account: account)
    }

    /// The accounts are restored: once every signed-in account's stored
    /// setting is read, what waited may go.
    public func accountsRestored() async {
        await accountsBridge?.restored()
    }
}
