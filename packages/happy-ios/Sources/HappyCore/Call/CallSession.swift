import Foundation

/// What a call is started with: the system prompt (`CallPrompt`, the
/// hosted agent's prompt override), its one variable, and the person's
/// language if they chose one. The tools are the hosted agent's
/// (`CallTool`); no greeting is sent.
public struct CallStart: Equatable, Sendable {
    public var prompt: String
    public var context: String
    public var language: String?

    public init(prompt: String = CallPrompt.system, context: String, language: String? = nil) {
        self.prompt = prompt
        self.context = context
        self.language = language
    }
}

/// What the connection reports back while it runs.
public struct CallEvents: Sendable {
    /// Who is speaking, with the person's voice activity score (0...1).
    public var activity: @MainActor @Sendable (CallActivity, Double) -> Void
    /// The call dropped, or the provider ended it unasked.
    public var disconnected: @MainActor @Sendable () -> Void
    /// The agent hung up (its `end_call`): the same as the person tapping End.
    public var hungUp: @MainActor @Sendable () -> Void
    /// One client tool call; the connection replies with the answer.
    public var tool: @Sendable (CallToolCall) async -> CallToolResult
    /// The person's words, as finally transcribed.
    public var heard: @MainActor @Sendable (String) -> Void
    /// The agent's words, by the provider's event for them.
    public var said: @MainActor @Sendable (String, Int) -> Void
    /// The agent's words for an event as they were heard: the person cut in.
    public var corrected: @MainActor @Sendable (String, Int) -> Void

    public init(activity: @escaping @MainActor @Sendable (CallActivity, Double) -> Void,
                disconnected: @escaping @MainActor @Sendable () -> Void,
                hungUp: @escaping @MainActor @Sendable () -> Void,
                tool: @escaping @Sendable (CallToolCall) async -> CallToolResult,
                heard: @escaping @MainActor @Sendable (String) -> Void = { _ in },
                said: @escaping @MainActor @Sendable (String, Int) -> Void = { _, _ in },
                corrected: @escaping @MainActor @Sendable (String, Int) -> Void = { _, _ in }) {
        self.activity = activity
        self.disconnected = disconnected
        self.hungUp = hungUp
        self.tool = tool
        self.heard = heard
        self.said = said
        self.corrected = corrected
    }
}

/// The SDK stays in the UIKit target; this is all of it the call needs.
@MainActor
public protocol CallConnection: AnyObject {
    /// Ends the call and returns once its audio is let go.
    func end() async
    func setMuted(_ muted: Bool) async throws
    /// Context the agent reads without answering.
    func update(_ context: String) async throws
    /// Facts the agent answers aloud (`CallCue`), marked as the app's:
    /// never the person's words, never kept as theirs.
    func cue(_ facts: String) async throws
}

/// One call's life, from the tap to its end: the grant and the device's
/// free time before anything else (a call that can't have either ends at
/// once, without asking for the microphone), then the microphone, then the
/// connection. Context that comes before it is live waits for it, up to
/// 32 KB; past that it is let go, never cut, and put right in one go. A live call is counted against the allowance as it
/// goes, and ends when that runs out. What the person and the agent say
/// goes into `history`, and how the call ended; `CallCues` has the agent
/// speak up before silence or a limit ends it, and a call the agent
/// agreed to restart (`requestRestart`) starts again at once.
///
/// As a phone call, it is held while the phone takes the audio (`hold`,
/// `resume`): silence isn't counted meanwhile, and a connection lost while
/// held, or just after, is made again when the hold ends, this call
/// carried over, rather than ending (`reconnect`).
@MainActor
public final class CallSession {
    public typealias Connect = @MainActor (CallGrant, CallStart, CallEvents) async throws -> any CallConnection

    public private(set) var state: CallState = .idle {
        didSet {
            guard state != oldValue else { return }
            Happenings.post(.callChanged(from: oldValue, to: state, at: now()))
            onState?(state)
        }
    }
    public var onState: (@MainActor (CallState) -> Void)?
    /// The waves' level, from what the call reported (`CallLevel`).
    public var onLevel: (@MainActor (Double) -> Void)?
    /// Context waiting for the call went past `pendingBytes` and was let go
    /// whole: the call's context sends what puts it right (`CallContext.resync`).
    public var onOverflow: (@MainActor () -> Void)?
    /// The agent hung up, after the call went idle: whoever holds it ends
    /// it as End would.
    public var onHangUp: (@MainActor () -> Void)?
    /// A call that went live ended, and its audio is let go: how.
    public var onEnded: (@MainActor (CallEnding) -> Void)?

