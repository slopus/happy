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

    public init(account: AccountController, variant: AppVariant, version: String) {
        self.account = account
        self.variant = variant
        self.version = version
    }

    /// The custom server's host (and port), shown under the title; nil on
    /// the default server.
    var customServerHost: String? {
        account.serverConfig.isCustomServer ? account.serverConfig.displayHost : nil
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

    enum Outcome: Equatable {
        case approved
        /// The code was answered already, or has expired: nothing was sent.
        case alreadyHandled
        /// Not a pairing link of the expected kind.
        case invalidLink
        /// A terminal that only speaks auth v1.
        case terminalNeedsUpdate
        case failed
    }

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

    /// happy-app's stack shows "Back" on the screens pushed from here.
    func showsBackTitle() {
        navigationItem.backButtonDisplayMode = .default
        navigationItem.backButtonTitle = Strings.Common.back
    }
}
#endif
