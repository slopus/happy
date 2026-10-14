import Foundation

/// The language the screens speak: text/index.ts's `currentLanguage`, which
/// happy-app fixes at launch from the signed-in account's
/// `preferredLanguage` and the device, and changes only by reloading.
///
/// For the main thread only. It is set, with a catalog already decoded off
/// the main thread, before an account's screens are built, and again before
/// they are rebuilt for another account or language. Work off the main
/// thread never reads it: a screen puts its language in its derivation's
/// input when it is built, so what a derivation says belongs to that
/// screen's account and language even while this changes.
public enum AppLocalization {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var catalog: TranslationCatalog?

    /// The screens' catalog, or nil while they speak English, whose words
    /// the screens hold themselves. Main thread only: Debug builds stop
    /// when it is read anywhere else.
    public static var screens: TranslationCatalog? {
        #if DEBUG
        dispatchPrecondition(condition: .onQueue(.main))
        #endif
        return lock.withLock { catalog }
    }

    /// The screens' language code; main thread only, as `screens`.
    public static var language: String {
        screens?.language ?? "en"
    }

    /// Speaks `catalog` from now on (nil or English: the screens' own
    /// English). Says whether that changed the language, so the caller
    /// knows the screens need building again.
    @discardableResult
    public static func use(_ catalog: TranslationCatalog?) -> Bool {
        let next = catalog?.language == "en" ? nil : catalog
        return lock.withLock {
            guard next?.language != self.catalog?.language else { return false }
            self.catalog = next
            return true
        }
    }
}
