#if canImport(UIKit)
import AVFAudio
import HappyCore
import UIKit

/// One voice call on one agent connection, with no screen of its own: its
/// lifetime, its audio, and what it hears and does (`CallSession`,
/// `CallContext`, `SessionCallTargets`). A front end owns it and draws what
/// `onState` and `onLevel` say: the phone's bar (`CallController`). What a
/// call says is kept for the connection's next one (`CallHistory`), and one
/// that ends unasked plays `CallDropSound`.
///
/// It ends when the system takes its audio: an interruption, a media
/// services reset, or a lost route (a car's audio coming in is not a lost
/// route). The front end hears that (`onInterrupted`) and closes. Leaving
/// the screen is the front end's to decide.
@MainActor
final class AgentCall {
    /// 20 free minutes in 30 days, or the subscription's 2 hours a month:
    /// one ledger for every call on this device, whichever front end.
    static let allowance = CallAllowance(period: { Offers.shared.month() })

    /// The build's public hosted agent, if it has one (`CallAgent`).
    static var grants: any CallGrantSource {
        CallAgent.hostedAgentId.map { PublicAgentCallGrants(agentId: $0) } ?? UnconfiguredCallGrants()
    }

    let connectionID: String
    var state: CallState { session.state }
    /// The call's state, as it changes; ended, it hears from nothing more.
    var onState: ((CallState) -> Void)?
    /// The voice's level, for waves.
    var onLevel: ((Double) -> Void)?
    /// The agent hung up (its `end_call`): close as if End were tapped.
    var onHangUp: (() -> Void)?
    /// The system took the audio: close, with this ending for the history.
    var onInterrupted: ((CallEnding) -> Void)?

    private let session: CallSession
    private let account: Session
    private let history: CallHistory
    private var context: CallContext?
    private var targets: SessionCallTargets?
    private var directoryWatch: Watch?
    private var directorySettle: DirectorySettle?
    private var focus: String?
    private var observers: [NSObjectProtocol] = []
    private var stopped = false

