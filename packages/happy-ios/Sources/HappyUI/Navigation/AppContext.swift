#if canImport(UIKit)
import HappyCore
import HappyWire
import UIKit

/// What every screen needs: the account and facts about this build.
@MainActor
public final class AppContext {
    public let account: AccountController
    public let variant: AppVariant
    public let version: String
    /// The build number (`CFBundleVersion`): every build of a version
    /// carries the same CalVer one and differs only by this.
    public let build: String?

    public init(account: AccountController, variant: AppVariant, version: String, build: String? = nil) {
        self.account = account
        self.variant = variant
        self.version = version
        self.build = build
    }

    /// The custom server's host (and port), shown under the title; nil on
    /// the default server.
    var customServerHost: String? {
        account.serverConfig.isCustomServer ? account.serverConfig.displayHost : nil
    }

    private var restoring: Task<Void, Never>?

    /// The stored accounts, read once however many ask: the window's
    /// coordinator, or Siri in an app launched with no window. The first
    /// to ask chooses what opens.
    public func restoreAccounts(openingAgentConnection: Bool = false, preferred: String? = nil) async {
        if restoring == nil {
            account.fallsBackToAgentConnection = true
            let account = account
            restoring = Task { await account.restore(openingAgentConnection: openingAgentConnection, preferred: preferred) }
        }
        await restoring?.value
    }

    /// The window is in the foreground; before a scene says so, whatever
    /// the app's state was when this context was made.
    private lazy var windowActive = UIApplication.shared.applicationState != .background
    private var connectionHolds = 0

    /// The window came to the foreground or left it.
    public func windowChanged(active: Bool) {
        windowActive = active
        applyForeground(always: true)
    }

    /// The agent connection kept running as in the foreground, with no
    /// window in front, until the returned closure is called: Siri's
    /// intents while they answer. Returns once the connection was told.
    public func holdConnection() async -> @MainActor () -> Void {
        connectionHolds += 1
        await applyForeground().value
        var released = false
        return { [weak self] in
            guard let self, !released else { return }
            released = true
            self.connectionHolds -= 1
            self.applyForeground()
        }
    }

    private var toldActive: Bool?

    /// A hold tells the connections only a change; the window, every
    /// time, as it always has. A later change overtakes one under way
    /// (`AgentConnections.setForeground`).
    @discardableResult
    private func applyForeground(always: Bool = false) -> Task<Void, Never> {
        let active = windowActive || connectionHolds > 0
        guard always || active != toldActive else { return Task {} }
        toldActive = active
        let connections = account.agentConnections
        return Task { @MainActor in await connections.setForeground(active) }
    }
}

/// Scanning and answering pairing codes: connecting a terminal
/// (useConnectTerminal.ts) and linking another device (useConnectAccount.ts).
@MainActor
enum LegacyPairingFlow {
    enum Kind {
        case terminal
        case account
    }

    typealias Outcome = LegacyPairingResult

    /// Approves a scanned or pasted link of the expected kind.
    static func approve(_ text: String, expecting kind: Kind, session: AccountSession) async -> Outcome {
        guard let link = LegacyPairingLink(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return .invalidLink
        }
        switch (link, kind) {
        case (.terminal, .terminal), (.account, .account):
            break
        default:
            return .invalidLink
        }
        return await approve(link, session: session)
    }

    static func approve(_ link: LegacyPairingLink, session: AccountSession) async -> Outcome {
        do {
            return try await session.pairing.approve(link) == .alreadyHandled ? .alreadyHandled : .approved
        } catch LegacyPairingError.terminalNeedsUpdate {
            return .terminalNeedsUpdate
        } catch {
            return .failed
        }
    }

    /// What happy-app tells the person. A connected terminal is felt, not
    /// announced: the computer turns up on screen. A linked device and every
    /// failure get an alert.
    static func report(_ outcome: Outcome, kind: Kind, on controller: UIViewController) {
        switch (outcome, kind) {
        case (.approved, .terminal):
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case (.approved, .account):
            Alerts.show(Strings.Common.success, Strings.Modals.deviceLinkedSuccessfully, on: controller)
        case (.alreadyHandled, _):
            Alerts.show(Strings.Scan.alreadyUsedTitle, Strings.Scan.alreadyUsed, on: controller)
        case (.invalidLink, _):
            Alerts.show(Strings.Common.error, Strings.Modals.invalidAuthUrl, on: controller)
        case (.terminalNeedsUpdate, _):
            Alerts.show(Strings.Common.error, Strings.Modals.terminalNeedsUpdate, on: controller)
        case (.failed, .terminal):
            Alerts.show(Strings.Common.error, Strings.Modals.failedToConnectTerminal, on: controller)
        case (.failed, .account):
            Alerts.show(Strings.Common.error, Strings.Modals.failedToLinkDevice, on: controller)
        }
    }
}

extension UIViewController {
    /// A gear in the navigation bar.
    func settingsBarButton(action: Selector, label: String = Strings.Onboarding.settingsTitle) -> UIBarButtonItem {
        // HomeHeader.tsx: settings-outline at 22.
        let item = UIBarButtonItem(image: .icon(.ionicons("settings-outline"), size: 22), style: .plain, target: self, action: action)
        item.accessibilityLabel = label
        return item
    }

    /// The screens pushed from here go back with the chevron alone, in its
    /// glass circle: never "Back" nor this screen's title. The shell's
    /// stacks say the same of every screen (`ShellViewController`);
    /// this covers one pushed onto another stack.
    func minimalBackButton() {
        navigationItem.backButtonDisplayMode = .minimal
        navigationItem.backButtonTitle = nil
    }
}
#endif
