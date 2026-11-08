#if canImport(UIKit)
import AVFAudio
import HappyCore
import HappyLayout
import UIKit

/// The agent connection's voice call: started from home's voice button,
/// shown as the bar across the window's top (`ShellViewController`), bound
/// to the one connection it started on. It ends in the background, on an
/// audio interruption or a lost route, and when the connection changes.
/// What each call said is kept for the connection's next one
/// (`CallHistory`), and a call that ends unasked plays `CallDropSound`.
/// Apart from the relay's `VoiceCoordinator`: one call at a time, the newer wins.
@MainActor
final class CallController {
    static let shared = CallController()
    /// Posted as `state` changes, for what shows it outside the bar: the
    /// header's call button (`CallBarButtonItem`).
    static let stateDidChange = Notification.Name("CallController.stateDidChange")

    private var session: CallSession?
    private var context: CallContext?
    private var targets: SessionCallTargets?
    private var connectionID: String?
    private weak var shell: ShellViewController?
    private var clock: Timer?
    private(set) var state: CallState = .idle
    /// A call has the microphone: dictation waits for it to end.
    var holdsMicrophone: Bool { state.isLive }
    private var focus: String?
    private var observers: [NSObjectProtocol] = []
    #if DEBUG
    private var fixture: Task<Void, Never>?
    #endif

    /// The build's public hosted agent, if it has one (`CallAgent`).
    private static var grants: any CallGrantSource {
        CallAgent.hostedAgentId.map { PublicAgentCallGrants(agentId: $0) } ?? UnconfiguredCallGrants()
    }

    /// 20 free minutes in 30 days, or the subscription's 5 hours a month.
    private let allowance = CallAllowance(period: { Offers.shared.month() })
    private let offers = Offers.shared