    /// A call on `account`; `shell` is the window whose screens the call's
    /// `navigate` moves and whose top is its focus, nil for none.
    init(session account: Session, shell: ShellViewController?) {
        self.account = account
        connectionID = account.accountID
        let targets = SessionCallTargets(session: account, shell: shell)
        let context = CallContext(targets: targets)
        let history = CallHistory(store: account.offline.map { OfflineCallHistoryStore(offline: $0) })
        self.history = history
        let call = CallSession(grants: Self.grants, allowance: Self.allowance, permission: {
            await AVAudioApplication.requestRecordPermission()
        }, history: history) { grant, request, events in
            try await ElevenLabsCallConnection.connect(grant: grant, request: request, events: events)
        }
        session = call
        self.targets = targets
        self.context = context
        // Not the person's own end, nor the agent's goodbye: those were heard coming.
        call.onEnded = { ending in if ending.isUnexpected { CallDropSound.play() } }
        Task { [weak call] in
            await context.onRestart {
                await MainActor.run { call?.requestRestart() } ?? CallToolResult(text: #"{"ok":false,"reason":"The call has ended."}"#, isError: true)
            }
        }
        // What a read's refresh found after the read answered: context, never a cue.
        Task { [weak call] in
            await context.onReading { line in
                Task { @MainActor in call?.deliver(CallUpdate(context: [line])) }
            }
        }
        call.onState = { [weak self] state in
            guard let self, !self.stopped else { return }
            // Ended, it hears from nothing more: only its front end stays, saying why.
            if case .ended = state { self.letGo() }
            self.onState?(state)
        }
        call.onOverflow = { [weak self] in
            Task {
                let update = await context.resync()
                guard let self, !self.stopped else { return }
                self.deliver(update)
            }
        }
        call.onHangUp = { [weak self] in
            guard let self, !self.stopped else { return }
            self.onHangUp?()
        }
        call.onLevel = { [weak self] level in
            guard let self, !self.stopped else { return }
            self.onLevel?(level)
        }
        // Each callback belongs to this call: once it ends, what it still says goes nowhere.
        targets.onChange = { [weak self] state in
            guard let self, !self.stopped else { return }
            Task {
                let update = await context.targetChanged(state)
                if !self.stopped { self.deliver(update) }
            }
        }
        // A change to the sidebar settles for a second from the first one,
        // never longer, then goes as one update of what changed.
        let settle = DirectorySettle { [weak self] in
            guard let self, !self.stopped else { return }
            let update = await context.directoryUpdate()
            if !self.stopped { self.deliver(update) }
        }
        directorySettle = settle
        directoryWatch = targets.watchDirectory { [weak self, weak settle] rows in
            guard let self, !self.stopped else { return }
            Task {
                guard await context.directoryChanged(rows), !self.stopped else { return }
                settle?.changed()
            }
        }
        observeAudio()
    }

    /// Connects, or ends at once saying why it can't (`state`).
    func start() {
        guard let targets, let context else { return }
        let account = account, history = history
        focus = targets.focusedNow
        session.start(language: nil, context: {
            let initial = await context.initial(previous: history.slots, person: await Self.person(account))
            await Self.hold(await context.followed, in: targets)
            return initial
        }, tool: { call in
            let result = await context.handle(call)
            // A message makes where it went one the call hears from.
            await Self.hold(await context.followed, in: targets)
            return result
        })
    }

    /// The screen on top changed: the conversation in front is the call's
    /// focus, and the latest it has visited.
    func topDidChange() {
        guard state.isLive, let targets, let context else { return }
        let now = targets.focusedNow
        guard now != focus else { return }
        focus = now
        Task {
            let update = await context.focusChanged(to: now)
            guard !stopped else { return }
            deliver(update)
            await Self.hold(await context.followed, in: targets)
        }
    }

    func toggleMute() async { await session.toggleMute() }

    /// Ends it, `ending` saying why for the call's history, and lets go of
    /// everything it followed. Its front end hears nothing more.
    func stop(_ ending: CallEnding = .hungUp) {
        guard !stopped else { return }
        stopped = true
        session.stop(ending)
        letGo()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
    }

    private func deliver(_ update: CallUpdate) {
        guard !update.isEmpty else { return }
        session.deliver(update)
    }

    /// What the call followed, let go of: its context and the conversations it held.
    private func letGo() {
        let context = self.context
        self.context = nil
        Task { await context?.close() }
        targets?.close()
        targets = nil
        directoryWatch?.invalidate()
        directoryWatch = nil
        directorySettle?.cancel()
        directorySettle = nil
        focus = nil
    }

    /// The system taking the audio ends the call: an interruption's
    /// start, a media services reset, or the route losing its device. A
    /// car's audio is never a lost route: connecting a car drops the
    /// route it replaces.
    private func observeAudio() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.interrupted(.interrupted) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            MainActor.assumeIsolated { if began { self?.interrupted(.interrupted) } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let lost = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
            let car = AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .carAudio }
            MainActor.assumeIsolated { if lost, !car { self?.interrupted(.interrupted) } }
        })
    }

    private func interrupted(_ ending: CallEnding) {
        if let onInterrupted { onInterrupted(ending) } else { stop(ending) }
    }

    /// Who the call talks to, in a team: the person's name on this
    /// computer; nil outside one, or while it can't be read.
    private static func person(_ account: Session) async -> String? {
        guard account.home.userId != nil else { return nil }
        var name = account.profile.state.name
        if name.isEmpty { name = (try? await account.client.profile())?.name ?? "" }
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// Exactly the conversations the call hears from stay read: one that
    /// dropped out of the last visited is let go.
    private static func hold(_ followed: [String], in targets: SessionCallTargets) async {
        for id in targets.following where !followed.contains(id) { await targets.follow(id, false) }
        for id in followed where !targets.following.contains(id) { await targets.follow(id, true) }
    }
}
#endif
