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
    /// the network work after a code is read.
    static func begin(context: AppContext, from controller: UIViewController, busy: @escaping (Bool) -> Void = { _ in }) {
        // With no code the organization allows, there is nothing to scan:
        // signing in to a server is the way in.
        let managed = ManagedSettings.current
        guard managed.allowsHostedRelay || managed.allowsPhonePairing else {
            signInToServer(context: context, from: controller)
            return
        }
        Task {
            await HappyScan.scan(intent: .addAccount, context: context, on: controller, otherWays: otherWays(context: context, from: controller, busy: busy), busy: busy)
        }
    }

    /// Entering a link, restoring an account, and the relay server.
    static func otherWays(context: AppContext, from controller: UIViewController, busy: @escaping (Bool) -> Void = { _ in }) -> [ScannerWay] {
        let managed = ManagedSettings.current
        var ways: [ScannerWay] = []
        if canAddServer(context: context) {
            ways.append(ScannerWay(title: Strings.ServerSignIn.addServer, symbol: "building.2") { [weak controller] in
                guard let controller else { return }
                signInToServer(context: context, from: controller)
            })
        }
        if managed.allowsHostedRelay || managed.allowsPhonePairing {
            ways.append(ScannerWay(title: Strings.Start.enterLink, symbol: "link") { [weak controller] in
                guard let controller else { return }
                enterLink(context: context, from: controller, busy: busy)
            })
        }
        guard managed.allowsHostedRelay else { return ways }
        return ways + [
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

    /// Whether another server may be signed in to: always, unless the
    /// organization allows only its own and this phone already has it.
    static func canAddServer(context: AppContext) -> Bool {
        let managed = ManagedSettings.current
        guard managed.allowAdditionalServers == false else { return true }
        guard let pinned = managed.serverUrl?.value else { return false }
        // Once it's here, a sign-in that ended is renewed from its own row.
        return !context.account.agentConnections.accounts.contains { $0.server == pinned }
    }

    /// Whether anything at all can be added here.
    static func canAdd(context: AppContext) -> Bool {
        let managed = ManagedSettings.current
        return managed.allowsHostedRelay || managed.allowsPhonePairing || canAddServer(context: context)
    }

    /// Signing in to a team server by its address, or `server` again.
    static func signInToServer(context: AppContext, from controller: UIViewController, server: String? = nil) {
        show(ServerSignInViewController(context: context, server: server), context: context, from: controller)
    }

    /// Restore: the code another phone scans, with a secret key under it.
    static func restore(context: AppContext, from controller: UIViewController) {
        show(RestoreQRViewController(context: context), context: context, from: controller)
    }

    /// A pasted link, routed as a scanned code is.
    static func enterLink(context: AppContext, from controller: UIViewController, busy: @escaping (Bool) -> Void = { _ in }) {
        Task {
            let text = await Alerts.prompt(Strings.Start.enterLinkTitle, Strings.Start.enterLinkMessage, placeholder: "happy://…", confirmTitle: Strings.Common.continueAction, on: controller)
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            await HappyScan.open(text, intent: .addAccount, context: context, on: controller, start: .pasteLink, busy: busy)
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
