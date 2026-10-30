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
        Task {
            await HappyScan.scan(intent: .addAccount, context: context, on: controller, otherWays: otherWays(context: context, from: controller, busy: busy), busy: busy)
        }
    }

    /// Entering a link, restoring an account, and the relay server.
    static func otherWays(context: AppContext, from controller: UIViewController, busy: @escaping (Bool) -> Void = { _ in }) -> [ScannerWay] {
        [
            ScannerWay(title: Strings.Start.enterLink, symbol: "link") { [weak controller] in
                guard let controller else { return }
                enterLink(context: context, from: controller, busy: busy)
            },
            ScannerWay(title: Strings.Onboarding.restoreExisting, symbol: "key") { [weak controller] in
                guard let controller else { return }
                show(RestoreQRViewController(context: context), context: context, from: controller)
            },
            ScannerWay(title: Strings.Onboarding.settingsServer, symbol: "server.rack") { [weak controller] in
                guard let controller else { return }
                show(ServerConfigViewController(context: context), context: context, from: controller)
            },
        ]
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
