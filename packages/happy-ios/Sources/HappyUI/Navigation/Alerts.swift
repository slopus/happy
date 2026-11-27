#if canImport(UIKit)
import HappyCore
import UIKit

/// happy-app's Modal.alert / confirm / prompt, as UIAlertController.
@MainActor
public enum Alerts {
    public static func show(_ title: String, _ message: String? = nil, on controller: UIViewController) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
        controller.present(alert, animated: true)
    }

    public static func confirm(
        _ title: String,
        _ message: String? = nil,
        confirmTitle: String,
        cancelTitle: String = Strings.Common.cancel,
        destructive: Bool = false,
        on controller: UIViewController
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: cancelTitle, style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: confirmTitle, style: destructive ? .destructive : .default) { _ in
                continuation.resume(returning: true)
            })
            controller.present(alert, animated: true)
        }
    }

    /// A text prompt; nil when cancelled.
    public static func prompt(
        _ title: String,
        _ message: String? = nil,
        placeholder: String? = nil,
        text: String? = nil,
        keyboard: UIKeyboardType = .URL,
        confirmTitle: String,
        on controller: UIViewController
    ) async -> String? {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = placeholder
                field.text = text
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.keyboardType = keyboard
            }
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: confirmTitle, style: .default) { [weak alert] _ in
                continuation.resume(returning: alert?.textFields?.first?.text ?? "")
            })
            controller.present(alert, animated: true)
        }
    }

    /// The Get help sheet: where to turn when stuck. On the first screen,
    /// where Settings can't be reached yet, `cloud` adds Settings' Happy
    /// Cloud switch above Cancel: Turn On while off, Turn Off while on.
    public static func help(on controller: UIViewController, cloud variant: AppVariant? = nil) {
        let sheet = UIAlertController(title: Strings.Onboarding.getHelp, message: Strings.Onboarding.helpMessage, preferredStyle: .alert)
        for link in Strings.helpLinks {
            sheet.addAction(UIAlertAction(title: link.title, style: .default) { _ in
                controller.openBrowser(link.url)
            })
        }
        if let variant {
            let on = HappyCloud.isOffered(in: variant)
            let toggle = UIAlertAction(title: on ? Strings.HappyCloud.turnOff : Strings.HappyCloud.turnOn, style: .default) { _ in
                HappyCloud.setOffered(!on)
            }
            toggle.accessibilityIdentifier = "help-happy-cloud"
            sheet.addAction(toggle)
        }
        sheet.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        controller.present(sheet, animated: true)
    }
}
#endif
