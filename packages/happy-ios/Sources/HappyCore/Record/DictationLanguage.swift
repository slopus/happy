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

    /// The locales to listen with at once: the first ranked, then the next
    /// of a different language. Two regions of one language never compete.
    public static func probes(_ ranked: [String], limit: Int = 2) -> [String] {
        var languages: Set<String> = []
        var result: [String] = []
        for identifier in ranked where result.count < limit {
            let language = Locale(identifier: identifier).language.languageCode?.identifier ?? identifier
            if languages.insert(language).inserted { result.append(identifier) }
        }
        return result
    }

    /// One locale's reading of the recording, with the recognizer's mean
    /// confidence, 0 to 1. The wrong language still produces words
    /// (transliterated or sound-alikes), but scores far lower: measured
    /// 0.92–0.98 for the spoken language against 0.12–0.40 for the other.
    public struct Reading: Equatable, Sendable {
        public var locale: String
        public var text: String
        public var confidence: Double

        public init(locale: String, text: String, confidence: Double) {
            self.locale = locale
            self.text = text
            self.confidence = confidence
        }
    }

    /// The reading to keep, given in ranked order: the first unless another
    /// is more confident by `margin`. A reading with no words never wins.
    public static func choose(_ readings: [Reading], margin: Double = 0.15) -> Reading? {
        let heard = readings.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard var best = heard.first else { return nil }
        for reading in heard.dropFirst() where reading.confidence > best.confidence + margin {
            best = reading
        }
        return best
    }
}