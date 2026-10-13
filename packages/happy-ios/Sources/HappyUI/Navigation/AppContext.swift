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

    /// The custom server's host, shown under the title; nil on the default.
    var customServerHost: String? {
        account.serverConfig.isCustomServer ? account.serverConfig.displayHost : nil
    }
}

/// Scanning and answering pairing codes: connecting a terminal
/// (useConnectTerminal.ts) and linking another device (useConnectAccount.ts).
@MainActor
enum PairingFlow {
    enum Kind {
        case terminal
        case account
    }

    /// Presents the camera and returns what it read; nil when closed.
    static func scan(from controller: UIViewController) async -> String? {
        await withCheckedContinuation { continuation in
            let scanner = QRScannerViewController()
            scanner.onFinish = { continuation.resume(returning: $0) }
            controller.present(scanner, animated: true)
        }
    }

    /// Approves a scanned or pasted link of the expected kind. Returns the
    /// message to show: success or failure.
    static func approve(_ text: String, expecting kind: Kind, session: AccountSession) async -> (succeeded: Bool, message: String) {
        let failure = kind == .terminal ? Strings.Modals.failedToConnectTerminal : Strings.Modals.failedToLinkDevice
        guard let link = PairingLink(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return (false, Strings.Modals.invalidAuthUrl)
        }
        switch (link, kind) {
        case (.terminal, .terminal), (.account, .account):
            break
        default:
            return (false, Strings.Modals.invalidAuthUrl)
        }
        do {
            switch try await session.pairing.approve(link) {
            case .terminalConnected, .alreadyHandled:
                return (true, kind == .terminal ? Strings.Modals.terminalConnectedSuccessfully : Strings.Modals.deviceLinkedSuccessfully)
            case .deviceLinked:
                return (true, Strings.Modals.deviceLinkedSuccessfully)
            }
        } catch PairingError.terminalNeedsUpdate {
            return (false, Strings.Modals.terminalNeedsUpdate)
        } catch {
            return (false, failure)
        }
    }
}

extension UIViewController {
    /// A gear in the navigation bar.
    func settingsBarButton(action: Selector) -> UIBarButtonItem {
        let item = UIBarButtonItem(image: .symbol("gearshape", pointSize: 17), style: .plain, target: self, action: action)
        item.accessibilityLabel = Strings.Onboarding.settingsTitle
        return item
    }
}
#endif