    private let grants: any CallGrantSource
    private let allowance: CallAllowance?
    private let permission: @MainActor () async -> Bool
    private let connect: Connect
    private let lifetime: VoiceConnectionLifetime
    private let now: () -> Double
    private var connection: (any CallConnection)?
    private var lease: VoiceConnectionLifetime.Lease?
    private var startTask: Task<Void, Never>?
    private var generation = 0
    /// The context updates on their way, the last one sent waiting for those before it.
    private var updating: Task<Void, Never>?
    private var activity: CallActivity = .listening
    private var muted = false
    private var changingMute = false
    private var since: Double = 0
    private var pendingContext: [String] = []
    private var counted: (id: String, start: Double, at: Double)?
    private var counting: Task<Void, Never>?
    private let history: CallHistory?
    private let timing: CallCues.Timing
    private let tick: Duration
    private var cues: CallCues?
    private var cueing: Task<Void, Never>?
    /// What this call has said worth a line, past the agent's greeting.
    private var spoke = false
    private var greeted = false
    private var lastVoice: Double = -.infinity
    private var request: (language: String?, context: @MainActor () async -> String, tool: @Sendable (CallToolCall) async -> CallToolResult)?
    /// Held: the phone has the audio.
    public private(set) var isHeld = false
    /// Its connection went while held: a new one is made when the hold ends.
    private var owed = false
    /// When the last hold ended: a connection that turns out to have gone
    /// with it (the app was suspended meanwhile) is made again too.
    private var resumedAt = -Double.infinity
    /// How long after a hold a lost connection is still the hold's.
    public static let holdGrace: Double = 15

    public init(grants: any CallGrantSource, allowance: CallAllowance? = nil, permission: @escaping @MainActor () async -> Bool,
                lifetime: VoiceConnectionLifetime = VoiceConnectionLifetime(), history: CallHistory? = nil,
                timing: CallCues.Timing = CallCues.Timing(), tick: Duration = .seconds(1),
                now: @escaping () -> Double = { Date().timeIntervalSince1970 }, connect: @escaping Connect) {
        self.grants = grants
        self.allowance = allowance
        self.permission = permission
        self.lifetime = lifetime
        self.history = history
        self.timing = timing
        self.tick = tick
        self.now = now
        self.connect = connect
    }

    /// `context` makes the first snapshot once the grant is in hand;
    /// `tool` answers the hosted agent's tools.
    public func start(language: String?, context: @escaping @MainActor () async -> String,
                      tool: @escaping @Sendable (CallToolCall) async -> CallToolResult) {
        guard startTask == nil, connection == nil, !state.isLive else { return }
        request = (language, context, tool)
        begin()
    }

    /// The agent asked for a fresh call (`happy://call/restart`): it comes
    /// once its words on it are said, this one carried over in the next
    /// one's context. Refused with too little voice time left.
    public func requestRestart() -> CallToolResult {
        guard connection != nil, cues != nil else { return .refused("The call isn't live.") }
        guard cues!.canRestart(allowanceLeft: allowanceLeft()) else {
            return .refused("There isn't enough voice time left to restart; the call ends soon.")
        }
        cues!.restartAsked(at: now())
        return .json(["ok": true, "restarting": true, "note": "The call restarts once you finish speaking; say so in a few words."])
    }

