#if canImport(UIKit)
import AVFAudio
import HappyCore
import UIKit

extension Notification.Name {
    static let voiceStateChanged = Notification.Name("happy.voiceStateChanged")
}

/// Lazily creates everything on the microphone press. Navigation focus and
/// account callbacks do no disk work or SDK initialization.
@MainActor
public final class VoiceCoordinator: NSObject {
    public static let shared = VoiceCoordinator()
    private var account: AccountSession?
    private var session: VoiceSession?
    private var context: VoiceContext?
    private var preparation: Task<Void, Never>?
    private var generation = 0
    private let lifetime = VoiceConnectionLifetime()
    private weak var screen: VoiceStatusViewController?
    public private(set) var state: VoiceState = .idle

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(backgrounded), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(audioReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    public func start(account: AccountSession, sessionId: String, presenting: UIViewController) {
        if self.account === account, isRunning {
            focus(account: account, sessionId: sessionId)
            show(from: presenting)
            return
        }
        stop()
        self.account = account
        let current = generation
        let context = VoiceContext(account: account, sessionId: sessionId)
        self.context = context
        setState(.connecting)
        show(from: presenting)
        preparation = Task { [weak self] in
            do {
                let request = try await context.initial()
                guard let self, !Task.isCancelled, current == generation else { return }
                let api = account.api
                let voice = VoiceSession(permission: {
                    await AVAudioApplication.requestRecordPermission()
                }, credentials: {
                    try await api.voiceCredentials()
                }, lifetime: lifetime, connect: { grant, request, activity, disconnected in
                    try await ElevenLabsVoiceConnection.connect(grant: grant, request: request, context: context,
                                                               activity: activity, disconnected: disconnected)
                })
                self.session = voice
                voice.onState = { [weak self, weak voice] state in
                    guard let self, self.session === voice else { return }
                    self.setState(state)
                    switch state {
                    case .active:
                        Task {
                            await context.start { [weak self, weak voice] update in
                                guard let voice, await self?.isCurrent(voice) == true else { return }
                                await voice.context(update.context, prompts: update.prompts)
                            }
                        }
                    case .idle, .failed, .denied:
                        Task { await context.stop() }
                    case .connecting: break
                    }
                }
                voice.start(request)
            } catch {
                guard let self, current == generation, !Task.isCancelled else { return }
                self.setState(.failed(.unavailable))
                await context.stop()
            }
        }
    }

    private func isCurrent(_ voice: VoiceSession) -> Bool { session === voice }

    private var isRunning: Bool {
        switch state { case .connecting, .active: true; default: false }
    }

    func state(for account: AccountSession) -> VoiceState { self.account === account ? state : .idle }

    public func focus(account: AccountSession, sessionId: String) {
        guard self.account === account, let context else { return }
        Task { await context.focus(sessionId) }
    }

    public func accountDidChange(to account: AccountSession?) {
        guard self.account != nil, self.account !== account else { return }
        stop()
        screen?.dismiss(animated: false)
    }

    public func stop() {
        generation += 1
        preparation?.cancel(); preparation = nil
        session?.stop(); session = nil
        let context = self.context
        self.context = nil
        account = nil
        Task { await context?.stop() }
        setState(.idle)
    }

    func toggleMute() { Task { await session?.toggleMute() } }

    private func show(from presenting: UIViewController) {
        if let screen, screen.presentingViewController != nil { return }
        let screen = VoiceStatusViewController(coordinator: self)
        self.screen = screen
        let navigation = UINavigationController(rootViewController: screen)
        navigation.modalPresentationStyle = .pageSheet
        navigation.sheetPresentationController?.detents = [.medium(), .large()]
        navigation.sheetPresentationController?.prefersGrabberVisible = true
        presenting.present(navigation, animated: true)
    }

    private func setState(_ state: VoiceState) {
        guard state != self.state else { return }
        self.state = state
        screen?.update(state)
        NotificationCenter.default.post(name: .voiceStateChanged, object: self)
    }

    @objc private func backgrounded() { stop() }
    @objc private func audioReset() { stop() }
    @objc private func interrupted(_ notification: Notification) {
        guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              type == AVAudioSession.InterruptionType.began.rawValue else { return }
        stop()
    }
    @objc private func routeChanged(_ notification: Notification) {
        guard let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
        stop()
    }
}
#endif
