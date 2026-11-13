#if canImport(UIKit)
import HappyCore
import UIKit

/// A screen that runs what a Gen UI it shows reports (SPEC.md rule 7),
/// found up the responder chain by a conversation's block.
@MainActor
protocol GenUIActing: AnyObject {
    func genUI(run action: GenUIAction, key: String, artifactId: String, version: Int)
}

/// What every screen showing a Gen UI runs the same way: `open` an https
/// address in the browser, `copy`, and `plugin`, the plugin's page. Only
/// what `GenUIRuns` enabled reaches here; the model wrote these, so each is
/// checked again before it runs.
@MainActor
enum GenUIActionRunner {
    /// Whether `action` was one of these, and so was run.
    @discardableResult
    static func run(_ action: GenUIAction, session: Session, from controller: UIViewController, agentId: String? = nil) -> Bool {
        switch action {
        case .open(let address):
            guard let url = URL(string: address), url.scheme?.lowercased() == "https" else { return true }
            controller.openBrowser(url, session: session, agentID: agentId)
        case .copy(let text):
            UIPasteboard.general.string = text
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            UIAccessibility.post(notification: .announcement, argument: Strings.Common.copied)
        case .plugin(let id):
            PluginScreens.open(pluginId: id, session: session, from: controller)
        case .message, .secret, .clusterSecret, .tool, .unsupported:
            return false
        }
        return true
    }
}
#endif