    private init() {
        let center = NotificationCenter.default
        let stops: [(Notification.Name, CallEnding)] = [(UIApplication.didEnterBackgroundNotification, .background),
                                                        (AVAudioSession.mediaServicesWereResetNotification, .interrupted)]
        for (name, ending) in stops {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.hangUp(ending) }
            })
        }
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            MainActor.assumeIsolated { if began { self?.hangUp(.interrupted) } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let lost = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
            MainActor.assumeIsolated { if lost { self?.hangUp(.interrupted) } }
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
    /// While a subscription is on sale, a device's first tap is voice's
    /// welcome instead, once: its "Start Voice Session" calls, and from then
    /// on the button does. With nothing on sale there is no welcome.
    func start(session account: Session, from controller: UIViewController) {
        guard let shell = controller.view.window?.rootViewController as? ShellViewController else { return }
        if state.isLive, connectionID == account.accountID { return }
        guard !offers.isShowing else { return }
        if offers.welcomes() {
            // Only its "Start Voice Session" calls; closing it, or buying there, starts nothing.
            Task { [weak self, weak controller] in
                guard let self, await self.offers.ask(.welcome, over: Self.top(of: shell)) == .start, let controller else { return }
                self.start(session: account, from: controller)
            }
            return
        }
        close()
        self.shell = shell
        connectionID = account.accountID
        let targets = SessionCallTargets(session: account, shell: shell)
        let context = CallContext(targets: targets)
        let history = CallHistory(store: account.offline.map { OfflineCallHistoryStore(offline: $0) })
        // The relay's call stops once this one really starts: a connection that can't call leaves it alone.
        let call = CallSession(grants: Self.grants, allowance: allowance, permission: {
            VoiceCoordinator.shared.stop()
            return await AVAudioApplication.requestRecordPermission()
        }, history: history) { grant, request, events in
            try await ElevenLabsCallConnection.connect(grant: grant, request: request, events: events)
        }
        // Not the person's own end, nor the agent's goodbye: those were heard coming.
        call.onEnded = { ending in if ending.isUnexpected { CallDropSound.play() } }
        Task { [weak call] in
            await context.onRestart {
                await MainActor.run { call?.requestRestart() } ?? CallToolResult(text: #"{"ok":false,"reason":"The call has ended."}"#, isError: true)
            }
        }
        self.targets = targets
        self.context = context
        session = call
        call.onState = { [weak self, weak call] state in
            guard let self, let call, self.session === call else { return }
            // Ended, it hears from nothing more: only its bar stays, saying why.
            if case .ended = state { self.letGo() }
            self.show(state)
        }
        call.onOverflow = { [weak self, weak call] in
            Task {
                let update = await context.resync()
                guard let self, let call, self.session === call else { return }
                self.deliver(update)
            }
        }
        // The agent hung up: as if End were tapped, with no bar left.
        call.onHangUp = { [weak self, weak call] in
            guard let self, let call, self.session === call else { return }
            self.close()
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
        focus = targets.focusedNow
        call.start(language: nil, context: {
            let initial = await context.initial(previous: history.slots)
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

    /// End: the call, or the bar of one that ended; `ending` says why, for
    /// the call's history.
    func close(_ ending: CallEnding = .hungUp) {
        #if DEBUG
        fixture?.cancel(); fixture = nil
        #endif
        let old = session
        session = nil
        old?.stop(ending)
        letGo()
        connectionID = nil
        show(.idle)
    }

    /// What the call followed, let go of: its context and the conversations it held.
    private func letGo() {
        let context = self.context
        self.context = nil
        Task { await context?.close() }
        targets?.close()
        targets = nil
        focus = nil
    }

    /// The call stops for the system; one that was live leaves no bar.
    private func hangUp(_ ending: CallEnding) {
        guard state.isShown else { return }
        close(ending)
    }

    private func show(_ state: CallState) {
        let changed = self.state != state
        self.state = state
        if changed { NotificationCenter.default.post(name: Self.stateDidChange, object: self) }
        updateClock()
        guard let shell else { return }
        let bar = shell.callBar
        bar.onMute = { [weak self] in Task { await self?.session?.toggleMute() } }
        bar.onEnd = { [weak self] in self?.close() }
        bar.onTap = { [weak self] in
            switch self?.state {
            case .ended(.microphonePermission):
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            default: break
            }
        }
        // The free time is used, on a tap or mid-call: the paywall, once,
        // full height in place of the bar, which goes; the voice button
        // shows it again.
        if state == .ended(.limitReached) {
            showPaywall()
            return close()
        }
        // A bar going away keeps what it last said while it slides out.
        if state.isShown { bar.apply(state, clock: clockText, animated: shell.callBarShown) }
        shell.setCallBarShown(state.isShown, animated: true)
        if !state.isShown { self.shell = nil }
    }

    /// The voice paywall over whatever is on top, unless an offer sheet
    /// already is. Bought there, the voice button calls again.
    private func showPaywall() {
        guard let shell, !offers.isShowing else { return }
        let now = Date().timeIntervalSince1970
        let freeAgain = allowance.freeAgain(after: now).flatMap { $0 > now ? Date(timeIntervalSince1970: $0) : nil }
        offers.show(.used(freeAgain: freeAgain), over: Self.top(of: shell))
    }

    private static func top(of shell: UIViewController) -> UIViewController {
        var top = shell
        while let next = top.presentedViewController { top = next }
        return top
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
    /// Test runs only, from the launch environment: `HAPPY_CALL_INTRO=due`
    /// shows the welcome again (`seen`: never), `HAPPY_CALL_USED=1` spends the free time
    /// (a 20-minute call that ended now), and `HAPPY_CALL_STEPS` presses
    /// what a person would, one step every 3 s: `tap` the voice button,
    /// `subscribe`, `session` or `close` on voice's sheet on top, `dismiss` an alert. Each step logs what is
    /// on top and the call's state (`[call-steps]`).
    func applyTestEnvironment(tap: @escaping @MainActor () -> Void) {
        let environment = ProcessInfo.processInfo.environment
        if environment["HAPPY_CALL_INTRO"] == "due" { UserDefaults.standard.removeObject(forKey: CallIntro.key) }
        if environment["HAPPY_CALL_INTRO"] == "seen" { offers.intro.seen() }
        if environment["HAPPY_CALL_USED"] == "1" {
            let now = Date().timeIntervalSince1970
            allowance.record(call: "test-used", from: now - CallAllowance.freeSeconds, to: now)
        }
        guard let steps = environment["HAPPY_CALL_STEPS"]?.split(separator: ",").map(String.init) else { return }
        Task { [weak self] in
            for step in steps {
                try? await Task.sleep(for: .seconds(3))
                guard let self else { return }
                let sheet = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }.first.map(Self.top(of:)) as? CallSheetViewController
                switch step {
                case "tap": tap()
                case "subscribe": sheet?.subscribe?.sendActions(for: .touchUpInside)
                case "session": if sheet?.session.isEnabled == true { sheet?.session.sendActions(for: .touchUpInside) }
                case "close": sheet?.close.sendActions(for: .primaryActionTriggered)
                case "dismiss": (UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }.first.map(Self.top(of:)) as? UIAlertController)?.dismiss(animated: true)
                default: break
                }
                try? await Task.sleep(for: .seconds(1))
                let top = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }.first.map(Self.top(of:))
                let shown = (top as? CallSheetViewController).map { "\($0.screen)" } ?? top.map { String(describing: type(of: $0)) } ?? "nothing"
                print("[call-steps] \(step) -> top \(shown), call \(self.state), intro due \(self.offers.intro.due), bar \(self.state.isShown)")
            }
            print("[call-steps] done")
        }
    }

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
