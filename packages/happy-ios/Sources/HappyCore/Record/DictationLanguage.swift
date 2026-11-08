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
    /// (transliterated or sound-alikes), but scores far lower. Measured with
    /// DictationTranscriber on `say` clips: 0.82–0.98 for the spoken
    /// language against 0.09–0.40 for the other. SpeechTranscriber tells
    /// them apart less well (English read as German scored 0.83 vs 0.93).
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

    /// Several languages listening to one recording, until one is chosen.
    /// Only settled stretches carry the recognizer's confidence, so only
    /// they count. Candidate 0, the best ranked, is the one shown until
    /// then; afterwards only the winner is.
    public struct Probe: Equatable, Sendable {
        /// Settled characters the leader needs before an early choice.
        public static let enough = 12

        public let locales: [String]
        public private(set) var winner: Int?
        private var weighted: [Double]
        private var characters: [Int]
        private var settled: [Int]

        public init(locales: [String]) {
            self.locales = locales
            weighted = Array(repeating: 0, count: locales.count)
            characters = Array(repeating: 0, count: locales.count)
            settled = Array(repeating: 0, count: locales.count)
            if locales.count == 1 { winner = 0 }
        }

        /// The candidate whose words are shown.
        public var shown: Int { winner ?? 0 }

        /// Whether `index`'s readings still matter.
        public func listens(to index: Int) -> Bool { winner == nil || winner == index }

        /// The candidate's mean confidence over what it settled, 0 without any.
        public func confidence(of index: Int) -> Double {
            characters[index] > 0 ? weighted[index] / Double(characters[index]) : 0
        }

        /// A settled stretch from `index`, of `count` characters that had a
        /// confidence (none is fine: the wrong language often hears little).
        /// Gives the winner when this settles it: once every candidate has
        /// settled something and the leader `enough`, one leading the rest
        /// by more than `margin` wins. A close call waits for more.
        public mutating func settle(_ index: Int, confidence: Double, characters count: Int, margin: Double = 0.15) -> Int? {
            guard winner == nil else { return nil }
            settled[index] += 1
            if count > 0 {
                weighted[index] += confidence * Double(count)
                characters[index] += count
            }
            // The candidates' readings of one stretch don't arrive together:
            // a wrong one first must not win against nothing.
            guard settled.allSatisfy({ $0 > 0 }) else { return nil }
            let ranked = locales.indices.sorted { self.confidence(of: $0) > self.confidence(of: $1) }
            guard characters[ranked[0]] >= Self.enough,
                  self.confidence(of: ranked[0]) > self.confidence(of: ranked[1]) + margin else { return nil }
            winner = ranked[0]
            return ranked[0]
        }

        /// The recording is over: the candidate `choose` keeps from what
        /// each heard, else the best ranked.
        public mutating func finish(texts: [String]) -> Int {
            if let winner { return winner }
            let readings = texts.indices.map { Reading(locale: locales[$0], text: texts[$0], confidence: confidence(of: $0)) }
            let chosen = DictationLanguage.choose(readings).flatMap { reading in readings.firstIndex(of: reading) } ?? 0
            winner = chosen
            return chosen
        }
    }

    /// Where a recording pauses. DictationTranscriber settles nothing until
    /// the recording ends, and only settled words carry a confidence, so a
    /// probe asks it to settle what came before a pause: the cut falls in
    /// silence, where no word is lost (a cut mid-speech lost the words
    /// around it).
    public struct Pauses: Equatable, Sendable {
        /// Speech needed before the first pause counts.
        public static let speech = 1.0
        /// Quiet long enough to be a pause.
        public static let silence = 0.3
        /// Below this loudness (RMS) is quiet whatever was heard before.
        public static let floor: Float = 0.01

        private var heard: Double = 0
        private var spoken: Double = 0
        private var loudest: Float = 0
        private var quiet: Double = 0
        private var quietSince: Double = 0

        public init() {}

        /// One buffer's loudness and length. Gives the time, from the first
        /// buffer, to settle through when a pause has just become long
        /// enough: a little into the quiet, once per pause.
        public mutating func hear(level: Float, duration: Double) -> Double? {
            defer { heard += duration }
            loudest = max(loudest, level)
            if level >= max(Self.floor, loudest * 0.1) {
                spoken += duration
                quiet = 0
                return nil
            }
            if quiet == 0 { quietSince = heard }
            let before = quiet
            quiet += duration
            guard spoken >= Self.speech, before < Self.silence, quiet >= Self.silence else { return nil }
            return quietSince + 0.1
        }
    }
}
