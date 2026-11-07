#if canImport(UIKit)
import UIKit

/// "What's your name?" for a server that doesn't know it yet: a team
/// server's first sign-in, and a Happy Cloud server whose member has no
/// name (`Onboarding.needsName`). Nil when the person cancels or leaves
/// it blank.
@MainActor
enum NamePrompt {
    static func ask(on controller: UIViewController, message: String = Strings.ServerSignIn.nameMessage, prefill: String? = nil, cancel: String = Strings.Common.cancel) async -> String? {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: Strings.ServerSignIn.nameTitle, message: message, preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = Strings.ServerSignIn.namePlaceholder
                field.text = prefill
                field.textContentType = .name
                field.autocapitalizationType = .words
                field.accessibilityIdentifier = "name-prompt-field"
            }
            alert.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: Strings.ServerSignIn.continueAction, style: .default) { [weak alert] _ in
                let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                continuation.resume(returning: name.isEmpty ? nil : name)
            })
            controller.present(alert, animated: true)
        }
    }
}
#endif
