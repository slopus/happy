#if canImport(UIKit)
import HappyCore
import UIKit

/// A Pipelines screen: open only while the person's account has the
/// Pipelines feature plugin installed (`AccountFeatures`).
@MainActor
protocol PipelinesScreen: UIViewController {}

extension PipelinesViewController: PipelinesScreen {}
extension PipelinePageViewController: PipelinesScreen {}

/// The Pipelines plugin uninstalled, here or anywhere else: home lists
/// them no more (`SyncEngine`), nothing opens them, and the screens open
/// go, with what was opened over them, back to the screen under the first.
@MainActor
enum PipelinesGate {
    /// Whether Pipelines may open on `session`'s account.
    static func open(_ session: Session) -> Bool {
        session.home.features.available(AccountFeatures.pipelines)
    }

    /// Leaves `screen` and every Pipelines screen with it once Pipelines
    /// are unavailable, for as long as the watch is kept.
    static func watch(_ session: Session, from screen: PipelinesScreen) -> Watch {
        session.watchHome { [weak screen] home in
            guard let screen, !home.features.available(AccountFeatures.pipelines) else { return }
            // A screen under another has no window of its own; its stack does.
            leave(in: screen.navigationController?.view.window ?? screen.view.window)
        }
    }

    /// One move back to the screen under the first Pipelines screen, on a
    /// phone's stack or the main panel's beside the sidebar; a push or pop
    /// under way finishes first.
    static func leave(in window: UIWindow?) {
        guard let shell = window?.rootViewController as? ShellViewController else { return }
        let stack = shell.stack
        guard let first = stack.firstIndex(where: { $0 is PipelinesScreen }), first > 0 else { return }
        if let transition = shell.stackTransition {
            transition.animate(alongsideTransition: nil) { _ in leave(in: window) }
            return
        }
        shell.setStack(Array(stack[..<first]), animated: true)
    }
}
#endif
