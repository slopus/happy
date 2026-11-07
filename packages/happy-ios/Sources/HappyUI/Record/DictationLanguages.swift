#if canImport(UIKit)
import HappyCore
import Speech
import UIKit

/// Public keyboard signals only; no private keyboard preferences or audio leaves the device.
@MainActor
final class DictationLanguages: NSObject {
    private static let shared = DictationLanguages()
    private static let keyboardKey = "dictation.lastKeyboardLanguage"
    private static let successKey = "dictation.lastSuccessfulLanguage"

    static func observeKeyboard() { _ = shared }

    private override init() {
        super.init()
        for name in [UITextInputMode.currentInputModeDidChangeNotification,
                     UITextField.textDidBeginEditingNotification,
                     UITextView.textDidBeginEditingNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: name, object: nil)
        }
    }

    @objc private func keyboardChanged() { Self.captureKeyboard() }

    private static func captureKeyboard() {
        func focused(_ view: UIView) -> UIView? {
            if view.isFirstResponder { return view }
            for child in view.subviews { if let found = focused(child) { return found } }
            return nil
        }
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) where scene.activationState == .foregroundActive {
            for window in scene.windows where window.isKeyWindow {
                if let language = focused(window)?.textInputMode?.primaryLanguage,
                   language != "emoji", language != "und" {
                    UserDefaults.standard.set(language, forKey: keyboardKey)
                    return
                }
            }
        }
    }

    /// Ranked candidates also allow the pipeline to retry a buffered recording later.
    static func rankedLocales(supported: [Locale]) -> [Locale] {
        observeKeyboard()
        captureKeyboard()
        return DictationLanguage.ranked(
            keyboard: UserDefaults.standard.string(forKey: keyboardKey),
            successful: UserDefaults.standard.string(forKey: successKey),
            preferred: Locale.preferredLanguages,
            installed: UITextInputMode.activeInputModes.compactMap(\.primaryLanguage),
            supported: supported.map(\.identifier)
        ).map { Locale(identifier: $0) }
    }

    static func recognizer(allowUnavailableOnDevice: Bool = false) -> SFSpeechRecognizer? {
        let recognizers = SFSpeechRecognizer.supportedLocales().compactMap { SFSpeechRecognizer(locale: $0) }
            .filter { $0.supportsOnDeviceRecognition || allowUnavailableOnDevice }
        guard let locale = rankedLocales(supported: recognizers.map(\.locale)).first else { return nil }
        return recognizers.first { $0.locale.identifier == locale.identifier }
    }

    /// Call only for an accepted, nonempty final transcript, never cancellation.
    static func rememberSuccess(locale: Locale) {
        UserDefaults.standard.set(locale.identifier, forKey: successKey)
    }
}
#endif