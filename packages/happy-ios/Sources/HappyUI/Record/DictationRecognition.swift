// The Mac harness (`DICTATION_HARNESS`) compiles this file as it is, with
// DictationTranscript.swift beside it, to run it on a recording.
#if canImport(UIKit) || DICTATION_HARNESS
import AVFAudio
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
@MainActor
final class DictationRecognition {
    enum Engine: String {
        case analyzer
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
    private var active: (any DictationReader)?
    private var choosing: Task<Void, Never>?
    private var cancelled = false

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
    }

    var locale: Locale { recognizer.locale }

    /// Starts reading. Audio given before an engine is chosen waits for it.
    func start() {
        let changed: @MainActor (DictationTranscript) -> Void = { [weak self] transcript in
            guard let self, !self.cancelled else { return }
            self.transcript = transcript
            self.onTranscript?(transcript)
        }
        choosing = Task { [weak self, recognizer, audio] in
            if Self.forcedEngine != .recognizer,
               let analyzer = await AnalyzerReader.make(locale: recognizer.locale, audio: audio, changed: changed) {
                do {
                    try await analyzer.start()
                    guard let self, !self.cancelled else { return analyzer.cancel() }
                    self.active = analyzer
                    self.engine = .analyzer
                    return
                } catch {
                    analyzer.cancel()
                }
            }
            guard let self, !self.cancelled else { return }
            let reader = RecognizerReader(recognizer: recognizer, audio: audio, changed: changed)
            reader.start()
            self.active = reader
            self.engine = .recognizer
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
}

@MainActor
private protocol DictationReader: AnyObject {
    func finish() async
    func cancel()
}

// MARK: SpeechAnalyzer

@MainActor
private final class AnalyzerReader: DictationReader {
    private struct Reading: Sendable {
        let text: String
        let isFinal: Bool
    }

    private let module: any SpeechModule
    private let readings: AsyncThrowingStream<Reading, any Error>
    private let audio: DictationAudio
    private let changed: @MainActor (DictationTranscript) -> Void
    private var transcript = DictationTranscript()
    private var analyzer: SpeechAnalyzer?
    private var feed: AsyncStream<AnalyzerInput>.Continuation?
    private var reading: Task<Void, Never>?
    private var accepting = true

    private init(module: any SpeechModule, readings: AsyncThrowingStream<Reading, any Error>, audio: DictationAudio, changed: @escaping @MainActor (DictationTranscript) -> Void) {
        self.module = module
        self.readings = readings
        self.audio = audio
        self.changed = changed
    }

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
        switch await AssetInventory.status(forModules: [module]) {
        case .installed:
            return AnalyzerReader(module: module, readings: readings, audio: audio, changed: changed)
        case .supported:
            Self.download(module)
            return nil
        case .downloading, .unsupported:
            return nil
        @unknown default:
            return nil
        }
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
            guard let request = try? await AssetInventory.assetInstallationRequest(supporting: [module]) else { return }
            try? await request.downloadAndInstall()
        }
    }

    func start() async throws {
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw DictationRecognitionError.noFormat
        }
        let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
        let analyzer = SpeechAnalyzer(modules: [module], options: .init(priority: .userInitiated, modelRetention: .lingering))
        let readings = readings
        reading = Task { [weak self] in
            do {
                for try await reading in readings { self?.read(reading) }
            } catch {}
        }
        try await analyzer.start(inputSequence: input)
        self.analyzer = analyzer
        self.feed = feed
        let converter = AnalyzerAudioConverter(format: format)
        audio.attach { buffer in
            if let converted = converter.convert(buffer) { feed.yield(AnalyzerInput(buffer: converted)) }
        }
    }

    private func read(_ reading: Reading) {
        guard accepting else { return }
        if reading.isFinal {
            transcript.finalize(reading.text)
        } else {
            transcript.revise(reading.text)
        }
        changed(transcript)
    }

    func finish() async {
        audio.close()
        feed?.finish()
        if let analyzer, let reading {
            let settled = await DictationWait.atMost(seconds: 3) {
                try? await analyzer.finalizeAndFinishThroughEndOfInput()
                await reading.value
            }
            if !settled { Task { await analyzer.cancelAndFinishNow() } }
        }
        accepting = false
        reading?.cancel()
        // Whatever wasn't settled in time is the best reading there is.
        transcript.endSegment()
        changed(transcript)
    }

    func cancel() {
        accepting = false
        audio.close()
        feed?.finish()
        reading?.cancel()
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
