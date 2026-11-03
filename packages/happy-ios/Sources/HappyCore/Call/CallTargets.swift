import Foundation

/// One conversation a call can talk about: a bot, a task or another
/// conversation of the account the call is bound to.
public struct CallTarget: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable, Encodable {
        case bot, task, conversation
    }

    public enum Status: String, Equatable, Sendable, Encodable {
        case running
        case waiting
        /// A question or a review waits for the person, in the app.
        case needsInput = "needs_input"
        case idle
        case unknown
    }

    public var agentId: String
    public var title: String
    public var kind: Kind
    public var project: String?
    public var status: Status

    public init(agentId: String, title: String, kind: Kind, project: String? = nil, status: Status) {
        self.agentId = agentId
        self.title = title
        self.kind = kind
        self.project = project
        self.status = status
    }

    /// A sidebar row's conversation; nil for rows that open none.
    public static func from(_ row: Row) -> CallTarget? {
        guard row.kind == .space || row.kind == .session, let agentId = row.agentId, row.targetKind != "surface" else { return nil }
        let kind: Kind = switch row.targetKind {
        case "bot": .bot
        case "task": .task
        default: .conversation
        }
        let status: Status = switch row.status {
        case .working: .running
        case .waiting: .waiting
        case .awaitingInput: .needsInput
        case .none: .idle
        }
        return CallTarget(agentId: agentId, title: row.label, kind: kind, status: status)
    }
}

/// One public message of a conversation, as the call may read it.
public struct CallMessage: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable, Encodable { case user, assistant }
    public enum Delivery: String, Equatable, Sendable, Encodable {
        /// On this phone, not yet taken by the computer.
        case queued
        case accepted
        case failed
    }

    public var id: String
    public var role: Role
    public var text: String
    public var time: Double?
    /// False while the agent is still writing it.
    public var final: Bool
    public var delivery: Delivery?

    public init(id: String, role: Role, text: String, time: Double? = nil, final: Bool = true, delivery: Delivery? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.time = time
        self.final = final
        self.delivery = delivery
    }
}

/// What the call knows of one conversation: its public words and whether
/// it is working, waits for the person, and can take a message. Never its
/// tools, reasoning, files, questions' contents or drafts.
public struct CallTargetState: Equatable, Sendable {
    public var target: CallTarget
    public var messages: [CallMessage]
    public var working: Bool
    public var needsInput: Bool
    /// It has been read and takes messages.
    public var writable: Bool
    /// The person has typed something there (never what).
    public var hasDraft: Bool
    public var hasMore: Bool

    public init(target: CallTarget, messages: [CallMessage] = [], working: Bool = false, needsInput: Bool = false,
                writable: Bool = true, hasDraft: Bool = false, hasMore: Bool = false) {
        self.target = target
        self.messages = messages
        self.working = working
        self.needsInput = needsInput
        self.writable = writable
        self.hasDraft = hasDraft
        self.hasMore = hasMore
    }

    /// A conversation's snapshot, as the call reads it: the person's and
    /// the agent's words only; the agent's last words while it works are
    /// not final.
    public static func from(_ snapshot: ChatSnapshot, target: CallTarget) -> CallTargetState {
        var messages: [CallMessage] = []
        var needsInput = false
        for item in snapshot.items {
            switch item.role {
            case .user:
                let text = item.text
                guard !text.isEmpty else { continue }
                let delivery: CallMessage.Delivery = switch item.delivery {
                case .sending: .queued
                case .pending, .sent: .accepted
                case .failed: .failed
                }
                messages.append(CallMessage(id: item.id, role: .user, text: text, time: item.time, delivery: delivery))
            case .agent:
                let text = item.text
                guard !text.isEmpty else { continue }
                messages.append(CallMessage(id: item.id, role: .assistant, text: text, time: item.time))
            case .question(let ask):
                if ask.phase != .answered { needsInput = true }
            default:
                continue
            }
        }
        if snapshot.working, let last = messages.indices.last, messages[last].role == .assistant {
            messages[last].final = false
        }
        if case .awaitingAnswer? = snapshot.activity?.phase { needsInput = true }
        var target = target
        if needsInput { target.status = .needsInput }
        else if snapshot.working { target.status = .running }
        return CallTargetState(
            target: target, messages: messages, working: snapshot.working, needsInput: needsInput,
            writable: snapshot.loaded && snapshot.error == nil, hasDraft: !snapshot.draft.isEmpty, hasMore: snapshot.hasMore
        )
    }
}

public enum CallSendOutcome: Equatable, Sendable {
    /// Kept on this phone and on its way; the computer's answer comes later
    /// as a delivery update.
    case queued
    case refused(String)
}

/// The account a call is bound to, as the call's tools reach it. The UI
/// implements it over the connection's sidebar and conversations; nothing
/// here can name another account, an endpoint or a credential.
public protocol CallTargets: Sendable {
    /// Every conversation the sidebar lists, in its order.
    func directory() async -> [CallTarget]
    /// One conversation, read if it must be (a bounded page); nil if the
    /// account has none by that ID.
    func state(of agentId: String) async -> CallTargetState?
    /// The conversation on screen, if one is.
    func focused() async -> String?
    /// Opens it on screen; true once it shows.
    func open(_ agentId: String) async -> Bool
    /// Sends `text` exactly as given, under `id`, the way the composer's
    /// send does but without touching its draft or attachments.
    func send(_ agentId: String, text: String, id: String) async -> CallSendOutcome
    /// Keeps a conversation read (or lets it go) while the call follows it.
    func follow(_ agentId: String, _ following: Bool) async
}
