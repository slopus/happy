// The Mac harness (`DICTATION_HARNESS`) compiles this file as it is, with
// DictationTranscript.swift and DictationLanguage.swift beside it, to run
// it on a recording.
#if canImport(UIKit) || DICTATION_HARNESS
import AVFAudio
import CoreMedia
import Foundation
import Speech
#if canImport(HappyCore)
import HappyCore
#endif

/// One recording's recognition, on the device only: audio in, the words
/// as `DictationTranscript` out, as they are recognized.
///
/// SpeechAnalyzer reads it when its model for the language is on the
/// phone: it is built for long dictation and settles each sentence itself.
/// Otherwise, and while that model downloads for the next time,
/// SFSpeechRecognizer does, restarted whenever its task ends.
///
/// Given two candidate languages whose DictationTranscriber models are both
/// on the phone, one analyzer reads the recording in both. The best ranked
/// one's words are shown. At the first pause both are asked to settle what
/// came before it (`DictationLanguage.Pauses`); the language is chosen by
/// the recognizer's confidence in what each settled
/// (`DictationLanguage.Probe`), the other is dropped from the analyzer, and
/// the winner's words are shown from then on; one that settles nothing
/// there heard nothing. Without a clear choice by the end, the end decides. DictationTranscriber tells languages apart
/// far better than SpeechTranscriber, so both candidates use it.
@MainActor
final class DictationRecognition {
    enum Engine: String {
        case analyzer
        /// The analyzer, listening in two languages until one is chosen.
        case probe
        case recognizer
    }

    /// The words so far; called on every change.
    var onTranscript: ((DictationTranscript) -> Void)?
    /// Takes the microphone's audio from any thread.
    let audio = DictationAudio()
    private(set) var transcript = DictationTranscript()
    /// The engine that read this recording, once chosen.
    private(set) var engine: Engine?

    /// Forces one engine (the Mac harness).
    static var forcedEngine: Engine?
    /// Forces DictationTranscriber over SpeechTranscriber (the Mac harness).
    static var forcesDictationTranscriber = false

    private let recognizer: SFSpeechRecognizer
    private let candidates: [Locale]
    private var active: (any DictationReader)?
    private var choosing: Task<Void, Never>?
    private var cancelled = false

    /// `candidates`: the languages to listen for at once, best ranked first
    /// (`DictationLanguages.listeningLocales`). With fewer than two, or without
    /// their models, `recognizer`'s language is the only one.
    init(recognizer: SFSpeechRecognizer, candidates: [Locale] = []) {
        self.recognizer = recognizer
        self.candidates = Array(candidates.prefix(DictationLanguage.maximumListening))
    }

    /// The language of the words: the chosen one, once there is a choice.
    var locale: Locale { active?.locale ?? recognizer.locale }

    /// Starts reading. Audio given before an engine is chosen waits for it.
    func start() {
        let changed: @MainActor (DictationTranscript) -> Void = { [weak self] transcript in
            guard let self, !self.cancelled else { return }
            self.transcript = transcript
            self.onTranscript?(transcript)
        }
        choosing = Task { [weak self, recognizer, candidates, audio] in
            if Self.forcedEngine != .recognizer {
                var analyzer: AnalyzerReader?
                if candidates.count > 1 {
                    analyzer = await AnalyzerReader.probe(locales: candidates, audio: audio, changed: changed)
                }
                if analyzer == nil {
                    analyzer = await AnalyzerReader.make(locale: recognizer.locale, audio: audio, changed: changed)
                }
                if let analyzer {
                    do {
                        try await analyzer.start()
                        guard let self, !self.cancelled else { return analyzer.cancel() }
                        self.active = analyzer
                        self.engine = analyzer.probing ? .probe : .analyzer
                        DictationLog.note("engine \(self.engine!.rawValue) \(analyzer.candidateLocales)")
                        return
                    } catch {
                        analyzer.cancel()
                    }
                }
            }
            guard let self, !self.cancelled else { return }
            let reader = RecognizerReader(recognizer: recognizer, audio: audio, changed: changed)
            reader.start()
            self.active = reader
            self.engine = .recognizer
            DictationLog.note("engine recognizer \(recognizer.locale.identifier)")
        }
    }

    /// No more audio: waits, a moment at most, for the last words.
    func finish() async -> String {
        await choosing?.value
        await active?.finish()
        return transcript.text
    }

    /// Stops and forgets.
    func cancel() {
        cancelled = true
        choosing?.cancel()
        active?.cancel()
        audio.close()
    }