    private func begin() {
        guard let request else { return }
        let language = request.language, context = request.context, tool = request.tool
        generation += 1
        spoke = false
        greeted = false
        history?.began()
        let current = generation
        guard grants.isConfigured else {
            state = .ended(.notSetUp)
            return
        }
        if let allowance, allowance.remaining(at: now()) <= 0 {
            state = .ended(.limitReached)
            return
        }
        state = .connecting
        startTask = Task { [weak self] in
            guard let self else { return }
            defer { if current == generation { startTask = nil } }
            do {
                guard await permission() else {
                    if current == generation { state = .ended(.microphonePermission) }
                    return
                }
                try Task.checkCancellation()
                let grant: CallGrant
                switch try await grants.grant() {
                case .granted(let value): grant = value
                case .refused(let problem):
                    if current == generation { state = .ended(problem) }
                    return
                }
                guard current == generation else { return }
                let request = CallStart(context: await context(), language: language)
                try Task.checkCancellation()
                let acquired = try await lifetime.acquire()
                let events = CallEvents(activity: { [weak self] activity, vad in
                    guard let self, current == self.generation else { return }
                    if self.activity == .agentSpeaking, activity != .agentSpeaking { self.cues?.agentSpoke(at: self.now()) }
                    if activity == .userSpeaking { self.lastVoice = self.now() }
                    self.activity = activity
                    self.onLevel?(CallLevel.level(activity: activity, vad: vad, muted: self.muted))
                    if self.connection != nil { self.state = .active(activity, muted: self.muted, since: self.since) }
                }, disconnected: { [weak self] in
                    guard let self, current == self.generation else { return }
                    self.lost()
                }, hungUp: { [weak self] in
                    guard let self, current == self.generation else { return }
                    self.stop(.agentHungUp)
                    self.onHangUp?()
                }, tool: tool, heard: { [weak self] text in
                    guard let self, current == self.generation else { return }
                    self.cues?.heard(at: self.now())
                    self.spoke = true
                    self.greeted = true
                    self.history?.heard(text, at: self.wall())
                }, said: { [weak self] text, event in
                    guard let self, current == self.generation else { return }
                    // Its first words before anyone else's are the hosted agent's greeting.
                    guard self.greeted else { self.greeted = true; return }
                    self.spoke = true
                    self.history?.said(text, event: event, at: self.wall())
                }, corrected: { [weak self] text, event in
                    guard let self, current == self.generation else { return }
                    self.history?.corrected(text, event: event)
                })
                let opened: any CallConnection
                do { opened = try await connect(grant, request, events) }
                catch { acquired.finish(); throw error }
                guard !Task.isCancelled, current == generation else {
                    await opened.end()
                    acquired.finish()
                    return
                }
                connection = opened
                lease = acquired
                muted = false
                since = now()
                cues = CallCues(timing: timing, since: since)
                state = .active(activity, muted: false, since: since)
                count(current)
                cue(current)
                flushContext()
            } catch is CancellationError {
                if current == generation { state = .idle }
            } catch APIError.unauthorized {
                if current == generation { state = .ended(.authentication) }
            } catch {
                if current == generation { state = .ended(.connection) }
            }
        }
    }

    /// Hangs up, or closes the bar of a call that ended; `ending` says why,
    /// for a call that was live.
    public func stop(_ ending: CallEnding = .hungUp) {
        unhold()
        tearDown(ending)
        state = .idle
    }

    private func end(_ problem: CallProblem, as ending: CallEnding) {
        unhold()
        tearDown(ending)
        state = .ended(problem)
    }

    private func unhold() {
        isHeld = false
        owed = false
        resumedAt = -.infinity
    }

    /// The phone took the audio (another call, Siri, an alarm): the call
    /// waits for it, however long, as a call on hold.
    public func hold() {
        guard state.isLive else { return }
        isHeld = true
    }

    /// The audio is back: the call carries on, or, if its connection went
    /// meanwhile, a new one is made with this call carried over.
    public func resume() {
        guard isHeld else { return }
        isHeld = false
        resumedAt = now()
        // Its silence starts again from here: nobody could speak while held.
        cues?.heard(at: now())
        lastVoice = now()
        if owed {
            owed = false
            begin()
        }
    }

    /// The call's audio or connection can't be had back as it is (the
    /// media services were reset, the engine didn't start again): a new
    /// connection, this call carried over, at once or when the hold ends.
    public func reconnect() {
        guard state.isLive, request != nil else { return }
        tearDown(.interrupted)
        if isHeld {
            owed = true
            state = .connecting
        } else {
            begin()
        }
    }

    /// The connection went: a drop, unless the phone had the audio (then
    /// it is made again once it hasn't).
    private func lost() {
        guard isHeld || now() - resumedAt < Self.holdGrace else { return end(.connection, as: dropped()) }
        reconnect()
    }

    /// What ended a call the provider let go of unasked: its limit, its
    /// own silence timeout (never first, `CallCues`), or a drop.
    private func dropped() -> CallEnding {
        if now() - since >= timing.callLimit - 3 * timing.callLimitMargin { return .callLimit }
        return .dropped
    }

    /// The wall clock, for the history, whatever `now` counts.
    private func wall() -> Double { Date().timeIntervalSince1970 }

