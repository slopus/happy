#if canImport(UIKit)
import HappyCore
import UIKit

/// The move from Happy CLI to Happy Agent: a notice on a Happy CLI home in
/// every state (the list's notices, and over "No sessions yet", Link Your
/// Computer and the offline notice), never dismissed, until this phone has
/// an agent connection. It opens Open Happy on your computer, whose code
/// pairs the phone with Happy Agent; the Happy CLI account stays as it is.
@MainActor
enum HomeMigration {
    static func offered(_ context: AppContext) -> Bool {
        context.account.agentConnections.accounts.isEmpty
    }

    /// The notices a home state that isn't the list shows; nil for none.
    static func banners(_ context: AppContext) -> HomeBanners? {
        offered(context) ? HomeBanners(migration: true) : nil
    }

    static func open(from controller: UIViewController, context: AppContext) {
        controller.navigationController?.pushViewController(InstallDesktopViewController(context: context), animated: true)
    }

    /// `view`'s notices for now, opening the way from `controller`.
    static func apply(to view: NoSessionsView, from controller: UIViewController, context: AppContext) {
        view.banners = banners(context)
        view.header.onMigrate = { [weak controller] in
            guard let controller else { return }
            open(from: controller, context: context)
        }
    }
}
#endif
