import Foundation
import HappyCore
import HappyWire

// What the core posts (`Happenings`), as the catalog's events. The core
// never imports this target: it posts, and only this listens.

extension Analytics {
    func receive(_ happening: Happening) {
        switch happening {
        case .errorShown(let place, let problem):
            let area: AnalyticsEvent.ErrorArea = switch place {
            case .conversationLoad: .conversationLoad
            case .messageSend: .messageSend
            case .attachmentUpload: .attachmentUpload
            }
            errorShown(area, .init(problem))
        case .relayMessageQueued(let source, let attachments):
            log(.messageSent(.init(source: .init(source), target: .session, sessionClient: .cli, hasAttachment: attachments > 0)))
        case .newWorkMade(let kind, let agentId, let outcome):
            let (result, code) = Self.created(outcome)
            log(kind == .bot ? .botCreated(source: .home, result: result, errorCode: code) : .taskCreated(result: result, errorCode: code))
            // The conversation exists only now; a failure keeps it for the retry.
            if result == .ok, let opened = opening.removeValue(forKey: agentId) { log(opened) }
        case .sessionStartEnded(let start, let outcome):
            for event in Self.started(start, outcome) { log(event) }
        case .agentConnectionChanged(let id, let direct, let down, let problem):
            ConnectionWatch.shared.report(.agent(id: id, direct: direct, down: down, problem: problem))
        case .callChanged(let old, let new, let at):
            if let event = new.event(from: old, at: at) { log(event) }
        }
    }

    static func created(_ outcome: Happening.Outcome) -> (AnalyticsEvent.CreateResult, AnalyticsEvent.CreateErrorCode?) {
        switch outcome {
        case .made: (.ok, nil)
        case .refused: (.failed, .refused)
        case .failed(let problem): (.failed, .init(problem))
        }
    }

    /// A composer's start: a bot or a task by what it made, and, once it
    /// starts, the new conversation it opens.
    static func started(_ start: Happening.Start, _ outcome: Happening.Outcome) -> [AnalyticsEvent] {
        let (result, code) = created(outcome)
        var events: [AnalyticsEvent] = []
        switch start.made {
        case .bot: events.append(.botCreated(source: .home, result: result, errorCode: code))
        case .task: events.append(.taskCreated(result: result, errorCode: code))
        case .session: break
        }
        guard result == .ok else { return events }
        let provider: AnalyticsEvent.ProviderKind? = switch start.agent {
        case .claude: .claude
        case .codex: .codex
        case .gemini: .gemini
        case .openclaw, .agy: .other
        // Happy Agent's provider is its catalog's, which the start doesn't carry.
        case .rig: nil
        }
        events.append(.conversationCreated(source: .home, modelFamily: start.model.map(AnalyticsEvent.ModelFamily.init(model:)),
                                           modelProviderKind: provider, effort: start.effort.flatMap(AnalyticsEvent.Effort.init(rawValue:))))
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
    /// An agent's connection, as the core said it. A revoked phone is
    /// `revoked`; behind a server, its sign-in has run out.
    static func agent(id: String, direct: Bool, down: Bool, problem: Problem?) -> Self {
        var code = AnalyticsEvent.ConnectionCode.unknown
        if down, let problem {
            code = problem == .revoked ? (direct ? .revoked : .authExpired) : .init(problem)
        }
        return .init(id: "agent:\(id)", transport: direct ? .direct : .remote, down: down, code: code)
    }
}
