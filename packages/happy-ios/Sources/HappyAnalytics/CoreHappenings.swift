import Foundation
import HappyCore
import HappyWire

// What the core posts (`Happenings`), as the catalog's events. The core
// never imports this target: it posts, and only this listens.

extension Analytics {
    func receive(_ happening: Happening) {
        switch happening {
        case .errorShown(let place, let error):
            let area: AnalyticsEvent.ErrorArea = switch place {
            case .conversationLoad: .conversationLoad
            case .messageSend: .messageSend
            case .attachmentUpload: .attachmentUpload
            }
            // A cancellation nobody saw as an error has no code.
            let code: AnalyticsEvent.ErrorCode? = if let error { .init(error) } else { .unknown }
            if let code { errorShown(area, code) }
        case .relayMessageQueued(let source, let attachments):
            log(.messageSent(.init(source: .init(source), target: .session, sessionClient: .cli, hasAttachment: attachments > 0)))
        case .newWorkMade(let kind, let agentId, let outcome):
            let (result, code) = Self.created(outcome)
            log(kind == .bot ? .botCreated(source: .home, result: result, errorCode: code) : .taskCreated(result: result, errorCode: code))
            // The conversation exists only now; a failure keeps it for the retry.
            if result == .ok, let opened = opening.removeValue(forKey: agentId) { log(opened) }
        case .sessionStartEnded(let launch, let outcome):
            for event in Self.started(launch, outcome) { log(event) }
        case .agentConnectionChanged(let account, let problem):
            ConnectionWatch.shared.report(.init(account, problem: problem))
        case .callChanged(let old, let new, let at):
            if let event = new.event(from: old, at: at) { log(event) }
        }
    }

    static func created(_ outcome: Happening.Outcome) -> (AnalyticsEvent.CreateResult, AnalyticsEvent.CreateErrorCode?) {
        switch outcome {
        case .made: (.ok, nil)
        case .refused: (.failed, .refused)
        case .failed(let error): (.failed, AnalyticsEvent.createErrorCode(error))
        }
    }

    /// A composer's start: a bot or a task by what it made, and, once it
    /// starts, the new conversation it opens.
    static func started(_ launch: NewSessionLaunch, _ outcome: Happening.Outcome) -> [AnalyticsEvent] {
        let (result, code) = created(outcome)
        var events: [AnalyticsEvent] = []
        switch launch.target {
        case .bot?: events.append(.botCreated(source: .home, result: result, errorCode: code))
        case .task?: events.append(.taskCreated(result: result, errorCode: code))
        default: if launch.bot != nil { events.append(.botCreated(source: .home, result: result, errorCode: code)) }
        }
        guard result == .ok else { return events }
        let provider: AnalyticsEvent.ProviderKind? = switch launch.agent {
        case .claude: .claude
        case .codex: .codex
        case .gemini: .gemini
        case .openclaw, .agy: .other
        // Happy Agent's provider is its catalog's, which the launch doesn't carry.
        case .rig: nil
        }
        events.append(.conversationCreated(source: .home, modelFamily: launch.modelMode == "default" ? nil : .init(model: launch.modelMode),
                                           modelProviderKind: provider, effort: launch.effortLevel.flatMap(AnalyticsEvent.Effort.init(rawValue:))))
        return events
    }
}

extension AnalyticsEvent.MessageSource {
    init(_ source: OutgoingMessage.Source) {
        self = switch source {
        case .chat: .chat
        case .voice: .voice
        case .newSession: .newSession
        }
    }
}

extension ConnectionIncidents.Link {
    /// An agent's connection: down while it retries or is revoked, up once
    /// connected or paused.
    init(_ account: AgentConnection, problem: (any Error)?) {
        let down = account.status == .retrying || account.status == .revoked
        var code = AnalyticsEvent.ConnectionCode.unknown
        if down, let problem {
            // A revoked phone; behind a server, its sign-in has run out.
            if case PairingError.revoked = problem { code = account.server == nil ? .revoked : .authExpired }
            else { code = .init(problem) }
        }
        self.init(id: "agent:\(account.id)", transport: account.server == nil ? .direct : .remote, down: down, code: code)
    }
}
