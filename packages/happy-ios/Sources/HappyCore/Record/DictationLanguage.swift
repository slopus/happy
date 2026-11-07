import Foundation

/// Preference ordering only: recognition availability belongs to the platform.
public enum DictationLanguage {
    public static func ranked(
        keyboard: String?, successful: String?, preferred: [String], installed: [String], supported: [String]
    ) -> [String] {
        let available = Array(Set(supported)).sorted()
        let preferences = [keyboard, successful].compactMap { $0 } + preferred + installed + ["en-US"]
        var result: [String] = []
        for preference in preferences {
            let wanted = Locale(identifier: preference.replacingOccurrences(of: "_", with: "-"))
            guard let language = wanted.language.languageCode?.identifier,
                  language != "und", preference != "emoji" else { continue }
            let matches = available.filter { identifier in
                let candidate = Locale(identifier: identifier)
                guard candidate.language.languageCode?.identifier == language else { return false }
                // Never substitute a different explicit script (e.g. Chinese).
                if let script = wanted.language.script?.identifier,
                   let other = candidate.language.script?.identifier, script != other { return false }
                return true
            }.sorted { lhs, rhs in
                func score(_ value: String) -> Int {
                    let locale = Locale(identifier: value)
                    if value.replacingOccurrences(of: "_", with: "-").lowercased() == preference.replacingOccurrences(of: "_", with: "-").lowercased() { return 0 }
                    if locale.region == wanted.region { return 1 }
                    // A bare keyboard language should use the person's regional preference.
                    if preferred.contains(where: { $0.replacingOccurrences(of: "_", with: "-").lowercased() == value.replacingOccurrences(of: "_", with: "-").lowercased() }) { return 2 }
                    return 3
                }
                let a = score(lhs), b = score(rhs)
                return a == b ? lhs < rhs : a < b
            }
            // One regional variant per signal; do not crowd out other spoken languages.
            if let match = matches.first, !result.contains(match) { result.append(match) }
        }
        return result
    }
}