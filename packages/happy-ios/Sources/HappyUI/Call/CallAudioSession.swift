#if canImport(UIKit)
import AVFAudio
import LiveKit

/// The audio session of a call, in place of LiveKit's own
/// (`AudioSessionEngineObserver`), for every LiveKit room in the app.
///
/// A call holds it from before its room connects until the call has let
/// its engine go (`hold`, `release`): one category for the whole call,
/// `.playAndRecord` in the mode and options LiveKit picks for a speaker
/// call, never mixable, active the whole time. So music playing when the
/// call starts is interrupted (paused) once, not mixed under the call or
/// ducked, and when the call lets go the session is deactivated once,
/// with `.notifyOthersOnDeactivation`, and the music plays on.
///
/// LiveKit's own follows its engine instead, which starts and stops more
/// than once while a conversation connects (the SDK's always-prepared
/// recording turned on, then off, then the microphone). Each stop
/// deactivated the session and told the music to resume, the next start
/// interrupted it again, and a music app in the background can't start
/// again under a call: it stayed paused after the call, no longer
/// interrupted, so nothing told it to resume. Found on a device
/// (`CallAudioCheck`).
///
/// An interruption stops the engine; when it ends with `.shouldResume`
/// the engine starts again and the session comes back with it.
final class CallAudioSession: AudioEngineObserver, @unchecked Sendable {
    static let shared = CallAudioSession()

    private let lock = NSLock()
    private var _next: (any AudioEngineObserver)?
    /// A call holds the session; the engine needs it.
    private var held = false
    private var engineOn = false
    private var active = false

    var next: (any AudioEngineObserver)? {
        get { lock.withLock { _next } }
        set { lock.withLock { _next = newValue } }
    }

    /// Before the first room: this in place of LiveKit's session observer,
    /// ahead of its mixer as LiveKit chains them. Again does nothing.
    @MainActor
    static func install() {
        guard !installed else { return }
        installed = true
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        AudioManager.shared.set(engineObservers: [shared, AudioManager.shared.mixer])
    }

    @MainActor private static var installed = false

    #if DEBUG
    /// Each activation and deactivation, for the harness (`CallAudioCheck`).
    nonisolated(unsafe) static var trace: (@Sendable (String) -> Void)?
    #endif

    private static let configuration: AudioSessionConfiguration = {
        #if targetEnvironment(simulator)
        // No voice processing on the simulator: LiveKit's media-tuned mode.
        AudioSessionConfiguration.playAndRecordSpeaker.copyWith(mode: .value(.default))
        #else
        AudioSessionConfiguration.playAndRecordSpeaker
        #endif
    }()

    /// A call is starting: the session is the call's from now on.
    func hold() {
        lock.withLock { held = true }
        try? activate()
    }

    /// The media services were reset: the session the system had is gone,
    /// and the next call (or reconnection) sets it up again.
    func reset() {
        lock.withLock { active = false }
    }

    /// The call has let its engine go: the session goes too, once the
    /// engine has really stopped (a room's disconnect stops it a moment
    /// after it returns). Deactivated under running I/O, the session
    /// stays the engine's, and the music told to resume finds it still
    /// active and can't (`cannotInterruptOthers`).
    func release() async {
        lock.withLock { held = false }
        var waited = 0
        while waited < 30, Self.isEngineRunning || lock.withLock({ engineOn }) {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        // An engine stopped by an interruption may never say it is done.
        deactivate()
    }

    static var isEngineRunning: Bool { AudioManager.shared.isEngineRunning }

    func engineWillEnable(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        // Rendered by hand, the engine opens no device (`CallLiveCheck`).
        if !engine.isInManualRenderingMode, isPlayoutEnabled || isRecordingEnabled {
            lock.withLock { engineOn = true }
            do { try activate() } catch { return Self.failedToConfigure }
        }
        return next?.engineWillEnable(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
    }

    /// After an interruption the engine starts again without being enabled again.
    func engineWillStart(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        if !engine.isInManualRenderingMode, isPlayoutEnabled || isRecordingEnabled {
            do { try activate() } catch { return Self.failedToConfigure }
        }
        return next?.engineWillStart(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
    }

    func engineDidDisable(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        let result = next?.engineDidDisable(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
        guard !engine.isInManualRenderingMode, !isPlayoutEnabled, !isRecordingEnabled else { return result }
        // Held, the call isn't over: the session stays until it is.
        let idle = lock.withLock { engineOn = false; return !held }
        if idle { deactivate() }
        return result
    }

    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        let configuration = Self.configuration
        // Set once: a category or mode changed under a running engine
        // tears down voice processing, and with it echo cancellation.
        if session.category != configuration.category || session.mode != configuration.mode || session.categoryOptions != configuration.categoryOptions {
            try session.setCategory(configuration.category, mode: configuration.mode, options: configuration.categoryOptions)
        }
        // WebRTC's 20 ms, as LiveKit asks (a hint the device may not take).
        try? session.setPreferredIOBufferDuration(0.02)
        let wasActive = lock.withLock { defer { active = true }; return active }
        try session.setActive(true)
        #if DEBUG
        if !wasActive { Self.trace?("session activated") }
        #endif
    }

    private func deactivate() {
        guard lock.withLock({ defer { active = false }; return active }) else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            #if DEBUG
            Self.trace?("session deactivated")
            #endif
        } catch {
            #if DEBUG
            Self.trace?("session can't deactivate: \(error)")
            #endif
            // Still busy: once more in a moment, unless a call took it meanwhile.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.lock.withLock({ !self.held && !self.engineOn }) else { return }
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                #if DEBUG
                Self.trace?("session deactivated, again")
                #endif
            }
        }
    }

    /// LiveKit's own code for an observer that couldn't set the session up
    /// (`kAudioEngineErrorFailedToConfigureAudioSession`).
    private static let failedToConfigure = -4100
}
#endif
