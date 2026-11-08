#if canImport(UIKit)
import AVFAudio
import HappyCore
import HappyLayout
import Speech
import UIKit

/// The phone's own dictation: the microphone into Speech, on the device
/// only, so nothing said leaves the phone until it is sent as text. It
/// listens from the press; the words are recognized as they are spoken
/// (`DictationRecognition`), and `finish` waits for the last of them.
@MainActor
final class Dictation {
    enum Access: Equatable {
        case granted
        /// The microphone or speech recognition hasn't been asked yet.
        case needsAsking
        case microphoneDenied
        case speechDenied
        /// No recognizer for the language that runs on this phone.
        case unavailable
    }

    enum Failure: Error {
        case unavailable
        case audio
    }

    /// The voice's loudness, 0 to 1, a few times a second.
    var onLevel: ((CGFloat) -> Void)?
    /// The words so far as they are recognized: what is settled, and the
    /// reading after it that may still change. Each call replaces the last;
    /// `("", "")` when a recording starts or is cancelled.
    var onTranscript: ((_ finalized: String, _ volatile: String) -> Void)?

    private let engine = AVAudioEngine()
    private var recognition: DictationRecognition?
    /// The words so far.
    private var transcript = DictationTranscript()
    private var feeding: Task<Void, Never>?
    private var scripted: Task<Void, Never>?
    private(set) var isRunning = false

    /// What may be used now, without asking.
    static func access() -> Access {
        if fileSource != nil {
            return speechAccess() ?? .needsAsking
        }
        switch AVAudioApplication.shared.recordPermission {
        case .undetermined: return .needsAsking
        case .denied: return .microphoneDenied
        default: break
        }
        return speechAccess() ?? .needsAsking
    }