    /// Downloads, in the background, the models that listen for these
    /// languages at once, so a later recording can choose between them.
    static func prefetch(_ locales: [Locale]) {
        Task { await AnalyzerReader.prefetch(locales) }
    }
}

@MainActor
private protocol DictationReader: AnyObject {
    /// The language of the words, once known.
    var locale: Locale? { get }
    func finish() async
    func cancel()
}

// MARK: SpeechAnalyzer

@MainActor
private final class AnalyzerReader: DictationReader {
    private struct Reading: Sendable {
        let text: String
        let isFinal: Bool
        /// A settled reading's mean confidence by character, over the
        /// `scored` characters that had one.
        var confidence = 0.0
        var scored = 0
    }

    /// One language listening to the recording.
    private struct Candidate {
        let locale: Locale
        let module: any SpeechModule
        let readings: AsyncThrowingStream<Reading, any Error>
        var transcript = DictationTranscript()
        var reading: Task<Void, Never>?
    }

    private var candidates: [Candidate]
    private var probe: DictationLanguage.Probe
    private let audio: DictationAudio
    private let changed: @MainActor (DictationTranscript) -> Void
    private var analyzer: SpeechAnalyzer?
    private var feed: AsyncStream<AnalyzerInput>.Continuation?
    private var accepting = true

    private init(candidates: [Candidate], audio: DictationAudio, changed: @escaping @MainActor (DictationTranscript) -> Void) {
        self.candidates = candidates
        probe = DictationLanguage.Probe(locales: candidates.map(\.locale.identifier))
        self.audio = audio
        self.changed = changed
    }

    var probing: Bool { candidates.count > 1 }
    var candidateLocales: [String] { candidates.map(\.locale.identifier) }
    var locale: Locale? { candidates[probe.shown].locale }

