#if canImport(UIKit)
import HappyCore
import UIKit

/// What Settings' connection rows do (SettingsView.tsx, useConnectTerminal.ts),
/// for whichever settings page shows them: connecting a terminal by its
/// code or its URL.
/// Each returns once it is over; the page keeps its own busy state.
@MainActor
enum SettingsConnections {
    /// A terminal's code from the camera; nil when the scan was left.
    static func scanTerminal(on controller: UIViewController) async -> String? {
        await HappyScan.read(from: controller)
    }

    /// A terminal's URL, pasted; nil when nothing was.
    static func promptTerminalURL(on controller: UIViewController) async -> String? {
        let text = await Alerts.prompt(
            Strings.Modals.authenticateTerminal,
            Strings.Modals.pasteUrlFromTerminal,
            placeholder: "happy://terminal?...",
            confirmTitle: Strings.Common.authenticate,
            on: controller
        )
        guard let url = text?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else { return nil }
        return url
    }

    /// Whatever the code is, where `HappyScan` sends it.
    static func approveTerminal(_ text: String, context: AppContext, on controller: UIViewController) async {
        await HappyScan.open(text, intent: .connect, context: context, on: controller, start: .scan)
    }
}
#endif
