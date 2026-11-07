import Foundation

/// What a recording has said so far: `finalized`, which never changes
/// again, and `volatile`, the recognizer's current reading of what came
/// after it, which each new reading replaces.
///
/// Two recognizers feed it:
/// - SpeechAnalyzer (iOS 26) says which is which: `revise` replaces the
///   tail, `finalize` settles a stretch of audio.
/// - SFSpeechRecognizer only gives its latest reading (`update`). After a
///   pause on the device that reading starts over with the new sentence, so
///   taking the latest one kept only the last sentence. A reading that
///   starts after the previous one's audio ended, or that is a shorter one
///   with another first word, is a new sentence: the previous reading is
///   kept. Anything else revises it.
public struct DictationTranscript: Equatable, Sendable {
    public private(set) var finalized = ""
    public private(set) var volatile = ""
    /// The audio the volatile reading covers, when the recognizer gave it.
    private var span: Range<Double>?
    /// What this recognition task settled without ending, in case its next
    /// reading starts with it again.
    private var settledInTask: [String] = []

    public init() {}

    /// Everything heard, as it would be sent now.
    public var text: String { Self.join(finalized, volatile) }

    // MARK: SpeechAnalyzer

    /// The current reading of everything after `finalized`.
    public mutating func revise(_ text: String) {
        volatile = Self.trim(text)
        span = nil
    }

    /// A stretch of audio settled: its text replaces the reading of it.
    public mutating func finalize(_ text: String) {
        volatile = Self.trim(text)
        commitTail()
    }

    // MARK: SFSpeechRecognizer

    /// One of the recognizer's readings: the current sentence so far, or
    /// the last reading of the task when `isFinal`.
    public mutating func update(_ text: String, audioRange: Range<Double>?, isFinal: Bool) {
        var words = Self.words(text)
        // A reading that repeats what this task already settled, and goes
        // on, carries it only once. One that only repeats it is someone
        // saying it again.
        if !settledInTask.isEmpty, words.count > settledInTask.count,
           zip(words, settledInTask).allSatisfy({ Self.same($0, $1) }) {
            words.removeFirst(settledInTask.count)
        }
        let text = words.joined(separator: " ")
        let range = audioRange.flatMap { $0.upperBound > 0 ? $0 : nil }
        // Empty readings often come with an error; they must not erase words.
        if !text.isEmpty {
            if !volatile.isEmpty, startsAnew(words, range: range) {
                settledInTask += Self.words(volatile)
                commitTail()
            }
            volatile = text
            span = range
        }
        if isFinal { endSegment() }
    }

    /// The recognition task is over; a new one has its own audio clock and
    /// starts from nothing.
    public mutating func endSegment() {
        commitTail()
        settledInTask = []
    }

    private func startsAnew(_ words: [String], range: Range<Double>?) -> Bool {
        if let previous = span, let next = range {
            return next.lowerBound >= previous.upperBound - 0.02 && next.lowerBound > previous.lowerBound + 0.02
        }
        let current = Self.words(volatile)
        guard let first = words.first, let previousFirst = current.first else { return false }
        return !Self.same(first, previousFirst) && words.count < current.count
    }

    private mutating func commitTail() {
        finalized = Self.join(finalized, volatile)
        volatile = ""
        span = nil
    }

    // MARK: Text

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func words(_ text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// The same word, read with other case or punctuation.
    private static func same(_ a: String, _ b: String) -> Bool {
        func bare(_ word: String) -> String {
            String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
        }
        return bare(a) == bare(b)
    }

    /// Sentences joined by a space, except before a settled full stop on
    /// its own and in Chinese and Japanese, which write none.
    static func join(_ prefix: String, _ suffix: String) -> String {
        if prefix.isEmpty { return suffix }
        if suffix.isEmpty { return prefix }
        if let last = prefix.unicodeScalars.last, let first = suffix.unicodeScalars.first,
           unspaced(last) || unspaced(first) || ".,!?;:…".unicodeScalars.contains(first) {
            return prefix + suffix
        }
        return prefix + " " + suffix
    }

    private static func unspaced(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3000...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF, 0xFF00...0xFFEF: true
        default: false
        }
    }
}