    private static func speechAccess() -> Access? {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .notDetermined: return nil
        case .denied, .restricted: return .speechDenied
        default: return recognizer() == nil ? .unavailable : .granted
        }
    }

    /// Asks for what hasn't been asked: the microphone, then speech.
    static func ask() async -> Access {
        if fileSource == nil, AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            _ = await askSpeech()
        }
        return access()
    }

    /// Speech answers on a queue of its own: the callback is made outside
    /// the main actor, or Swift traps when it runs there.
    nonisolated private static func askSpeech() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
    }

    /// The recognizer for the language the person most likely speaks
    /// (`DictationLanguages`); nil when none runs on the device.
    private static func recognizer() -> SFSpeechRecognizer? {
        DictationLanguages.recognizer(allowUnavailableOnDevice: simulatorScript != nil)
    }

    /// Settings › Agents › Multilingual dictation, as the next recording
    /// should use it.
    var multilingual = true

    /// The languages a recording listens in, best ranked first: two, for
    /// the recording's words to decide between (`DictationRecognition`),
    /// only when `multilingual` and the person has two.
    private static func candidates(multilingual: Bool) -> [Locale] {
        DictationLanguages.listeningLocales(supported: Array(SFSpeechRecognizer.supportedLocales()), multilingual: multilingual)
    }

    private static var prefetched: [Locale] = []

    /// Downloads, in the background, the models for listening in two
    /// languages, so the first recording can already choose. Only with
    /// `multilingual` on, speech recognition allowed and a second language
    /// of the person's; nothing otherwise. Nothing is heard.
    static func prefetch(multilingual: Bool) {
        guard multilingual, SFSpeechRecognizer.authorizationStatus() == .authorized else { return }
        let locales = candidates(multilingual: true)
        guard locales.count > 1, locales != prefetched else { return }
        prefetched = locales
        DictationRecognition.prefetch(locales)
    }

    /// Starts listening at once.
    func start() throws {
        guard !isRunning, recognition == nil else { throw Failure.audio }
        guard let recognizer = Self.recognizer() else { throw Failure.unavailable }
        publish(DictationTranscript())
        let candidates = Self.candidates(multilingual: multilingual)
        DictationLog.note("start multilingual \(multilingual) signals \(DictationLanguages.signals()) ranked \(DictationLanguages.rankedLocales(supported: Array(SFSpeechRecognizer.supportedLocales())).map(\.identifier)) listening \(candidates.map(\.identifier)) recognizer \(recognizer.locale.identifier) onDevice \(recognizer.supportsOnDeviceRecognition)")
        let recognition = DictationRecognition(recognizer: recognizer, candidates: candidates)
        let audio = recognition.audio
        let level: @Sendable (CGFloat) -> Void = { [weak self] value in
            Task { @MainActor in self?.onLevel?(value) }
        }
        if let file = Self.fileSource {
            feeding = Self.feed(file, into: audio, level: level)
        } else {
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playAndRecord, mode: .default, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
                try session.setActive(true)
                let input = engine.inputNode
                let format = input.outputFormat(forBus: 0)
                input.removeTap(onBus: 0)
                input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(audio, level: level))
                engine.prepare()
                try engine.start()
            } catch {
                stopAudio()
                throw Failure.audio
            }
        }
        if let script = Self.simulatorScript {
            // The simulator can't load Speech's model: the script's words
            // come in as they would, settling at each sentence's end.
            audio.close()
            scripted = Task { [weak self] in await self?.play(script) }
        } else {
            recognition.onTranscript = { [weak self] transcript in self?.publish(transcript) }
            recognition.start()
            self.recognition = recognition
        }
        isRunning = true
    }

    /// Stops listening and waits, a moment at most, for the last words.
    func finish() async -> String {
        guard isRunning else { return transcript.text }
        isRunning = false
        stopAudio()
        if let recognition {
            _ = await recognition.finish()
            DictationLog.note("finished \(recognition.engine?.rawValue ?? "none") \(recognition.locale.identifier) [\(transcript.text)]")
            self.recognition = nil
            if !transcript.text.isEmpty { DictationLanguages.rememberSuccess(locale: recognition.locale) }
        } else if let script = Self.simulatorScript, let words = try? String(contentsOf: script, encoding: .utf8) {
            var transcript = DictationTranscript()
            transcript.finalize(words)
            publish(transcript)
        }
        return transcript.text
    }

    /// Stops listening and forgets what was heard.
    func cancel() {
        guard isRunning else { return }
        isRunning = false
        stopAudio()
        recognition?.cancel()
        recognition = nil
        publish(DictationTranscript())
    }

    private func publish(_ transcript: DictationTranscript) {
        self.transcript = transcript
        onTranscript?(transcript.finalized, transcript.volatile)
    }

    /// The simulator's words, one every quarter second, settled at each
    /// `.`, `,`, `!` or `?`.
    private func play(_ script: URL) async {
        guard let words = try? String(contentsOf: script, encoding: .utf8) else { return }
        var transcript = DictationTranscript()
        var sentence: [Substring] = []
        for word in words.split(whereSeparator: \.isWhitespace) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, isRunning else { return }
            sentence.append(word)
            if let last = word.last, ".,!?".contains(last) {
                transcript.finalize(sentence.joined(separator: " "))
                sentence = []
            } else {
                transcript.revise(sentence.joined(separator: " "))
            }
            publish(transcript)
        }
    }

    private func stopAudio() {
        scripted?.cancel()
        scripted = nil
        feeding?.cancel()
        feeding = nil
        guard Self.fileSource == nil else { return }
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The microphone's tap, made outside the main actor: it runs on the
    /// audio thread.
    nonisolated private static func tap(_ audio: DictationAudio, level: @escaping @Sendable (CGFloat) -> Void) -> AVAudioNodeTapBlock {
        var last = 0.0
        return { buffer, when in
            audio.append(buffer)
            let now = AVAudioTime.seconds(forHostTime: when.hostTime)
            // A level 20 times a second is plenty for the ring's lag.
            guard now - last > 0.05 || last == 0 else { return }
            last = now
            level(RecordMotion.level(rms: rms(buffer)))
        }
    }

    nonisolated private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) {
            sum += samples[index] * samples[index]
        }
        return (sum / Float(buffer.frameLength)).squareRoot()
    }

    // MARK: A recording in place of the microphone (DEBUG)

    #if DEBUG
    private static var trial: Dictation?

    /// `HAPPY_DICTATION_TRIAL=<seconds>`: at launch, one recording of
    /// `HAPPY_DICTATION_AUDIO` that long, with no one pressing anything;
    /// what it chose and heard goes to Documents/dictation.log.
    static func trialIfAsked() {
        guard let seconds = ProcessInfo.processInfo.environment["HAPPY_DICTATION_TRIAL"].flatMap(Double.init) else { return }
        let multilingual = ProcessInfo.processInfo.environment["HAPPY_DICTATION_MULTILINGUAL"] != "0"
        Task { @MainActor in
            let access = await ask()
            DictationLog.note("trial access \(access) speech \(SFSpeechRecognizer.authorizationStatus().rawValue)")
            if ProcessInfo.processInfo.environment["HAPPY_DICTATION_PREFETCH"] == "1" {
                prefetch(multilingual: multilingual)
                try? await Task.sleep(for: .seconds(2))
            }
            let dictation = Dictation()
            dictation.multilingual = multilingual
            trial = dictation
            do { try dictation.start() } catch { return DictationLog.note("trial start failed \(error)") }
            try? await Task.sleep(for: .seconds(seconds))
            let text = await dictation.finish()
            DictationLog.note("trial done [\(text)]")
            trial = nil
        }
    }
    #endif

    /// `HAPPY_DICTATION_AUDIO`: a sound file, in Documents or a full path,
    /// played into the recognizer at its own pace in place of the
    /// microphone, so a device run hears the same words every time.
    static var fileSource: URL? {
        #if DEBUG
        guard let name = ProcessInfo.processInfo.environment["HAPPY_DICTATION_AUDIO"], !name.isEmpty else { return nil }
        if name.hasPrefix("/") { return URL(fileURLWithPath: name) }
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
        #else
        return nil
        #endif
    }

    /// The simulator's recognizer can't load its model, so a simulator
    /// run playing a file takes the file's words from a text file beside
    /// it (`dictation.wav.txt`) instead.
    private static var simulatorScript: URL? {
        #if targetEnvironment(simulator)
        return fileSource?.appendingPathExtension("txt")
        #else
        return nil
        #endif
    }

    nonisolated private static func feed(_ url: URL, into audio: DictationAudio, level: @escaping @Sendable (CGFloat) -> Void) -> Task<Void, Never> {
        Task.detached {
            guard let file = try? AVAudioFile(forReading: url) else { return }
            // When it played, beside the file, so a film of the run can be
            // given the sound it heard.
            mark("start", for: url)
            defer { mark("stop", for: url) }
            let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 20)
            while !Task.isCancelled {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk),
                      (try? file.read(into: buffer, frameCount: chunk)) != nil, buffer.frameLength > 0 else { break }
                audio.append(buffer)
                level(RecordMotion.level(rms: rms(buffer)))
                try? await Task.sleep(for: .milliseconds(50))
            }
            // The file is over: silence, as a quiet room would give.
            while !Task.isCancelled {
                level(0)
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    nonisolated private static func mark(_ event: String, for url: URL) {
        let log = url.appendingPathExtension("times")
        let line = Data("\(event) \(Date().timeIntervalSince1970)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()
            handle.write(line)
            try? handle.close()
        } else {
            try? line.write(to: log)
        }
    }
}
#endif

#if canImport(UIKit) && DEBUG
/// The app's way in to `Dictation.trialIfAsked`.
@MainActor
public enum DictationTrial {
    public static func startIfAsked() { Dictation.trialIfAsked() }
}
#endif
