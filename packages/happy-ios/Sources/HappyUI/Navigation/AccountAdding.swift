#if canImport(UIKit)
import HappyCore
import UIKit

/// The one way to add a Happy account or an agent connection, from
/// anywhere: the first screen's Start, the account menu's Add, settings.
/// The camera reads a code and `HappyScan` routes it; the scanner's ⋯
/// enters a link instead, restores an account, or sets the relay server.
/// Nothing here changes until a connection is made: closing, cancelling or
/// failing leaves the active account as it was.
@MainActor
enum AccountAdding {
    /// The scanner, with the other ways in under its ⋯. `busy` brackets
    /// the network work after a code is read. The migration screen scans
    /// with `.migrate`.
    static func begin(context: AppContext, from controller: UIViewController, intent: ScanIntent = .addAccount, busy: @escaping (Bool) -> Void = { _ in }) {
        Task {
            await HappyScan.scan(intent: intent, context: context, on: controller, otherWays: otherWays(context: context, from: controller, intent: intent, busy: busy), busy: busy)
        }
    }

    /// Happy Cloud, entering a link, restoring an account, and the relay
    /// server. Any other team server is added by scanning the code Happy
    /// Desktop shows.
    static func otherWays(context: AppContext, from controller: UIViewController, intent: ScanIntent = .addAccount, busy: @escaping (Bool) -> Void = { _ in }) -> [ScannerWay] {
        (HappyCloud.isOffered(in: context.variant) ? [
            ScannerWay(title: Strings.ServerSignIn.cloudAction, symbol: "cloud") { [weak controller] in
                guard let controller else { return }
                connectToCloud(context: context, from: controller)
            },
        ] : []) + [
            ScannerWay(title: Strings.Start.enterLink, symbol: "link") { [weak controller] in
                guard let controller else { return }
                enterLink(context: context, from: controller, intent: intent, busy: busy)
            },
            // Restoring and the relay server are Happy CLI's alone; beside
            // Happy Agent's codes they say so.
            ScannerWay(title: Strings.AccountKind.restoreCLIAccount, symbol: "key") { [weak controller] in
                guard let controller else { return }
                show(RestoreQRViewController(context: context), context: context, from: controller)
            },
            ScannerWay(title: Strings.AccountKind.cliServer, symbol: "server.rack") { [weak controller] in
                guard let controller else { return }
                show(ServerConfigViewController(context: context), context: context, from: controller)
            },
        ]
    }

    /// Signing in to the team server at `server`: one a scanned code named
    /// (`instanceId` is the installation it must be), or one here already
    /// whose sign-in is renewed.
    static func signInToServer(context: AppContext, from controller: UIViewController, server: String, instanceId: String?) {
        show(ServerSignInViewController(context: context, server: server, installation: instanceId.map { .expected($0) } ?? .unchecked), context: context, from: controller)
    }

    /// Happy Cloud: its servers, after a confirm the first time, while the
    /// account isn't signed in on this phone (`CloudServersViewController`).
    /// Cloud servers need no scanned code: their addresses are built from
    /// the app's own base.
    static func connectToCloud(context: AppContext, from controller: UIViewController) {
        guard HappyCloud.isOffered(in: context.variant) else { return }
        Task {
            if CloudAccount.restore(keychain: CloudAccountKeychain(backend: SecurityKeychainBackend())) == nil {
                guard await Alerts.confirm(Strings.ServerSignIn.cloudTitle, Strings.ServerSignIn.cloudMessage, confirmTitle: Strings.ServerSignIn.cloudConnect, on: controller) else { return }
            }
            show(CloudServersViewController(context: context), context: context, from: controller)
        }
    }

    /// Restore: the code another phone scans, with a secret key under it.
    static func restore(context: AppContext, from controller: UIViewController) {
        show(RestoreQRViewController(context: context), context: context, from: controller)
    }

    /// A pasted link, routed as a scanned code is.
    static func enterLink(context: AppContext, from controller: UIViewController, intent: ScanIntent = .addAccount, busy: @escaping (Bool) -> Void = { _ in }) {
        Task {
            let text = await Alerts.prompt(Strings.Start.enterLinkTitle, Strings.Start.enterLinkMessage, placeholder: "happy://…", confirmTitle: Strings.Common.continueAction, on: controller)
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            await HappyScan.open(text, intent: intent, context: context, on: controller, start: .pasteLink, busy: busy)
        }
    }

    /// With nothing here yet, pushed on the first screen's stack. Beside
    /// accounts there are, in a sheet with Cancel: a restore there adds the
    /// account (and the window becomes its home); Cancel adds nothing.
    private static func show(_ screen: UIViewController, context: AppContext, from controller: UIViewController) {
        if context.account.accounts.isEmpty, let navigation = controller.navigationController {
            navigation.pushViewController(screen, animated: true)
            return
        }
        context.account.beginAddingAccount()
        screen.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak screen] _ in
            context.account.cancelAddingAccount()
            screen?.dismiss(animated: true)
        })
        let navigation = UINavigationController(rootViewController: screen)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        // Only Cancel closes it, so adding ends with it.
        navigation.isModalInPresentation = true
        controller.present(navigation, animated: true)
    }
}
#endif