    /// A reader for the language when its model is on the phone. When it
    /// isn't, it starts downloading for the next recording and gives nil.
    static func make(locale: Locale, audio: DictationAudio, changed: @escaping @MainActor (DictationTranscript) -> Void) async -> AnalyzerReader? {
        let module: any SpeechModule
        let readings: AsyncThrowingStream<Reading, any Error>
        if SpeechTranscriber.isAvailable, !DictationRecognition.forcesDictationTranscriber,
           let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
            module = transcriber
            readings = Self.readings(of: transcriber.results) { Reading(text: String($0.text.characters), isFinal: $0.isFinal) }
        } else if let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            // SpeechTranscriber has fewer languages (no Russian, for one).
            let transcriber = DictationTranscriber(locale: supported, preset: .progressiveLongDictation)
            module = transcriber
            readings = Self.readings(of: transcriber.results) { Reading(text: String($0.text.characters), isFinal: $0.isFinal) }
        } else {
            return nil
        }
        let status = await AssetInventory.status(forModules: [module])
        DictationLog.note("make \(locale.identifier) \(type(of: module)) status \(status)")
        switch status {
        case .installed:
            let candidate = Candidate(locale: locale, module: module, readings: readings)
            return AnalyzerReader(candidates: [candidate], audio: audio, changed: changed)
        case .supported:
            Self.download(module)
            return nil
        case .downloading, .unsupported:
            return nil
        @unknown default:
            return nil
        }
    }

    /// A reader listening in every one of `locales`, when all their models
    /// are on the phone; else nil, downloading the missing ones for the
    /// next recording.
    static func probe(locales: [Locale], audio: DictationAudio, changed: @escaping @MainActor (DictationTranscript) -> Void) async -> AnalyzerReader? {
        var candidates: [Candidate] = []
        var missing = false
        for locale in locales {
            guard let transcriber = await probeTranscriber(locale) else {
                DictationLog.note("probe \(locale.identifier) no DictationTranscriber locale")
                continue
            }
            let status = await AssetInventory.status(forModules: [transcriber])
            DictationLog.note("probe \(locale.identifier) status \(status)")
            switch status {
            case .installed:
                let readings = Self.readings(of: transcriber.results) { Self.scored($0.text, isFinal: $0.isFinal) }
                candidates.append(Candidate(locale: locale, module: transcriber, readings: readings))
            case .supported:
                Self.download(transcriber)
                missing = true
            default:
                missing = true
            }
        }
        #if DEBUG
        let reserved = await AssetInventory.reservedLocales.map(\.identifier)
        DictationLog.note("probe reserved \(reserved) of \(AssetInventory.maximumReservedLocales)")
        #endif
        guard !missing, candidates.count > 1 else { return nil }
        return AnalyzerReader(candidates: candidates, audio: audio, changed: changed)
    }

    static func prefetch(_ locales: [Locale]) async {
        for locale in locales {
            guard let transcriber = await probeTranscriber(locale) else { continue }
            let status = await AssetInventory.status(forModules: [transcriber])
            DictationLog.note("prefetch \(locale.identifier) status \(status)")
            if case .supported = status { Self.download(transcriber) }
        }
    }

    /// DictationTranscriber's long dictation, with each word's confidence.
    private static func probeTranscriber(_ locale: Locale) async -> DictationTranscriber? {
        guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else { return nil }
        let preset = DictationTranscriber.Preset.progressiveLongDictation
        return DictationTranscriber(locale: supported, contentHints: preset.contentHints, transcriptionOptions: preset.transcriptionOptions,
                                    reportingOptions: preset.reportingOptions, attributeOptions: preset.attributeOptions.union([.transcriptionConfidence]))
    }

    /// Only settled readings carry confidence.
    nonisolated private static func scored(_ text: AttributedString, isFinal: Bool) -> Reading {
        var reading = Reading(text: String(text.characters), isFinal: isFinal)
        guard isFinal else { return reading }
        var weighted = 0.0
        for run in text.runs {
            guard let confidence = run.transcriptionConfidence else { continue }
            let count = text[run.range].characters.count
            weighted += confidence * Double(count)
            reading.scored += count
        }
        if reading.scored > 0 { reading.confidence = weighted / Double(reading.scored) }
        return reading
    }

    nonisolated private static func readings<Results: AsyncSequence & Sendable>(of results: Results, _ reading: @escaping @Sendable (Results.Element) -> Reading) -> AsyncThrowingStream<Reading, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await result in results { continuation.yield(reading(result)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    nonisolated private static func download(_ module: any SpeechModule) {
        Task.detached(priority: .utility) {
            let name = "\(type(of: module))"
            do {
                guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) else {
                    DictationLog.note("download \(name): nothing to install")
                    return
                }
                DictationLog.note("download \(name): started")
                try await request.downloadAndInstall()
                DictationLog.note("download \(name): installed")
            } catch {
                DictationLog.note("download \(name): failed \(error)")
            }
        }
    }

    func start() async throws {
        let modules = candidates.map(\.module)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
            throw DictationRecognitionError.noFormat
        }
        let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
        let analyzer = SpeechAnalyzer(modules: modules, options: .init(priority: .userInitiated, modelRetention: .lingering))
        for index in candidates.indices {
            let readings = candidates[index].readings
            candidates[index].reading = Task { [weak self] in
                do {
                    for try await reading in readings { self?.read(reading, from: index) }
                } catch {}
            }
        }
        try await analyzer.start(inputSequence: input)
        self.analyzer = analyzer
        self.feed = feed
        let converter = AnalyzerAudioConverter(format: format)
        let pauses = probing ? PauseListener { [weak self] time in Task { @MainActor in self?.paused(at: time) } } : nil
        audio.attach { buffer in
            pauses?.hear(buffer)
            if let converted = converter.convert(buffer) { feed.yield(AnalyzerInput(buffer: converted)) }
        }
    }

    /// Asks every language to settle what came before the pause, so each
    /// reading of it comes with its confidence and the probe can choose.
    private func paused(at time: Double) {
        guard accepting, probe.winner == nil, let analyzer else { return }
        DictationLog.note("pause at \(time)")
        Task { [weak self] in
            try? await analyzer.finalize(through: CMTime(seconds: time, preferredTimescale: 1000))
            // What was settled reaches `read` a moment after.
            try? await Task.sleep(for: .milliseconds(300))
            self?.pauseSettled()
        }
    }

    /// Every language has settled what came before the pause, or heard
    /// nothing in it.
    private func pauseSettled() {
        guard accepting, let decided = probe.pauseSettled() else { return }
        DictationLog.note("pause settled, winner \(candidates[decided].locale.identifier)")
        drop(allBut: decided)
        changed(candidates[decided].transcript)
    }

    private func read(_ reading: Reading, from index: Int) {
        guard accepting, probe.listens(to: index) else { return }
        if reading.isFinal {
            candidates[index].transcript.finalize(reading.text)
        } else {
            candidates[index].transcript.revise(reading.text)
        }
        var decided: Int?
        if probing, reading.isFinal {
            decided = probe.settle(index, confidence: reading.confidence, characters: reading.scored)
            DictationLog.note("settled \(candidates[index].locale.identifier) \(String(format: "%.2f", reading.confidence))×\(reading.scored) [\(reading.text)] mean \(String(format: "%.2f", probe.confidence(of: index)))\(decided.map { " winner \(self.candidates[$0].locale.identifier)" } ?? "")")
        }
        if let decided { drop(allBut: decided) }
        // The shown words change once, to the winner's, when it isn't the
        // one shown so far.
        if index == probe.shown || decided != nil { changed(candidates[probe.shown].transcript) }
    }

    /// The other languages stop listening, and stop costing.
    private func drop(allBut winner: Int) {
        for index in candidates.indices where index != winner { candidates[index].reading?.cancel() }
        guard let analyzer else { return }
        let module = candidates[winner].module
        Task { try? await analyzer.setModules([module]) }
    }

    func finish() async {
        audio.close()
        feed?.finish()
        if let analyzer {
            let readers = candidates.compactMap(\.reading)
            let settled = await DictationWait.atMost(seconds: 3) {
                try? await analyzer.finalizeAndFinishThroughEndOfInput()
                for reader in readers { await reader.value }
            }
            if !settled { Task { await analyzer.cancelAndFinishNow() } }
        }
        accepting = false
        for candidate in candidates { candidate.reading?.cancel() }
        let chosen = probe.finish(texts: candidates.map(\.transcript.text))
        if probing {
            DictationLog.note("finish chose \(candidates[chosen].locale.identifier); " + candidates.indices.map { "\(candidates[$0].locale.identifier) \(String(format: "%.2f", probe.confidence(of: $0))) [\(candidates[$0].transcript.text)]" }.joined(separator: "; "))
        }
        // Whatever wasn't settled in time is the best reading there is.
        candidates[chosen].transcript.endSegment()
        changed(candidates[chosen].transcript)
    }

    func cancel() {
        accepting = false
        audio.close()
        feed?.finish()
        for candidate in candidates { candidate.reading?.cancel() }
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
    }
}

