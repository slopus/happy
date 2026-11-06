import Foundation
import HappyCore
import HappyWire

// The conversation screen's events, made here from the app's own types so
// each call site is one line.

extension Analytics {
    /// `message_sent` for a send to a Happy Agent conversation, made from
    /// what the screen knows before the send changes it. Call the result
    /// once the send is accepted. `newWork`: the conversation new work's
    /// first message makes (`NewTask.agentId`), whose `conversation_created`
    /// goes only once the computer has made it. `steering`: the agent was
    /// still working.
    public func agentSend(to agentId: String, in spaces: Snapshot, mode: AgentWire.Mode?, catalog: ModelCatalog?,
                          newWork: String?, attachments: Int, steering: Bool) -> @MainActor () -> Void {
        let target = AnalyticsEvent.ChatTarget(agentId, in: spaces)
        let provider = mode.flatMap { catalog?.provider($0.providerId)?.type }
        let event = AnalyticsEvent.MessageSent(
            source: newWork != nil ? .newSession : .chat, target: target, sessionClient: .happyAgent, modelFamily: mode.map { .init(model: $0.modelId) },
            modelProviderKind: mode == nil ? nil : .init(type: provider), effort: mode.flatMap { .init(rawValue: $0.effort) },
            botSystemKey: target == .chiefOfStaff ? .chiefOfStaff : nil, hasAttachment: attachments > 0, isSteering: steering)
        if let newWork {
            // Kept before the send starts, so the made task can't come first.
            if opening.count >= Self.openingLimit { opening.removeAll() }
            opening[newWork] = .conversationCreated(source: .home, modelFamily: event.modelFamily, modelProviderKind: event.modelProviderKind, effort: event.effort)
        }
        return { [weak self] in self?.log(.messageSent(event)) }
    }

    /// `message_sent` for what a call said into a conversation over the
    /// agent connection, once it is kept.
    public func voiceSent(to agentId: String, in spaces: Snapshot) {
        log(.messageSent(.voice(to: agentId, in: spaces)))
    }

    /// `chat_failure_shown` for a failure card on screen in the conversation
    /// the person is looking at. The engine keeps the five-minute rule and
    /// the dedupe across screens and launches.
    public func failureCardShown(_ failure: Failure, agentId: String, in spaces: Snapshot) {
        let event = AnalyticsEvent.chatFailureShown(
            kind: .init(wire: failure.kind), providerKind: failure.pool ? nil : failure.providerType.map(AnalyticsEvent.ProviderKind.init(type:)),
            isPool: failure.pool, target: .init(agentId, in: spaces), sessionClient: .happyAgent)
        failureShown(messageID: failure.messageId, createdAt: Date(timeIntervalSince1970: failure.createdAt / 1000), event)
    }

    /// `chat_failure_action_clicked`: run again as it was, or on another model.
    public func failureActionClicked(_ failure: Failure, switchingModel: Bool) {
        log(.chatFailureActionClicked(kind: .init(wire: failure.kind), action: switchingModel ? .switchModel : .retry))
    }
}
