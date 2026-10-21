import Foundation

/// The languages happy-app ships (text/_all.ts `SUPPORTED_LANGUAGES`), for
/// Settings › Language. This app's own copy is English only for now; the
/// choice is synced so happy-app on other devices follows it.
public enum AppLanguage {
    public struct Language: Equatable, Sendable {
        public var code: String
        public var nativeName: String
    }

    public static let supported: [Language] = [
        Language(code: "en", nativeName: "English"),
        Language(code: "ru", nativeName: "Русский"),
        Language(code: "pl", nativeName: "Polski"),
        Language(code: "es", nativeName: "Español"),
        Language(code: "it", nativeName: "Italiano"),
        Language(code: "pt", nativeName: "Português"),
        Language(code: "ca", nativeName: "Català"),
        Language(code: "zh-Hans", nativeName: "中文(简体)"),
        Language(code: "zh-Hant", nativeName: "中文(繁體)"),
        Language(code: "ja", nativeName: "日本語"),
    ]

    public static func nativeName(_ code: String) -> String? {
        supported.first { $0.code == code }?.nativeName
    }

    /// language.tsx: the device's first language, cut at the first `-`, if
    /// that is a supported code; English otherwise. Chinese therefore reads
    /// as English, as it does in happy-app.
    public static func detectedName(deviceLanguages: [String]) -> String {
        let tag = deviceLanguages.first ?? "en-US"
        let language = tag.split(separator: "-").first.map { $0.lowercased() } ?? "en"
        return nativeName(language) ?? nativeName("en")!
    }

    /// The selected code, or nil for Automatic. An unknown stored code reads
    /// as Automatic.
    public static func selection(_ preferred: String?) -> String? {
        guard let preferred, nativeName(preferred) != nil else { return nil }
        return preferred
    }

    /// The catalog the app speaks (text/index.ts at launch): the preferred
    /// language when it is one of `supported`, else the first device
    /// language that is, Chinese by its script (Traditional for `Hant`,
    /// Simplified otherwise), else English. Device languages are BCP 47 tags
    /// such as `Locale.preferredLanguages` gives (`zh-Hant-TW`, `pt-BR`).
    public static func resolve(preferred: String?, deviceLanguages: [String]) -> String {
        if let preferred, nativeName(preferred) != nil { return preferred }
        for tag in deviceLanguages {
            let parts = tag.split(whereSeparator: { $0 == "-" || $0 == "_" })
            guard let first = parts.first, !first.isEmpty else { continue }
            let language = first.lowercased()
            if language == "zh" {
                // expo-localization's `languageScriptCode`: the tag's
                // four-letter subtag.
                let script = parts.dropFirst().first { $0.count == 4 }?.capitalized
                return script == "Hant" ? "zh-Hant" : "zh-Hans"
            }
            if nativeName(language) != nil { return language }
        }
        return "en"
    }

    /// appearance.tsx `getLanguageDisplayText`.
    public static func displayText(preferred: String?, deviceLanguages: [String], automatic: String) -> String {
        guard let preferred else {
            return "\(automatic) (\(detectedName(deviceLanguages: deviceLanguages)))"
        }
        return nativeName(preferred) ?? automatic
    }
}