enum DictationRecognitionError: Error {
    case noFormat
}

/// The microphone's buffers in the format the analyzer reads. Used only
/// under `DictationAudio`'s lock, one buffer at a time.
private final class AnalyzerAudioConverter: @unchecked Sendable {
    private let format: AVAudioFormat
    private var converter: AVAudioConverter?

    init(format: AVAudioFormat) {
        self.format = format
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer }
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { return nil }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var given = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outcome in
            if given {
                outcome.pointee = .noDataNow
                return nil
            }
            given = true
            outcome.pointee = .haveData
            return buffer
        }
        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }
}

/// Where the recording pauses (`DictationLanguage.Pauses`), heard on the
/// audio thread. Used only under `DictationAudio`'s lock, in order.
private final class PauseListener: @unchecked Sendable {
    private var pauses = DictationLanguage.Pauses()
    private let found: @Sendable (Double) -> Void

    init(found: @escaping @Sendable (Double) -> Void) {
        self.found = found
    }

    func hear(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let level = Self.rms(buffer) else { return }
        let duration = Double(buffer.frameLength) / buffer.format.sampleRate
        if let time = pauses.hear(level: level, duration: duration) { found(time) }
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float? {
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        if let samples = buffer.floatChannelData?[0] {
            for index in 0..<count { sum += samples[index] * samples[index] }
        } else if let samples = buffer.int16ChannelData?[0] {
            for index in 0..<count {
                let sample = Float(samples[index]) / Float(Int16.max)
                sum += sample * sample
            }
        } else {
            return nil
        }
        return (sum / Float(count)).squareRoot()
    }
}

// MARK: SFSpeechRecognizer

@MainActor
private final class RecognizerReader: DictationReader {
    private let recognizer: SFSpeechRecognizer
    private let audio: DictationAudio
    private let changed: @MainActor (DictationTranscript) -> Void
    private var transcript = DictationTranscript()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Which task's results count: an ended task's late callbacks don't.
    private var generation = 0
    private var listening = true
    private var accepting = true
    private var ended = false
    private var failuresInARow = 0
    private var waiting: CheckedContinuation<Void, Never>?

    init(recognizer: SFSpeechRecognizer, audio: DictationAudio, changed: @escaping @MainActor (DictationTranscript) -> Void) {
        self.recognizer = recognizer
        self.audio = audio
        self.changed = changed
    }

    var locale: Locale? { recognizer.locale }

