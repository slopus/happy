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
        let signals = signals()
        return DictationLanguage.ranked(
            keyboard: signals.keyboard, successful: signals.successful, preferred: signals.preferred,
            installed: signals.installed, supported: supported.map(\.identifier)
        ).map { Locale(identifier: $0) }
    }

    /// The languages one recording listens in (`DictationLanguage.listening`):
    /// the person's two of different languages when `multilingual` and they
    /// have two, else one. One SpeechAnalyzer runs them side by side.
    static func listeningLocales(supported: [Locale], multilingual: Bool) -> [Locale] {
        let signals = signals()
        return DictationLanguage.listening(
            keyboard: signals.keyboard, successful: signals.successful, preferred: signals.preferred,
            installed: signals.installed, supported: supported.map(\.identifier), multilingual: multilingual
        ).map { Locale(identifier: $0) }
    }

    private static func signals() -> (keyboard: String?, successful: String?, preferred: [String], installed: [String]) {
        observeKeyboard()
        captureKeyboard()
        return (UserDefaults.standard.string(forKey: keyboardKey), UserDefaults.standard.string(forKey: successKey),
                Locale.preferredLanguages, UITextInputMode.activeInputModes.compactMap(\.primaryLanguage))
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