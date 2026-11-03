#if canImport(UIKit)
import AVFAudio
import HappyCore
import HappyLayout
import UIKit

/// The agent connection's voice call: started from home's voice button,
/// shown as the bar across the window's top (`ShellViewController`), bound
/// to the one connection it started on. It ends in the background, on an
/// audio interruption or a lost route, and when the connection changes.
/// Apart from the relay's `VoiceCoordinator`: one call at a time, the newer wins.
@MainActor
final class CallController {
    static let shared = CallController()

    private var session: CallSession?
    private var context: CallContext?
    private var targets: SessionCallTargets?
    private var directoryWatch: Watch?
    private var connectionID: String?
    private weak var shell: ShellViewController?
    private var clock: Timer?
    private var state: CallState = .idle
    private var focus: String?
    private var observers: [NSObjectProtocol] = []
    #if DEBUG
    private var fixture: Task<Void, Never>?
    #endif

    /// The build's public hosted agent, if it has one (`CallAgent`).
    private static var grants: any CallGrantSource {
        CallAgent.hostedAgentId.map { PublicAgentCallGrants(agentId: $0) } ?? UnconfiguredCallGrants()
    }

    private let allowance = CallAllowance()

    private init() {
        let center = NotificationCenter.default
        let stops: [Notification.Name] = [UIApplication.didEnterBackgroundNotification, AVAudioSession.mediaServicesWereResetNotification]
        for name in stops {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.hangUp() }
            })
        }
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            MainActor.assumeIsolated { if began { self?.hangUp() } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let lost = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
            MainActor.assumeIsolated { if lost { self?.hangUp() } }
        })
        // One call at a time: the relay's starting ends this one.
        observers.append(center.addObserver(forName: .voiceStateChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                switch VoiceCoordinator.shared.state {
                case .connecting, .active: if self?.state.isLive == true { self?.close() }
                default: break
                }
            }
        })
    }

    var isShowing: Bool { state.isShown }

    /// The voice button: a call on this connection, or the one already on.
    func start(session account: Session, from controller: UIViewController) {
        guard let shell = controller.view.window?.rootViewController as? ShellViewController else { return }
        if state.isLive, connectionID == account.accountID { return }
        close()
        self.shell = shell
        connectionID = account.accountID
        let targets = SessionCallTargets(session: account, shell: shell)
        let context = CallContext(targets: targets)
        // The relay's call stops once this one really starts: a connection that can't call leaves it alone.
        let call = CallSession(grants: Self.grants, allowance: allowance, permission: {
            VoiceCoordinator.shared.stop()
            return await AVAudioApplication.requestRecordPermission()
        }) { grant, request, events in
            try await ElevenLabsCallConnection.connect(grant: grant, request: request, events: events)
        }
        self.targets = targets
        self.context = context
        session = call
        call.onState = { [weak self, weak call] state in
            guard let self, let call, self.session === call else { return }
            self.show(state)
        }
        call.onOverflow = { [weak self, weak call] in
            Task {
                let update = await context.resync()
                guard let self, let call, self.session === call else { return }
                self.deliver(update)
            }
        }
        call.onLevel = { [weak self, weak call] level in
            guard let self, let call, self.session === call else { return }
            self.shell?.callBar.update(level: level)
        }
        // Each callback belongs to this call: once it ends, or another one
        // starts, what it still says goes nowhere.
        targets.onChange = { [weak self, weak call] state in
            guard let self, let call, self.session === call else { return }
            Task {
                let update = await context.targetChanged(state)
                if self.session === call { self.deliver(update) }
            }
        }
        directoryWatch = targets.watchDirectory { [weak self, weak call] rows in
            guard let self, let call, self.session === call else { return }
            Task {
                let update = await context.directoryChanged(rows)
                guard self.session === call else { return }
                self.deliver(update)
                await Self.hold(await context.followed, in: targets)
            }
        }
        focus = targets.focusedNow
        call.start(language: nil, context: {
            let initial = await context.initial()
            await Self.hold(await context.followed, in: targets)
            return initial
        }, tool: { call in await context.handle(call) })
        // A call that can't start says so in the bar; one that can starts connecting there.
        show(call.state)
    }

    /// The screen on top changed: the conversation in front is the call's
    /// focus, and the latest it has visited.
    func topDidChange() {
        guard state.isLive, let targets, let context else { return }
        let now = targets.focusedNow
        guard now != focus else { return }
        focus = now
        let call = session
        Task {
            let update = await context.focusChanged(to: now)
            guard session === call else { return }
            deliver(update)
            await Self.hold(await context.followed, in: targets)
        }
    }

    /// Exactly the conversations the call hears from stay read: one that
    /// dropped out of the last visited is let go.
    private static func hold(_ followed: [String], in targets: SessionCallTargets) async {
        for id in targets.following where !followed.contains(id) { await targets.follow(id, false) }
        for id in followed where !targets.following.contains(id) { await targets.follow(id, true) }
    }

    /// The window's connection changed: a call bound to another one ends.
    func connectionDidChange(to id: String?) {
        guard state.isShown, id != connectionID else { return }
        close()
    }

    private func deliver(_ update: CallUpdate) {
        guard !update.isEmpty else { return }
        session?.deliver(update)
    }

    /// End: the call, or the bar of one that ended.
    func close() {
        #if DEBUG
        fixture?.cancel(); fixture = nil
        #endif
        let old = session
        session = nil
        old?.stop()
        let context = self.context
        self.context = nil
        Task { await context?.close() }
        targets?.close()
        targets = nil
        directoryWatch = nil
        connectionID = nil
        focus = nil
        show(.idle)
    }

    /// The call stops for the system; one that was live leaves no bar.
    private func hangUp() {
        guard state.isShown else { return }
        close()
    }

    private func show(_ state: CallState) {
        let before = self.state
        self.state = state
        updateClock()
        guard let shell else { return }
        let bar = shell.callBar
        bar.onMute = { [weak self] in Task { await self?.session?.toggleMute() } }
        bar.onEnd = { [weak self] in self?.close() }
        bar.onTap = { [weak self] in
            switch self?.state {
            case .ended(.microphonePermission):
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            case .ended(.limitReached):
                self?.showPaywall()
            default: break
            }
        }
        // The free time is used, on a tap or mid-call: the paywall, once.
        if state == .ended(.limitReached), before != state { showPaywall() }
        // A bar going away keeps what it last said while it slides out.
        if state.isShown { bar.apply(state, clock: clockText, animated: shell.callBarShown) }
        shell.setCallBarShown(state.isShown, animated: true)
        if !state.isShown { self.shell = nil }
    }

    /// The voice paywall over whatever is on top, unless it already is.
    private func showPaywall() {
        guard let shell else { return }
        var top: UIViewController = shell
        while let next = top.presentedViewController { top = next }
        if ((top as? UINavigationController)?.viewControllers.first is CallPaywallViewController) { return }
        let now = Date().timeIntervalSince1970
        let freeAgain = allowance.freeAgain(after: now).flatMap { $0 > now ? Date(timeIntervalSince1970: $0) : nil }
        CallPaywallViewController.present(freeAgain: freeAgain, offer: .unavailable, over: top)
    }

    private var clockText: String? {
        guard case .active(_, _, let since) = state else { return nil }
        return Self.clock(seconds: Int(max(0, Date().timeIntervalSince1970 - since)))
    }

    private func updateClock() {
        guard case .active = state else {
            clock?.invalidate()
            clock = nil
            return
        }
        guard clock == nil else { return }
        clock = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let shell = self.shell else { return }
                shell.callBar.apply(self.state, clock: self.clockText, animated: false)
            }
        }
    }

    /// Telegram's call clock: m:ss, then h:mm:ss.
    static func clock(seconds: Int) -> String {
        if seconds < 3600 { return String(format: "%d:%02d", seconds / 60, seconds % 60) }
        return String(format: "%d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
    }

    #if DEBUG
    /// Screenshots only: draws the bar in one state from a script, with no
    /// microphone, provider or grant (`HAPPY_CALL_FIXTURE`), or `cycle`
    /// through them all and out again. Never a call.
    func showFixture(_ name: String, from controller: UIViewController) {
        guard let shell = controller.view.window?.rootViewController as? ShellViewController else { return }
        close()
        self.shell = shell
        let since = Date().timeIntervalSince1970 - 42
        let states: [String: CallState] = [
            "connecting": .connecting,
            "listening": .active(.listening, muted: false, since: since),
            "speaking": .active(.agentSpeaking, muted: false, since: since),
            "user": .active(.userSpeaking, muted: false, since: since),
            "muted": .active(.listening, muted: true, since: since),
            "ended": .ended(.connection),
            "limit": .ended(.limitReached),
        ]
        let script: [(CallState, Double)]
        if name == "cycle" {
            script = [(.connecting, 2), (states["listening"]!, 2), (states["speaking"]!, 4), (states["user"]!, 3),
                      (states["muted"]!, 2), (.idle, 2), (states["speaking"]!, 3), (.idle, 1)]
        } else if let state = states[name] {
            script = [(state, .infinity)]
        } else { return }
        fixture = Task { [weak self, weak shell] in
            var phase = 0.0
            for (state, seconds) in script {
                guard let self, let shell, !Task.isCancelled else { return }
                self.shell = shell
                self.show(state)
                shell.callBar.onEnd = { [weak self] in self?.close() }
                let until = Date().addingTimeInterval(seconds.isFinite ? seconds : 1e9)
                while Date() < until, !Task.isCancelled {
                    phase += 0.12
                    let speaking: Bool = if case .active(let activity, let muted, _) = state { activity != .listening && !muted } else { false }
                    shell.callBar.update(level: speaking ? 0.7 + 0.6 * sin(phase) * sin(phase * 0.37) : 0)
                    try? await Task.sleep(for: .milliseconds(100))
                }
            }
        }
    }
    #endif
}
#endif