    func start() {
        generation += 1
        let current = generation
        ended = false
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        self.request = request
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] text, range, final, failed in
            guard let self, self.accepting, self.generation == current else { return }
            self.recognized(text, range: range, final: final, failed: failed)
        })
        let sink = RequestSink(request)
        audio.attach { sink.request.append($0) }
    }

    private func recognized(_ text: String?, range: Range<Double>?, final: Bool, failed: Bool) {
        transcript.update(text ?? "", audioRange: range, isFinal: final)
        changed(transcript)
        guard final else { return }
        ended = true
        waiting?.resume()
        waiting = nil
        // A task ends on its own: on a long pause, at its length limit, on
        // an error. The recording goes on, into a new task; audio meanwhile
        // waits in `audio`.
        guard listening else { return }
        failuresInARow = failed ? failuresInARow + 1 : 0
        guard failuresInARow <= 2 else { return }
        audio.detach()
        task?.cancel()
        start()
    }

    func finish() async {
        listening = false
        audio.close()
        request?.endAudio()
        if !ended {
            let current = generation
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                waiting = done
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    guard let self, self.generation == current else { return }
                    self.waiting?.resume()
                    self.waiting = nil
                }
            }
        }
        accepting = false
        task?.cancel()
        task = nil
        request = nil
        transcript.endSegment()
        changed(transcript)
    }

    func cancel() {
        listening = false
        accepting = false
        audio.close()
        task?.cancel()
        task = nil
        request = nil
        waiting?.resume()
        waiting = nil
    }

    /// Speech's results handler, made outside the main actor: it runs on
    /// Speech's queue and hands each reading to the main actor.
    nonisolated private static func results(_ deliver: @escaping @MainActor @Sendable (String?, Range<Double>?, Bool, Bool) -> Void) -> (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let final = (result?.isFinal ?? false) || error != nil
            let segments = result?.bestTranscription.segments ?? []
            let range = segments.first.flatMap { first in
                segments.last.map { last in first.timestamp..<max(first.timestamp, last.timestamp + last.duration) }
            }
            let failed = error != nil
            Task { @MainActor in deliver(text, range, final, failed) }
        }
    }
}

/// Speech's request takes buffers from the audio thread.
private final class RequestSink: @unchecked Sendable {
    let request: SFSpeechAudioBufferRecognitionRequest

    init(_ request: SFSpeechAudioBufferRecognitionRequest) {
        self.request = request
    }
}

// MARK: Audio

/// The microphone's buffers on their way to whichever engine reads them.
/// Buffers wait while there is none (the engine being chosen, a task being
/// replaced), so nothing said then is lost. The lock keeps them in order.
final class DictationAudio: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [AVAudioPCMBuffer] = []
    private var target: (@Sendable (AVAudioPCMBuffer) -> Void)?
    private var closed = false

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            guard !closed else { return }
            if let target {
                target(buffer)
            } else {
                waiting.append(buffer)
            }
        }
    }

    fileprivate func attach(_ target: @escaping @Sendable (AVAudioPCMBuffer) -> Void) {
        lock.withLock {
            guard !closed else { return }
            for buffer in waiting { target(buffer) }
            waiting = []
            self.target = target
        }
    }

    fileprivate func detach() {
        lock.withLock { target = nil }
    }

    /// No more audio; what still waits is dropped.
    func close() {
        lock.withLock {
            closed = true
            target = nil
            waiting = []
        }
    }
}

/// What dictation saw while choosing its language: in DEBUG, the console
/// and Documents/dictation.log, which a device run pulls back; in the Mac
/// harness, its output; nothing in a release.
enum DictationLog {
    private static let lock = NSLock()

    static func note(_ line: @autoclosure () -> String) {
        #if DICTATION_HARNESS
        print("dictation:", line())
        #elseif DEBUG
        let text = line()
        print("dictation:", text)
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let data = Data("\(Date().timeIntervalSince1970) \(text)\n".utf8)
        lock.withLock {
            let url = folder.appendingPathComponent("dictation.log")
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url)
            }
        }
        #endif
    }
}

enum DictationWait {
    /// Runs `work`, waiting for it `seconds` at most; true when it finished.
    @MainActor
    static func atMost(seconds: Double, _ work: @escaping @Sendable () async -> Void) async -> Bool {
        let once = Once()
        return await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            Task {
                await work()
                once.run { done.resume(returning: true) }
            }
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                once.run { done.resume(returning: false) }
            }
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        func run(_ body: () -> Void) {
            let first = lock.withLock {
                defer { done = true }
                return !done
            }
            if first { body() }
        }
    }
}
#endif
