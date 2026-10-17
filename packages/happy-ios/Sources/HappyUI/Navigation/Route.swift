#if canImport(UIKit)
import HappyCore
import HappyLayout
import QuartzCore
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
    /// `file`: of a patch's files, the one to show alone.
    case sessionMessage(id: String, messageId: String, file: String? = nil)
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
    case settingsVoice
    case settingsVoiceLanguage
    case supportUs
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
        case .sessionFile(let id, let path):
            return SessionFileViewController(context: context, session: session, sessionId: id, path: path)
        case .sessionMessage(let id, let messageId, let file):
            return MessageDetailViewController(context: context, session: session, sessionId: id, messageId: messageId, file: file)
        case .textSelection(let text):
            return TextSelectionViewController(text: text)
        case .sessionFiles:
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
        case .settingsVoice:
            return VoiceSettingsViewController(context: context, session: session)
        case .settingsVoiceLanguage:
            return VoiceLanguageViewController(session: session)
        case .supportUs:
            return SupportUsViewController()
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
    ///
    /// Chats push a lightweight shell immediately. Their content is prepared
    /// during the transition, without a readiness gate on navigation.
    ///
    /// The tablet sidebar has no stack of its own: it pushes onto the one
    /// beside it, as SidebarNavigator.tsx's single stack does, and not
    /// again onto the chat already on top. The route is recorded so the
    /// sidebar can keep that chat's row selected (`HappyUI/Tablet`).
    func push(_ route: Route, context: AppContext, animated: Bool = true) {
        guard let session = context.account.session,
              let stack = navigationController ?? tabletDetailNavigation,
              navigationController != nil || !TabletRoutes.isShowing(route, in: stack)
        else { return }
        #if DEBUG || HAPPY_FIXTURES
        let constructionStarted = CACurrentMediaTime()
        #endif
        let controller = Screens.make(route, context: context, session: session)
        #if DEBUG || HAPPY_FIXTURES
        (controller as? ChatViewController)?.constructionSeconds = CACurrentMediaTime() - constructionStarted
        #endif
        TabletRoutes.record(route, for: controller)
        stack.pushViewController(controller, animated: animated)
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
