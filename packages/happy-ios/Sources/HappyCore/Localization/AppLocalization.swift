import Foundation

/// The catalog the app speaks, for the whole process: text/index.ts's
/// `currentLanguage`, which happy-app fixes at launch from the signed-in
/// account's `preferredLanguage` and the device. Here it is set when an
/// account's session starts or the language changes, before its screens are
/// built, and read from any thread: a derivation off the main thread takes
/// the catalog into its input, so its words and the heights measured from
/// them belong to one language.
public enum AppLocalization {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var catalog = TranslationCatalog.english

    public static var current: TranslationCatalog {
        lock.withLock { catalog }
    }

    /// Speaks `language` from now on; says whether that changed anything,
    /// so the caller knows its screens need building again.
    @discardableResult
    public static func use(_ language: String) -> Bool {
        let next = TranslationCatalog.catalog(for: language)
        return lock.withLock {
            guard next !== catalog else { return false }
            catalog = next
            return true
        }
    }

    /// `t(key, params)` in the current language.
    public static func text(_ key: String, _ values: [String: TranslationValue] = [:]) -> String {
        current(key, values)
    }
}
