import Foundation

/// agentInputPrimaryAction.ts: what the composer's one round button does.
/// Send, stop and (in happy-app) voice share it.
public enum AgentInputPrimaryAction: String, Equatable, Sendable {
    case send
    case stop
    /// The agent refuses steering while it works; pressing shakes the card.
    case blocked
    /// Voice is not ported (FEATURES.md exclusions); kept so the resolver
    /// stays the port of happy-app's.
    case voice
    case idle

    /// `resolveAgentInputPrimaryAction`.
    ///
    /// A blank composer while the agent works is the one case where the
    /// button is Stop; once there is a follow-up, sending wins so the next
    /// message can be queued without aborting the turn. A blocked send never
    /// hides Stop: an agent that refuses steering has no other way to stop.
    public static func resolve(
        hasComposerContent: Bool,
        isSendBlocked: Bool,
        isSendDisabled: Bool,
        showAbortButton: Bool,
        canAbort: Bool,
        canVoice: Bool = false
    ) -> AgentInputPrimaryAction {
        if showAbortButton && canAbort && !hasComposerContent {
            return .stop
        }
        if isSendBlocked && hasComposerContent {
            return .blocked
        }
        if !isSendDisabled && hasComposerContent {
            return .send
        }
        if !isSendDisabled && canVoice {
            return .voice
        }
        return .idle
    }
}