    /// Voice time left now, counting what isn't written down yet.
    private func allowanceLeft() -> Double? {
        guard let allowance else { return nil }
        let at = now()
        return max(0, allowance.remaining(at: at) - (counted.map { at - $0.at } ?? 0))
    }

    /// Asks the cues every `tick` what to do while the call is live.
    private func cue(_ current: Int) {
        cueing = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, current == self.generation else { return }
                try? await Task.sleep(for: self.tick)
                guard current == self.generation, self.connection != nil, var cues = self.cues else { return }
                // Nobody can speak on hold, and its limits wait for it too.
                if self.isHeld { continue }
                let moment = CallCues.Moment(now: self.now(), agentSpeaking: self.activity == .agentSpeaking,
                                             personSpeaking: self.activity == .userSpeaking || self.now() - self.lastVoice < 1.5,
                                             allowanceLeft: self.allowanceLeft(), allowanceTotal: self.allowance?.total)
                let action = cues.next(moment)
                self.cues = cues
                switch action {
                case .cue(let cue)?:
                    let connection = self.connection
                    Task { try? await connection?.cue(cue.text) }
                case .end(let ending)?:
                    return self.stop(ending)
                case .restart?:
                    self.tearDown(.restarted)
                    return self.begin()
                case nil:
                    break
                }
            }
        }
    }

    /// Writes the call's time down every 10 seconds, so a call the app
    /// never saw end still counts, and ends it when the free time is gone.
    private func count(_ current: Int) {
        guard let allowance else { return }
        let call = (id: UUID().uuidString, start: since)
        counted = (call.id, call.start, since)
        counting = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, current == self.generation else { return }
                let now = self.now()
                allowance.record(call: call.id, from: call.start, to: now)
                self.counted = (call.id, call.start, now)
                let left = allowance.remaining(at: now)
                if left <= 0 { return self.end(.limitReached, as: .timeUsed) }
                try? await Task.sleep(for: .seconds(min(10, left)))
            }
        }
    }

    private func tearDown(_ ending: CallEnding = .hungUp) {
        generation += 1
        startTask?.cancel()
        startTask = nil
        counting?.cancel()
        counting = nil
        cueing?.cancel()
        cueing = nil
        cues = nil
        if let counted { allowance?.record(call: counted.id, from: counted.start, to: now()) }
        counted = nil
        let old = connection
        let oldLease = lease
        connection = nil
        lease = nil
        pendingContext.removeAll()
        activity = .listening
        lastVoice = -.infinity
        muted = false
        changingMute = false
        onLevel?(0)
        // Only a call that went live ended; a plain end is worth a line only after words.
        if old != nil, spoke || !ending.isPlain { history?.ended(ending, at: wall()) }
        spoke = false
        // Told even once whoever held the session has let it go.
        let ended = old == nil ? nil : onEnded
        Task {
            await old?.end()
            oldLease?.finish()
            ended?(ending)
        }
    }

    public func toggleMute() async {
        guard let connection, !changingMute else { return }
        let current = generation
        let target = !muted
        changingMute = true
        defer { if current == generation { changingMute = false } }
        do {
            try await connection.setMuted(target)
            guard current == generation else { return }
            muted = target
            state = .active(activity, muted: muted, since: since)
        } catch {
            guard current == generation else { return }
            lost()
        }
    }

    /// The most context kept while the call isn't live yet.
    public static let pendingBytes = 32 * 1024

    /// Context from the call's context; kept until it is live. Past
    /// `pendingBytes` none of it is kept, rather than words with a hole in
    /// them: `onOverflow` asks for what puts the agent right instead.
    public func deliver(_ update: CallUpdate) {
        guard state.isLive, !update.isEmpty else { return }
        pendingContext += update.context
        if pendingContext.reduce(0, { $0 + $1.utf8.count + 1 }) > Self.pendingBytes {
            pendingContext.removeAll()
            onOverflow?()
            return
        }
        flushContext()
    }

    /// Returns once every update delivered so far has reached the
    /// connection, or failed to.
    public func delivered() async {
        await updating?.value
    }

    private func flushContext() {
        guard let connection, !pendingContext.isEmpty else { return }
        let text = pendingContext.joined(separator: "\n")
        pendingContext.removeAll()
        let current = generation
        // One after another, in the order given, however long each takes.
        let previous = updating
        updating = Task {
            await previous?.value
            guard current == generation else { return }
            do { try await connection.update(text) }
            catch { if current == generation { lost() } }
        }
    }
}
