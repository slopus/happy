import Foundation

public enum VoiceActivity: Equatable, Sendable { case listening, userSpeaking, agentSpeaking }

public enum VoiceState: Equatable, Sendable {
    case idle
    case connecting
    case active(activity: VoiceActivity, muted: Bool)
    case denied(VoiceDenial)
    case failed(VoiceFailure)
}

public enum VoiceFailure: Equatable, Sendable {
    case microphonePermission
    case authentication
    case unavailable
    case connection
}

public struct VoiceStart: Sendable {
    public var sessionId: String
    public var context: String
    public var language: String?
    public var customAgentId: String?
    public init(sessionId: String, context: String, language: String? = nil, customAgentId: String? = nil) {
        self.sessionId = sessionId
        self.context = context
        self.language = language
        self.customAgentId = customAgentId
    }
}

/// The SDK is confined to the UIKit target. Core controls cancellation and
/// entitlement boundaries and can test them without opening a microphone.
@MainActor
public protocol VoiceConnection: AnyObject {
    func end() async
    func setMuted(_ muted: Bool) async throws
    func context(_ text: String) async throws
    func prompt(_ text: String) async throws
}

@MainActor
public final class VoiceSession {
    public typealias Connect = @MainActor (VoiceGrant?, VoiceStart, @escaping @MainActor (VoiceActivity) -> Void, @escaping @MainActor () -> Void) async throws -> any VoiceConnection
    public private(set) var state: VoiceState = .idle { didSet { if state != oldValue { onState?(state) } } }
    public var onState: (@MainActor (VoiceState) -> Void)?
    private var connection: (any VoiceConnection)?
    private var generation = 0
    private var startTask: Task<Void, Never>?
    private var pendingPrompts: [String] = []
    private var activity: VoiceActivity = .listening
    private var muted = false
    private let permission: @MainActor () async -> Bool
    private let credentials: @Sendable () async throws -> VoiceCredentials
    private let connect: Connect

    public init(permission: @escaping @MainActor () async -> Bool,
                credentials: @escaping @Sendable () async throws -> VoiceCredentials,
                connect: @escaping Connect) {
        self.permission = permission
        self.credentials = credentials
        self.connect = connect
    }

    public func start(_ request: VoiceStart) {
        guard startTask == nil, connection == nil else { return }
        generation += 1
        let current = generation
        state = .connecting
        startTask = Task { [weak self] in
            guard let self else { return }
            defer { if current == generation { startTask = nil } }
            do {
                guard await permission() else {
                    if current == generation { state = .failed(.microphonePermission) }
                    return
                }
                try Task.checkCancellation()
                let grant: VoiceGrant?
                if request.customAgentId != nil {
                    // Explicit BYO public agent, as in happy-app. Never pretends
                    // that the Happy server granted a paid entitlement.
                    grant = nil
                } else {
                    switch try await credentials() {
                    case .allowed(let value): grant = value
                    case .denied(let denial):
                        if current == generation { state = .denied(denial) }
                        return
                    }
                }
                try Task.checkCancellation()
                guard current == generation else { return }
                let opened = try await connect(grant, request, { [weak self] activity in
                    guard let self, current == self.generation else { return }
                    self.activity = activity
                    if self.connection != nil { self.state = .active(activity: activity, muted: self.muted) }
                    if activity == .listening { self.flushPrompts() }
                }, { [weak self] in
                    guard let self, current == self.generation else { return }
                    self.stop()
                })
                guard !Task.isCancelled, current == generation else {
                    await opened.end()
                    return
                }
                connection = opened
                muted = false
                state = .active(activity: activity, muted: false)
                flushPrompts()
            } catch is CancellationError {
                if current == generation { state = .idle }
            } catch APIError.unauthorized {
                if current == generation { state = .failed(.authentication) }
            } catch APIError.unauthenticated {
                if current == generation { state = .failed(.authentication) }
            } catch {
                if current == generation { state = .failed(.unavailable) }
            }
        }
    }

    public func stop() {
        generation += 1
        startTask?.cancel()
        startTask = nil
        let old = connection
        connection = nil
        pendingPrompts.removeAll()
        activity = .listening
        muted = false
        state = .idle
        Task { await old?.end() }
    }

    public func toggleMute() async {
        guard let connection else { return }
        let current = generation
        do {
            try await connection.setMuted(!muted)
            guard current == generation else { return }
            muted.toggle()
            state = .active(activity: activity, muted: muted)
        } catch {
            guard current == generation else { return }
            stop()
            state = .failed(.connection)
        }
    }

    public func context(_ text: String, prompts: [String] = []) async {
        guard let connection else { return }
        let current = generation
        do {
            if !text.isEmpty { try await connection.context(text) }
            guard current == generation else { return }
            pendingPrompts += prompts
            flushPrompts()
        } catch {
            guard current == generation else { return }
            stop()
            state = .failed(.connection)
        }
    }

    private func flushPrompts() {
        guard activity == .listening, let connection, !pendingPrompts.isEmpty else { return }
        let text = pendingPrompts.joined(separator: "\n\n")
        pendingPrompts.removeAll()
        let current = generation
        Task {
            do { try await connection.prompt(text) }
            catch {
                guard current == generation else { return }
                stop()
                state = .failed(.connection)
            }
        }
    }
}