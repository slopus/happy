import Foundation

/// What a call is started with: the hosted prompt's one variable, and the
/// person's language if they chose one. No prompt, greeting or tools are
/// sent from here: the hosted agent has its own.
public struct CallStart: Equatable, Sendable {
    public var context: String
    public var language: String?

    public init(context: String, language: String? = nil) {
        self.context = context
        self.language = language
    }
}

/// What the connection reports back while it runs.
public struct CallEvents: Sendable {
    /// Who is speaking, with the person's voice activity score (0...1).
    public var activity: @MainActor @Sendable (CallActivity, Double) -> Void
    /// The provider ended the call, or it dropped.
    public var disconnected: @MainActor @Sendable () -> Void
    /// One client tool call; the connection replies with the answer.
    public var tool: @Sendable (CallToolCall) async -> CallToolResult

    public init(activity: @escaping @MainActor @Sendable (CallActivity, Double) -> Void,
                disconnected: @escaping @MainActor @Sendable () -> Void,
                tool: @escaping @Sendable (CallToolCall) async -> CallToolResult) {
        self.activity = activity
        self.disconnected = disconnected
        self.tool = tool
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
}

/// One call's life, from the tap to its end: the grant and the device's
/// free time before anything else (a call that can't have either ends at
/// once, without asking for the microphone), then the microphone, then the
/// connection. Context that comes before it is live waits for it, up to
/// 32 KB; past that it is let go, never cut, and put right in one go. A live call is counted against the allowance as it
/// goes, and ends when that runs out.
@MainActor
public final class CallSession {
    public typealias Connect = @MainActor (CallGrant, CallStart, CallEvents) async throws -> any CallConnection

    public private(set) var state: CallState = .idle {
        didSet { if state != oldValue { onState?(state) } }
    }
    public var onState: (@MainActor (CallState) -> Void)?
    /// The waves' level, from what the call reported (`CallLevel`).
    public var onLevel: (@MainActor (Double) -> Void)?
    /// Context waiting for the call went past `pendingBytes` and was let go
    /// whole: the call's context sends what puts it right (`CallContext.resync`).
    public var onOverflow: (@MainActor () -> Void)?

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
    private var activity: CallActivity = .listening
    private var muted = false
    private var changingMute = false
    private var since: Double = 0
    private var pendingContext: [String] = []
    private var counted: (id: String, start: Double)?
    private var counting: Task<Void, Never>?

    public init(grants: any CallGrantSource, allowance: CallAllowance? = nil, permission: @escaping @MainActor () async -> Bool,
                lifetime: VoiceConnectionLifetime = VoiceConnectionLifetime(),
                now: @escaping () -> Double = { Date().timeIntervalSince1970 }, connect: @escaping Connect) {
        self.grants = grants
        self.allowance = allowance
        self.permission = permission
        self.lifetime = lifetime
        self.now = now
        self.connect = connect
    }

    /// `context` makes the first snapshot once the grant is in hand;
    /// `tool` answers the hosted agent's tools.
    public func start(language: String?, context: @escaping @MainActor () async -> String,
                      tool: @escaping @Sendable (CallToolCall) async -> CallToolResult) {
        guard startTask == nil, connection == nil, !state.isLive else { return }
        generation += 1
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
                    self.activity = activity
                    self.onLevel?(CallLevel.level(activity: activity, vad: vad, muted: self.muted))
                    if self.connection != nil { self.state = .active(activity, muted: self.muted, since: self.since) }
                }, disconnected: { [weak self] in
                    guard let self, current == self.generation else { return }
                    self.end(.connection)
                }, tool: tool)
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
                state = .active(activity, muted: false, since: since)
                count(current)
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

    /// Hangs up, or closes the bar of a call that ended.
    public func stop() {
        tearDown()
        state = .idle
    }

    private func end(_ problem: CallProblem) {
        tearDown()
        state = .ended(problem)
    }

    /// Writes the call's time down every 10 seconds, so a call the app
    /// never saw end still counts, and ends it when the free time is gone.
    private func count(_ current: Int) {
        guard let allowance else { return }
        let call = (id: UUID().uuidString, start: since)
        counted = call
        counting = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, current == self.generation else { return }
                let now = self.now()
                allowance.record(call: call.id, from: call.start, to: now)
                let left = allowance.remaining(at: now)
                if left <= 0 { return self.end(.limitReached) }
                try? await Task.sleep(for: .seconds(min(10, left)))
            }
        }
    }

    private func tearDown() {
        generation += 1
        startTask?.cancel()
        startTask = nil
        counting?.cancel()
        counting = nil
        if let counted { allowance?.record(call: counted.id, from: counted.start, to: now()) }
        counted = nil
        let old = connection
        let oldLease = lease
        connection = nil
        lease = nil
        pendingContext.removeAll()
        activity = .listening
        muted = false
        changingMute = false
        onLevel?(0)
        Task { await old?.end(); oldLease?.finish() }
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
            end(.connection)
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

    private func flushContext() {
        guard let connection, !pendingContext.isEmpty else { return }
        let text = pendingContext.joined(separator: "\n")
        pendingContext.removeAll()
        let current = generation
        Task {
            do { try await connection.update(text) }
            catch { if current == generation { end(.connection) } }
        }
    }
}
