#if canImport(UIKit)
import AVFAudio
import HappyLayout
import Speech
import UIKit

/// The phone's own dictation: the microphone into Speech's recognizer,
/// on the device only (`requiresOnDeviceRecognition`), so nothing said
/// leaves the phone until it is sent as text. It listens from the press;
/// the words are recognized as they are spoken, and `finish` waits for the
/// last of them.
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

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// The words so far, the recognizer's best reading.
    private var heard = ""
    private var ended = false
    private var waiting: CheckedContinuation<Void, Never>?
    private var feeding: Task<Void, Never>?
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
            _ = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
                SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
            }
        }
        return access()
    }

    /// The recognizer for the person's language, else English; nil when
    /// neither runs on the device.
    private static func recognizer() -> SFSpeechRecognizer? {
        for locale in [Locale.current, Locale(identifier: "en-US")] {
            if let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition {
                return recognizer
            }
        }
        return nil
    }

    /// Starts listening at once.
    func start() throws {
        guard let recognizer = Self.recognizer() else { throw Failure.unavailable }
        heard = ""
        ended = false
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            Task { @MainActor in self?.recognized(text, final: final || error != nil) }
        }
        let level: @Sendable (CGFloat) -> Void = { [weak self] value in
            Task { @MainActor in self?.onLevel?(value) }
        }
        if let file = Self.fileSource {
            feeding = Self.feed(file, into: request, level: level)
        } else {
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playAndRecord, mode: .default, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
                try session.setActive(true)
                let input = engine.inputNode
                let format = input.outputFormat(forBus: 0)
                input.removeTap(onBus: 0)
                input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(request, level: level))
                engine.prepare()
                try engine.start()
            } catch {
                stopAudio()
                task?.cancel()
                task = nil
                self.request = nil
                throw Failure.audio
            }
        }
        isRunning = true
    }

    /// Stops listening and waits, a moment at most, for the last words.
    func finish() async -> String {
        guard isRunning else { return heard }
        isRunning = false
        stopAudio()
        request?.endAudio()
        if !ended {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                waiting = done
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    self?.resumeWaiting()
                }
            }
        }
        task = nil
        request = nil
        return heard.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Stops listening and forgets what was heard.
    func cancel() {
        guard isRunning else { return }
        isRunning = false
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        heard = ""
        resumeWaiting()
    }

    private func recognized(_ text: String?, final: Bool) {
        if let text, !text.isEmpty { heard = text }
        if final {
            ended = true
            resumeWaiting()
        }
    }

    private func resumeWaiting() {
        waiting?.resume()
        waiting = nil
    }

    private func stopAudio() {
        feeding?.cancel()
        feeding = nil
        guard Self.fileSource == nil else { return }
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The microphone's tap, made outside the main actor: it runs on the
    /// audio thread.
    nonisolated private static func tap(_ request: SFSpeechAudioBufferRecognitionRequest, level: @escaping @Sendable (CGFloat) -> Void) -> AVAudioNodeTapBlock {
        var last = 0.0
        return { buffer, when in
            request.append(buffer)
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

    nonisolated private static func feed(_ url: URL, into request: SFSpeechAudioBufferRecognitionRequest, level: @escaping @Sendable (CGFloat) -> Void) -> Task<Void, Never> {
        nonisolated(unsafe) let request = request
        return Task.detached {
            guard let file = try? AVAudioFile(forReading: url) else { return }
            let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 20)
            while !Task.isCancelled {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk),
                      (try? file.read(into: buffer, frameCount: chunk)) != nil, buffer.frameLength > 0 else { break }
                request.append(buffer)
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
}
#endif
