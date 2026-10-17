import Foundation

/// agentInputPrimaryAction.ts: what the composer's one round button does.
/// Send, stop and voice share it.
public enum AgentInputPrimaryAction: String, Equatable, Sendable {
    case send
    case stop
    /// The agent refuses steering while it works; pressing shakes the card.
    case blocked
    /// Starts or reopens the foreground voice conversation.
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

/// AgentInput.tsx's wide composer (`desktopActionControls`, a window wider
/// than 700 points): its send button is only send. Stop has its own button
/// beside the gear. The compact iPhone card owns the initial microphone;
/// an active call can also be reopened through the shared status row.
public struct AgentInputDesktopSend: Equatable, Sendable {
    public enum Fill: Equatable, Sendable {
        /// `sendButtonLocked`: surfaceHigh in a 1pt divider ring.
        case locked
        /// `sendButtonActive`: button.primary.background.
        case active
        /// `sendButtonInactive`: button.primary.disabled.
        case inactive
    }

    public enum Glyph: Equatable, Sendable {
        case spinner
        /// Ionicons `lock-closed` 15, textSecondary.
        case lock
        /// Octicons `arrow-up` 16, button.primary.tint.
        case arrow
    }

    public var fill: Fill
    public var glyph: Glyph
    /// `desktopCanPressSendButton`.
    public var isEnabled: Bool

    /// `hasText` is the text alone (it colours the button); content counts
    /// picked images too (it enables it).
    public init(hasText: Bool, hasComposerContent: Bool, isSendBlocked: Bool, isSending: Bool = false, isSendDisabled: Bool = false) {
        fill = isSendBlocked ? .locked : hasText || isSending ? .active : .inactive
        glyph = isSending ? .spinner : isSendBlocked ? .lock : .arrow
        isEnabled = !isSending && !isSendDisabled && hasComposerContent
    }
}
