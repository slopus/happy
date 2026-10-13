#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Every screen a signed-in account can push, after happy-app's
/// `app/(app)` routes. Screens open each other through `push(_:)`, never by
/// naming another feature's view controller, so features can be built in
/// parallel: each one replaces its own placeholders in `Screens.make`.
enum Route: Hashable {
    // Chat (session/[id]/…)
    case session(id: String)
    case sessionInfo(id: String)
    case sessionFiles(id: String)
    case sessionFile(id: String, path: String)
    case sessionChanges(id: String)
    case sessionMessage(id: String, messageId: String)
    case textSelection(text: String)

    // Starting work
    case newSession(machineId: String?, path: String?, prompt: String?)
    case machine(id: String)

    // Settings
    case settings
    case settingsAccount
    case settingsAppearance
    case settingsLanguage
    case settingsAgents
    case settingsConnectClaude
    case changelog
    case developer
    case server
    case troubleshoot
}

@MainActor
enum Screens {
    /// The view controller for a route. Routes not ported yet show a
    /// placeholder with the screen's title.
    static func make(_ route: Route, context: AppContext, session: AccountSession) -> UIViewController {
        switch route {
        case .settings:
            return SettingsViewController(context: context)
        case .server:
            return ServerConfigViewController(context: context)
        case .troubleshoot:
            return TroubleshootViewController(context: context, session: session)
        case .session(let id):
            return ChatViewController(context: context, session: session, sessionId: id)
        case .sessionInfo(let id):
            return SessionInfoViewController(context: context, session: session, sessionId: id)
        case .sessionChanges(let id):
            return SessionChangesViewController(context: context, session: session, sessionId: id)
        case .sessionFiles, .sessionFile, .sessionMessage, .textSelection:
            return PlaceholderViewController(title: "")
        case .machine(let id):
            return MachineViewController(context: context, session: session, machineId: id)
        case .newSession(let machineId, let path, let prompt):
            return NewSessionViewController(context: context, session: session, machineId: machineId, path: path, prompt: prompt)
        case .settingsAccount:
            return SettingsAccountViewController(context: context, session: session)
        case .settingsAppearance:
            return SettingsAppearanceViewController(context: context, session: session)
        case .settingsLanguage:
            return SettingsLanguageViewController(session: session)
        case .settingsAgents:
            return SettingsAgentsViewController(context: context, session: session)
        case .settingsConnectClaude:
            return SettingsConnectClaudeViewController()
        case .changelog:
            return ChangelogViewController()
        case .developer:
            return PlaceholderViewController(title: "")
        }
    }
}

extension UIViewController {
    /// Pushes a route on this screen's navigation stack. Needs a signed-in
    /// account; does nothing while signed out.
    func push(_ route: Route, context: AppContext, animated: Bool = true) {
        guard let session = context.account.session else { return }
        navigationController?.pushViewController(Screens.make(route, context: context, session: session), animated: animated)
    }
}

/// Stands in for a screen that hasn't been ported yet.
final class PlaceholderViewController: UIViewController {
    init(title: String) {
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        showsBackTitle()
    }
}
#endif
