import Foundation
import HappyWire

// What the chat shows, after the reducer has folded a session's raw records
// together. A port of happy-app's `sync/typesMessage.ts`: one row per block,
// tool results joined to their calls, permissions joined to their tools.
//
// This file is the contract between the chat reducer (which produces it)
// and the chat UI (which only reads it). Change it in one place and tell the
// other side. `MessageMeta` is HappyWire's: it travels inside the record.

/// Who wrote a user message in a session with more than one participant.
public struct SessionAuthor: Equatable, Sendable {
    public var id: String
    public var name: String
    /// The account reading this, so its own messages render as its own.
    public var owner: Bool?

    public init(id: String, name: String, owner: Bool? = nil) {
        self.id = id
        self.name = name
        self.owner = owner
    }
}

/// An event from the agent that renders as a centered line, or settles a
/// pending message without rendering (`typesRaw.ts` `agentEventSchema`).
public enum AgentEvent: Equatable, Sendable {
    case modeSwitch(mode: String)
    case message(String)
    case limitReached(endsAt: Int64)
    case ready
    case userMessageAccepted(ref: String)
    case userMessageRejected(ref: String, reason: String)
}

public struct ToolPermission: Equatable, Sendable {
    public enum Status: String, Sendable {
        case pending
        case approved
        case denied
        case canceled
    }

    public enum Decision: String, Sendable {
        case approved
        case approvedForSession = "approved_for_session"
        case denied
        case abort
    }

    public var id: String
    public var status: Status
    public var reason: String?
    public var mode: String?
    public var allowedTools: [String]?
    public var decision: Decision?
    public var date: Int64?

    public init(id: String, status: Status, reason: String? = nil, mode: String? = nil, allowedTools: [String]? = nil, decision: Decision? = nil, date: Int64? = nil) {
        self.id = id
        self.status = status
        self.reason = reason
        self.mode = mode
        self.allowedTools = allowedTools
        self.decision = decision
        self.date = date
    }
}

public struct ToolCall: Equatable, Sendable {
    public enum State: String, Sendable {
        case running
        case completed
        case error
    }

    /// Provider tool-call id, for joining side-channel state.
    public var callId: String?
    public var name: String
    /// Human-readable title from the session protocol.
    public var title: String?
    public var state: State
    public var input: JSONValue
    public var createdAt: Int64
    public var startedAt: Int64?
    public var completedAt: Int64?
    public var description: String?
    public var result: JSONValue?
    public var permission: ToolPermission?

    public init(callId: String? = nil, name: String, title: String? = nil, state: State, input: JSONValue, createdAt: Int64, startedAt: Int64? = nil, completedAt: Int64? = nil, description: String? = nil, result: JSONValue? = nil, permission: ToolPermission? = nil) {
        self.callId = callId
        self.name = name
        self.title = title
        self.state = state
        self.input = input
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.description = description
        self.result = result
        self.permission = permission
    }
}

public struct UserTextMessage: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int64
    public var text: String
    /// Shown instead of `text` when set.
    public var displayText: String?
    public var meta: MessageMeta?
    /// Sent, not yet taken into the agent's context; pinned to the bottom.
    public var pending: Bool
    /// The daemon refused it; it never started a turn.
    public var sendError: String?
    /// Position in the chat when it differs from `createdAt`.
    public var sortAt: Int64?
    public var author: SessionAuthor?
    public var claudeUuid: String?
    public var codexItemId: String?

    public init(id: String, localId: String? = nil, createdAt: Int64, text: String, displayText: String? = nil, meta: MessageMeta? = nil, pending: Bool = false, sendError: String? = nil, sortAt: Int64? = nil, author: SessionAuthor? = nil, claudeUuid: String? = nil, codexItemId: String? = nil) {
        self.id = id
        self.localId = localId
        self.createdAt = createdAt
        self.text = text
        self.displayText = displayText
        self.meta = meta
        self.pending = pending
        self.sendError = sendError
        self.sortAt = sortAt
        self.author = author
        self.claudeUuid = claudeUuid
        self.codexItemId = codexItemId
    }
}

public struct AgentTextMessage: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int64
    public var turn: String?
    public var text: String
    public var isThinking: Bool
    public var meta: MessageMeta?

    public init(id: String, localId: String? = nil, createdAt: Int64, turn: String? = nil, text: String, isThinking: Bool = false, meta: MessageMeta? = nil) {
        self.id = id
        self.localId = localId
        self.createdAt = createdAt
        self.turn = turn
        self.text = text
        self.isThinking = isThinking
        self.meta = meta
    }
}

public struct ToolCallMessage: Equatable, Sendable {
    public var id: String
    public var localId: String?
    public var createdAt: Int64
    public var turn: String?
    public var tool: ToolCall
    /// Sidechain messages (a sub-agent's work) nested under the call.
    public var children: [ChatMessage]
    public var meta: MessageMeta?

    public init(id: String, localId: String? = nil, createdAt: Int64, turn: String? = nil, tool: ToolCall, children: [ChatMessage] = [], meta: MessageMeta? = nil) {
        self.id = id
        self.localId = localId
        self.createdAt = createdAt
        self.turn = turn
        self.tool = tool
        self.children = children
        self.meta = meta
    }
}

public struct AgentEventMessage: Equatable, Sendable {
    public var id: String
    public var createdAt: Int64
    public var turn: String?
    public var event: AgentEvent
    public var meta: MessageMeta?

    public init(id: String, createdAt: Int64, turn: String? = nil, event: AgentEvent, meta: MessageMeta? = nil) {
        self.id = id
        self.createdAt = createdAt
        self.turn = turn
        self.event = event
        self.meta = meta
    }
}

/// A stored record in a format the current CLI no longer writes (or never
/// wrote). Shown as a compact placeholder, never dropped silently.
public struct UnsupportedMessage: Equatable, Sendable {
    public var id: String
    public var createdAt: Int64
    /// What kind of record it was, for the placeholder and for bug reports.
    public var kind: String

    public init(id: String, createdAt: Int64, kind: String) {
        self.id = id
        self.createdAt = createdAt
        self.kind = kind
    }
}

public enum ChatMessage: Equatable, Sendable {
    case userText(UserTextMessage)
    case agentText(AgentTextMessage)
    case toolCall(ToolCallMessage)
    case agentEvent(AgentEventMessage)
    case unsupported(UnsupportedMessage)

    public var id: String {
        switch self {
        case .userText(let message): message.id
        case .agentText(let message): message.id
        case .toolCall(let message): message.id
        case .agentEvent(let message): message.id
        case .unsupported(let message): message.id
        }
    }

    public var createdAt: Int64 {
        switch self {
        case .userText(let message): message.createdAt
        case .agentText(let message): message.createdAt
        case .toolCall(let message): message.createdAt
        case .agentEvent(let message): message.createdAt
        case .unsupported(let message): message.createdAt
        }
    }

    /// Where the message sits: its settled position, or when it was made
    /// (`messageSortKey`).
    public var sortKey: Int64 {
        if case .userText(let message) = self, let sortAt = message.sortAt { return sortAt }
        return createdAt
    }

    /// Added to a pending message's timestamp to park it below every real
    /// one (`PENDING_SORT_OFFSET`).
    public static let pendingSortOffset: Int64 = 8_000_000_000_000_000
}
