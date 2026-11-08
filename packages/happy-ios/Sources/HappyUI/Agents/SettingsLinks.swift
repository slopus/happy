#if canImport(UIKit)
import HappyCore
import HappyWire
import UIKit

/// Opens a settings link (`happy://settings/<page>`) on `session`'s
/// connection, where `SettingsLinkPlace` says: the app's own page, or a
/// Happy Cloud server's web settings in the system browser. It only
/// navigates: nothing is changed, and no sign-in starts on its own.
@MainActor
enum SettingsLinks {
    static func open(_ page: HappyLink.SettingsPage, options: HappyLink.ProviderOptions = .init(), session: Session, from controller: UIViewController) {
        guard let place = SettingsLinkPlace.place(page, server: session.server), let context = session.context else { return }
        switch place {
        case .general:
            SettingsViewController.open(context: context, computer: session.accountID, from: controller)
        case .profile:
            controller.navigationController?.pushViewController(ProfileViewController(source: session.profile), animated: true)
        case .voice:
            SettingsViewController.open(context: context, computer: session.accountID, reveal: SettingsIndex.agentVoice.id, from: controller)
        case .servers:
            AccountAdding.connectToCloud(context: context, from: controller)
        case .computes:
            guard ComputeViewController.offered(session) else { return }
            controller.navigationController?.pushViewController(ComputeViewController(session: session), animated: true)
        case .web(let url):
            UIApplication.shared.open(url)
        case .providers(let page):
            ProvidersViewController.open(page, options: options, session: session, from: controller)
        }
    }
}
#endif
