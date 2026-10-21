import Dispatch
import Foundation
import HappyCore

/// en.ts's `key` in the language the screens speak, `english` (the same
/// words, copied from en.ts) while that is English. For the main thread:
/// work off it says its words in the language its input carries
/// (`TranslationCatalog.catalog(for:)`), never the screens' current one,
/// which can change underneath it.
func localized(_ key: String, _ english: @autoclosure () -> String) -> String {
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(.main))
    #endif
    guard let catalog = AppLocalization.screens else { return english() }
    return catalog(key)
}

/// en.ts's function `key` called with `values`.
func localized(_ key: String, _ values: [String: TranslationValue], _ english: @autoclosure () -> String) -> String {
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(.main))
    #endif
    guard let catalog = AppLocalization.screens else { return english() }
    return catalog(key, values)
}

extension Notification.Name {
    /// The Language page's choice (a `ScreensLanguageChoice`): the window
    /// builds the screens again from the root in it, where happy-app
    /// reloads, unless they are another account's by now.
    static let screensLanguageChosen = Notification.Name("HappyScreensLanguageChosen")
}
