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

    /// Entering a link, restoring an account, and the relay server: the
    /// self-hosted ways in. Any other team server is added by scanning the
    /// code Happy Desktop shows. Happy Cloud isn't here: its ways in are
    /// Start's Use Happy Cloud, the account menu's and Settings'.
    static func otherWays(context: AppContext, from controller: UIViewController, intent: ScanIntent = .addAccount, busy: @escaping (Bool) -> Void = { _ in }) -> [ScannerWay] {
        [
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

    /// Happy Cloud, full screen: Welcome while the account isn't signed in
    /// on this phone, its servers once it is (`CloudScreens`).
    /// Cloud servers need no scanned code: their addresses are built from
    /// the app's own base.
    static func connectToCloud(context: AppContext, from controller: UIViewController) {
        guard HappyCloud.isOffered(in: context.variant) else { return }
        let first = CloudScreens.first(context: context)
        if context.account.accounts.isEmpty, let navigation = controller.navigationController {
            navigation.pushViewController(first, animated: true)
            return
        }
        context.account.beginAddingAccount()
        let navigation = CloudNavigationController(rootViewController: first)
        // The flow's, not the welcome's: a welcome put back after the pass
        // ends wears the same button.
        first.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak navigation] _ in
            context.account.cancelAddingAccount()
            navigation?.dismiss(animated: true)
        })
        first.navigationItem.leftBarButtonItem?.accessibilityIdentifier = "cloud-close"
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.modalPresentationStyle = .fullScreen
        controller.present(navigation, animated: true)
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
