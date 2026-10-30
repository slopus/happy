import Foundation
import HappyWire

/// The Happy Agent API shapes V2 reads (happy-agent `API.md`:
/// Spaces, Agents, Messages and runs, Message content, Presentation).
/// Only the fields the screens use are decoded; unknown fields are ignored
/// and unknown kinds decode to `.unknown`, as the API asks of clients.
public enum AgentWire {}

extension AgentWire {
    public enum SpaceIcon: Equatable, Sendable, Codable {
        case seedling
        case library(String)
        /// A daemon-relative path read with the same bearer token.
        case image(String)
        case unknown

        enum CodingKeys: String, CodingKey { case type, slug, url }
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .type) {
            case "stem_cell": self = .seedling
            case "library": self = .library(try container.decode(String.self, forKey: .slug))
            case "image": self = .image(try container.decode(String.self, forKey: .url))
            default: self = .unknown
            }
        }
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .seedling: try container.encode("stem_cell", forKey: .type)
            case .library(let slug): try container.encode("library", forKey: .type); try container.encode(slug, forKey: .slug)
            case .image(let url): try container.encode("image", forKey: .type); try container.encode(url, forKey: .url)
            case .unknown: try container.encode("unknown", forKey: .type)
            }
        }
    }

    public struct SpaceTarget: Equatable, Sendable, Codable {
        public var kind: String
        public var id: String
        public var agentId: String?
        public var workspaceId: String?
        public init(kind: String, id: String, agentId: String?, workspaceId: String?) {
            self.kind = kind
            self.id = id
            self.agentId = agentId
            self.workspaceId = workspaceId
        }
    }

    public struct Space: Equatable, Sendable, Codable, Identifiable {
        public var id: String
        public var title: String?
        public var icon: SpaceIcon?
        public var target: SpaceTarget
        public var sectionId: String?
        public var orderKey: String
        public var placement: String
        public var visibility: String
        public var working: Bool
        public var version: Int
        public var createdAt: Double
        public var updatedAt: Double

        public init(id: String, title: String?, icon: SpaceIcon?, target: SpaceTarget, sectionId: String? = nil, orderKey: String = "", placement: String = "pending", visibility: String = "shown", working: Bool = false, version: Int, createdAt: Double, updatedAt: Double) {
            self.id = id
            self.title = title
            self.icon = icon
            self.target = target
            self.sectionId = sectionId
            self.orderKey = orderKey
            self.placement = placement
            self.visibility = visibility
            self.working = working
            self.version = version
            self.createdAt = createdAt
            self.updatedAt = updatedAt
        }
    }

    public struct SidebarProposal: Equatable, Sendable, Codable {
        public var artifactId: String
        public var version: Int
        public var baseVersion: Int
        public var status: String
        public var createdAt: Double
        public var decidedAt: Double?
        public var acceptedVersion: Int?
    }

    /// `GET /v0/spaces/sidebar/proposals/:artifactId`: the proposal and its
    /// latest document, in the sidebar's grammar.
    public struct SidebarProposalResponse: Equatable, Sendable, Codable {
        public var proposal: SidebarProposal
        public var html: String
    }

    public struct LibraryIcon: Equatable, Sendable, Codable {
        public var slug: String
    }

    public struct SidebarResponse: Equatable, Sendable, Codable {
        public var artifactId: String
        public var version: Int
        public var html: String
        public var spaces: [Space]
        public var agentIcons: [String: LibraryIcon]?
        public var seed: Bool?
        public var proposal: SidebarProposal?
    }

    public struct OperationsResponse: Sendable {
        public var artifactId: String
        public var version: Int
        public var html: String
        public var operations: [SpaceSidebarOperation]
    }

    public struct Health: Equatable, Sendable, Codable {
        public struct Capabilities: Equatable, Sendable, Codable {
            public var identities: Bool?
            public var sidebarOperations: Bool?
            public var sidebarProposals: Bool?
            public var sidebarAttachments: Bool?
            public var stories: Bool?
            public var stickers: Bool?
            /// Agents' stories, their rings and status lines.
            public var agentStories: Bool?

            /// The daemon's names (API.md, Health); `stemCellIdentities` is
            /// the wire's, not ours.
            enum CodingKeys: String, CodingKey {
                case identities = "stemCellIdentities"
                case sidebarOperations, sidebarProposals, sidebarAttachments, stories, stickers, agentStories
            }
        }
        public var ready: Bool
        public var capabilities: Capabilities?
    }

    public struct AgentUnread: Equatable, Sendable, Codable {
        public var reason: String?
        public var since: Double?
    }

    public struct AgentWait: Equatable, Sendable, Codable {
        public var startedAt: Double
        public var dueAt: Double

        public init(startedAt: Double, dueAt: Double) {
            self.startedAt = startedAt
            self.dueAt = dueAt
        }
    }

    /// The automatic recovery inside the current run (protocol 30+).
    public struct AgentRetrying: Equatable, Sendable, Codable {
        public var attempt: Int
        public var maxAttempts: Int
        public var kind: String
        public var vendorName: String

        public init(attempt: Int, maxAttempts: Int, kind: String, vendorName: String) {
            self.attempt = attempt
            self.maxAttempts = maxAttempts
            self.kind = kind
            self.vendorName = vendorName
        }
    }

    /// The one line an agent last wrote about where its work stands (`set_status`).
    public struct AgentStatusLine: Equatable, Sendable, Codable {
        public var text: String
        public var updatedAt: Double

        public init(text: String, updatedAt: Double) {
            self.text = text
            self.updatedAt = updatedAt
        }
    }

    public struct AgentSubagents: Equatable, Sendable, Codable {
        public var total: Int?
        public var running: Int?
    }

    public final class Agent: Equatable, Sendable, Codable {
        public let id: String
        public let workspaceId: String
        public let parentAgentId: String?
        public let title: String?
        public let status: String
        public let wait: AgentWait?
        public let subtasks: [Agent]?
        public let pendingQuestionId: String?
        public let unread: AgentUnread?
        public let canSendMessages: Bool?
        public let archivedAt: Double?
        public let version: String?
        public let retrying: AgentRetrying?
        public let subagents: AgentSubagents?
        public let statusLine: AgentStatusLine?
        /// When the agent last did something the person would want to know
        /// about (current daemons); older ones send only `updatedAt`.
        public let lastActivityAt: Double?
        public let updatedAt: Double?

        public init(id: String, workspaceId: String, parentAgentId: String? = nil, title: String? = nil, status: String = "idle", wait: AgentWait? = nil, subtasks: [Agent]? = nil, pendingQuestionId: String? = nil, unread: AgentUnread? = nil, canSendMessages: Bool? = nil, archivedAt: Double? = nil, version: String? = nil, retrying: AgentRetrying? = nil, subagents: AgentSubagents? = nil, statusLine: AgentStatusLine? = nil, lastActivityAt: Double? = nil, updatedAt: Double? = nil) {
            self.id = id
            self.workspaceId = workspaceId
            self.parentAgentId = parentAgentId
            self.title = title
            self.status = status
            self.wait = wait
            self.subtasks = subtasks
            self.pendingQuestionId = pendingQuestionId
            self.unread = unread
            self.canSendMessages = canSendMessages
            self.archivedAt = archivedAt
            self.version = version
            self.retrying = retrying
            self.subagents = subagents
            self.statusLine = statusLine
            self.lastActivityAt = lastActivityAt
            self.updatedAt = updatedAt
        }

        public static func == (lhs: Agent, rhs: Agent) -> Bool {
            lhs.id == rhs.id && lhs.workspaceId == rhs.workspaceId && lhs.title == rhs.title && lhs.status == rhs.status
                && lhs.wait == rhs.wait && lhs.subtasks == rhs.subtasks && lhs.pendingQuestionId == rhs.pendingQuestionId
                && lhs.unread == rhs.unread && lhs.canSendMessages == rhs.canSendMessages && lhs.archivedAt == rhs.archivedAt
                && lhs.parentAgentId == rhs.parentAgentId && lhs.version == rhs.version
                && lhs.retrying == rhs.retrying && lhs.subagents == rhs.subagents && lhs.statusLine == rhs.statusLine
                && lhs.lastActivityAt == rhs.lastActivityAt && lhs.updatedAt == rhs.updatedAt
        }

        /// When its row's time counts from: the daemon's last activity, else
        /// the later of its last status and its last change (desktop's
        /// `conversationActivityAt`). Nil when none is known.
        public var activityAt: Double? {
            if let lastActivityAt { return lastActivityAt }
            let latest = max(statusLine?.updatedAt ?? 0, updatedAt ?? 0)
            return latest > 0 ? latest : nil
        }

        public var isWorking: Bool { status != "idle" }
    }

    public struct Avatar: Equatable, Sendable, Codable {
        public var thumbhash: String?
    }

    public struct Bot: Equatable, Sendable, Codable {
        public var id: String
        public var name: String
        public var systemKey: String?
        public var status: String?
        public var avatar: Avatar?
        public var version: String?
        public var agent: Agent?
    }

    public struct Task: Equatable, Sendable, Codable {
        public var id: String
        public var name: String?
        public var canArchive: Bool?
        public var version: String?
        public var agent: Agent?
        /// The person's own membership of it, as `tasks()` attaches it.
        public var membership: TaskMembership?
    }

    /// One person's membership of a task. `unread` is set when an agent
    /// looped them in, until they read the task's conversation.
    public struct TaskMembership: Equatable, Sendable, Codable {
        public var taskId: String
        public var unread: TaskUnread?

        public init(taskId: String, unread: TaskUnread? = nil) {
            self.taskId = taskId
            self.unread = unread
        }

        enum CodingKeys: String, CodingKey { case taskId, unread }

        /// A mark this build can't read is no mark, never a lost task.
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            taskId = (try? container.decode(String.self, forKey: .taskId)) ?? ""
            unread = (try? container.decodeIfPresent(TaskUnread.self, forKey: .unread)) ?? nil
        }
    }

    public struct TaskUnread: Equatable, Sendable, Codable {
        /// `looped_in` today.
        public var reason: String
        public var since: Double
        /// The task agent that looped them in, and the one sentence why.
        public var agentId: String?
        public var note: String?

        public init(reason: String, since: Double, agentId: String? = nil, note: String? = nil) {
            self.reason = reason
            self.since = since
            self.agentId = agentId
            self.note = note
        }
    }

    /// A Surface: a todo list, document, calendar, system monitor or chat.
    public struct Surface: Equatable, Sendable, Codable {
        public var id: String
        public var type: String
        public var name: String
        public var version: String?

        public init(id: String, type: String, name: String, version: String? = nil) {
            self.id = id
            self.type = type
            self.name = name
            self.version = version
        }
    }

    public struct Todo: Equatable, Sendable, Codable, Identifiable {
        public var id: String
        public var text: String
        /// `active`, `completed` or `deleted`.
        public var status: String
    }

    public struct CreateV2Response: Equatable, Sendable, Codable {
        public var space: Space
        public var agent: Agent
    }

    public struct Mode: Equatable, Sendable, Codable {
        public var providerId: String
        public var modelId: String
        public var effort: String
        public var serviceTier: String?
        public var permissionMode: String

        public init(providerId: String, modelId: String, effort: String, serviceTier: String?, permissionMode: String) {
            self.providerId = providerId
            self.modelId = modelId
            self.effort = effort
            self.serviceTier = serviceTier
            self.permissionMode = permissionMode
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(providerId, forKey: .providerId)
            try container.encode(modelId, forKey: .modelId)
            try container.encode(effort, forKey: .effort)
            // Required on the wire, `null` included.
            try container.encode(serviceTier, forKey: .serviceTier)
            try container.encode(permissionMode, forKey: .permissionMode)
        }
    }

    // MARK: Messages

    public struct MediaItem: Equatable, Sendable, Codable {
        public struct Source: Equatable, Sendable, Codable {
            public var path: String
            public var absolutePath: String
        }
        public var kind: String
        public var name: String
        public var mimeType: String
        public var size: Double?
        public var width: Double?
        public var height: Double?
        public var thumbhash: String?
        public var scale: Double?
        public var source: Source?
    }

    public struct Presentation: Equatable, Sendable, Codable {
        public var type: String
        public var items: [MediaItem]?
        /// `columns` or a `tree`, kept as sent; `MediaLayout` reads it.
        public var layout: JSONValue?
        public var artifactId: String?
        public var artifactType: String?
        public var title: String?
        /// An artifact presentation's version, and which it shows: `latest`
        /// follows the artifact; anything else is that version.
        public var version: Int?
        public var shows: String?
    }

    public enum Block: Equatable, Sendable, Codable {
        case text(String)
        case reasoning(String)
        case image(mimeType: String, data: String)
        /// A tool call, kept only for what it showed the person.
        case toolCall(id: String, name: String, status: String, presentation: Presentation?)
        case unknown(String)

        enum CodingKeys: String, CodingKey { case type, text, mimeType, data, id, name, status, presentation }
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let type = try container.decode(String.self, forKey: .type)
            switch type {
            case "text": self = .text(try container.decode(String.self, forKey: .text))
            case "reasoning": self = .reasoning(try container.decodeIfPresent(String.self, forKey: .text) ?? "")
            case "image":
                // History may leave a large picture's bytes out; it is then not shown.
                if let mimeType = try? container.decode(String.self, forKey: .mimeType), let data = try? container.decode(String.self, forKey: .data) {
                    self = .image(mimeType: mimeType, data: data)
                } else { self = .unknown(type) }
            case "tool_call":
                self = .toolCall(
                    id: try container.decode(String.self, forKey: .id), name: try container.decodeIfPresent(String.self, forKey: .name) ?? "",
                    status: try container.decodeIfPresent(String.self, forKey: .status) ?? "running",
                    presentation: try? container.decodeIfPresent(Presentation.self, forKey: .presentation)
                )
            default: self = .unknown(type)
            }
        }
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .text(let text): try container.encode("text", forKey: .type); try container.encode(text, forKey: .text)
            case .reasoning(let text): try container.encode("reasoning", forKey: .type); try container.encode(text, forKey: .text)
            case .image(let mimeType, let data):
                try container.encode("image", forKey: .type); try container.encode(mimeType, forKey: .mimeType); try container.encode(data, forKey: .data)
            case .toolCall(let id, let name, let status, let presentation):
                try container.encode("tool_call", forKey: .type); try container.encode(id, forKey: .id); try container.encode(name, forKey: .name)
                try container.encode(status, forKey: .status); try container.encodeIfPresent(presentation, forKey: .presentation)
            case .unknown(let type): try container.encode(type, forKey: .type)
            }
        }
    }

    public struct Message: Equatable, Sendable, Codable, Identifiable {
        public var id: String
        public var role: String
        public var createdAt: Double
        public var content: [Block]
        public var status: String?
        public var runId: String?
        public var metadata: MessageMetadata?
        /// An error service message's diagnostics (`error`) and typed
        /// failure (`failure`), kept as sent; `Failure` reads them.
        public var error: JSONValue?
        public var failure: JSONValue?

        public init(id: String, role: String, createdAt: Double, content: [Block], status: String? = nil, runId: String? = nil, metadata: MessageMetadata? = nil, error: JSONValue? = nil, failure: JSONValue? = nil) {
            self.id = id
            self.role = role
            self.createdAt = createdAt
            self.content = content
            self.status = status
            self.runId = runId
            self.metadata = metadata
            self.error = error
            self.failure = failure
        }
    }

    /// A message's public provenance (`metadata`): the agent that sent a
    /// message the daemon wrote on its behalf, and that agent's one line on
    /// what it is.
    public struct MessageMetadata: Equatable, Sendable, Codable {
        public var senderAgentId: String?
        public var senderAgentExplanation: String?

        public init(senderAgentId: String? = nil, senderAgentExplanation: String? = nil) {
            self.senderAgentId = senderAgentId
            self.senderAgentExplanation = senderAgentExplanation
        }
    }

    public struct Run: Equatable, Sendable, Codable {
        public var id: String
        public var status: String
        /// Unix milliseconds; the turn's clock counts from here.
        public var startedAt: Double?
        public var messages: [Message]?
    }

    public struct MessagesResponse: Equatable, Sendable, Codable {
        public var runs: [Run]
        public var hasMore: Bool
        public var cursor: String?
    }

    /// One version of an artifact (`GET /v0/artifacts/:id/versions/:number`).
    public struct ArtifactVersion: Equatable, Sendable, Codable {
        public struct File: Equatable, Sendable, Codable {
            public var path: String
            public var mimeType: String
            public var size: Double
        }

        public struct Live: Equatable, Sendable, Codable {
            public var url: String
        }

        public var artifactId: String
        public var number: Int
        public var title: String
        public var entry: File?
        public var files: [File]
        public var live: Live?
    }

    /// The composer's draft on the computer (`GET/PUT /v0/agents/:id/draft`):
    /// the text with the mode it goes with, and when it was last touched,
    /// kept even when cleared so an older device can't bring it back. On a
    /// team server it is the signed-in person's own.
    public struct Draft: Equatable, Sendable, Codable {
        public var value: DraftValue?
        public var updatedAt: Double?

        public init(value: DraftValue?, updatedAt: Double?) {
            self.value = value
            self.updatedAt = updatedAt
        }
    }

    public struct DraftValue: Equatable, Sendable, Codable {
        public var text: String
        public var providerId: String
        public var modelId: String
        public var effort: String
        public var serviceTier: String?
        public var permissionMode: String

        public init(text: String, mode: Mode) {
            self.text = text
            providerId = mode.providerId
            modelId = mode.modelId
            effort = mode.effort
            serviceTier = mode.serviceTier
            permissionMode = mode.permissionMode
        }

        public var mode: Mode { Mode(providerId: providerId, modelId: modelId, effort: effort, serviceTier: serviceTier, permissionMode: permissionMode) }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(text, forKey: .text)
            try container.encode(providerId, forKey: .providerId)
            try container.encode(modelId, forKey: .modelId)
            try container.encode(effort, forKey: .effort)
            // Required on the wire, `null` included.
            try container.encode(serviceTier, forKey: .serviceTier)
            try container.encode(permissionMode, forKey: .permissionMode)
        }
    }

    public struct Bootstrap: Equatable, Sendable, Codable {
        public var agent: Agent
        public var mode: Mode?
        /// This person's draft; absent from an older computer.
        public var draft: Draft?
        public var pending: [Message]?
        public var cursor: String?
        /// Every child the agent spawned, hidden collaborators included.
        public var subagents: [Agent]?
    }

    public struct Setting: Equatable, Sendable, Codable {
        public var key: String
        public var value: JSONValue?
    }
}

/// A CUID2-shaped ID the daemon accepts from a client (`^[a-z][a-z0-9]+$`,
/// at most 32 characters for a workspace).
public enum ClientID {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    public static func make() -> String {
        var generator = SystemRandomNumberGenerator()
        return String(alphabet[Int.random(in: 0..<26, using: &generator)]) + String((0..<23).map { _ in alphabet.randomElement(using: &generator)! })
    }
}
