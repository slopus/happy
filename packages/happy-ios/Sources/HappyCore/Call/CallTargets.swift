import Foundation

/// One conversation a call can talk about: a bot, a task or another
/// conversation of the account the call is bound to. Only bots and tasks
/// are listed (`isTopLevel`); any other conversation, a subtask included,
/// is the call's only once the person opens it themselves.
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
    /// It has a name of its own: not none, and not the one the computer
    /// gives new work until its first message names it ("New Task", "New
    /// Bot"). A bot or task without one isn't listed until it has one. A
    /// name the person chose that is exactly one of those reads the same.
    public var named: Bool

    public init(agentId: String, title: String, kind: Kind, project: String? = nil, status: Status, named: Bool = true) {
        self.agentId = agentId
        self.title = title
        self.kind = kind
        self.project = project
        self.status = status
        self.named = named
    }

    /// A bot or a task, as the account owns them; never a subtask or a
    /// project's conversation.
    public var isTopLevel: Bool { kind == .bot || kind == .task }

    /// What the call lists: a bot or a task with a name.
    public var isListed: Bool { isTopLevel && named }

    /// The names the computer gives a task or a bot made without one
    /// (`AgentClient.createTask`, `createBot`), until its first message names it.
    public static let unnamed: Set<String> = ["New Task", "New Bot"]

    /// A sidebar row's conversation; nil for rows that open none. A row is
    /// a bot or a task by what it is the conversation of (`targetKind`, the
    /// bot or task that owns it), never by where it sits.
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
        // A bot's or task's own name, never the row's stand-in for none.
        let name = row.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let named = !name.isEmpty && !unnamed.contains(name)
        return CallTarget(agentId: agentId, title: kind == .conversation || !named ? row.label : name, kind: kind, status: status, named: named)
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
    /// The agent has gone on past it (a tool call, more words after one, a
    /// turn's end) or its run is over: what it says is complete. False for
    /// the agent's last words while it still works.
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

/// One finished turn of a conversation: the person's message that started
/// it and the agent's final answer, as desktop's turn summary copies it
/// (`ChatItem.TurnEnd.copyText`), never its commentary or tool output.
public struct CallTurn: Equatable, Sendable {
    public var id: String
    public var user: String?
    public var reply: String?
    /// `completed`, `error`, `abort`, `steering` or `compaction`.
    public var ended: String
    /// Why it stopped, for one that ended in an error.
    public var error: String?

    public init(id: String, user: String? = nil, reply: String? = nil, ended: String = "completed", error: String? = nil) {
        self.id = id
        self.user = user
        self.reply = reply
        self.ended = ended
        self.error = error
    }
}

/// What the call knows of one conversation: its finished turns, the
/// person's message still waiting for an answer, the agent's words as they
/// come, and whether it is working, waits for the person and can take a
/// message. Never its tools, reasoning, files, questions' contents or
/// drafts.
public struct CallTargetState: Equatable, Sendable {
    public var target: CallTarget
    /// Every public message, the agent's still being written included
    /// (`final` false). The agent's are its words between steps, one
    /// message each.
    public var messages: [CallMessage]
    public var turns: [CallTurn]
    /// The person's latest message, when no finished turn answers it.
    public var unanswered: CallMessage?
    public var working: Bool
    public var needsInput: Bool
    /// It has been read and takes messages.
    public var writable: Bool
    /// The person has typed something there (never what).
    public var hasDraft: Bool
    public var hasMore: Bool

    public init(target: CallTarget, messages: [CallMessage] = [], turns: [CallTurn] = [], unanswered: CallMessage? = nil,
                working: Bool = false, needsInput: Bool = false, writable: Bool = true, hasDraft: Bool = false, hasMore: Bool = false) {
        self.target = target
        self.messages = messages
        self.turns = turns
        self.unanswered = unanswered
        self.working = working
        self.needsInput = needsInput
        self.writable = writable
        self.hasDraft = hasDraft
        self.hasMore = hasMore
    }

    /// A conversation's snapshot, as the call reads it. Turns are the
    /// conversation's own runs (`ChatItem.turn`): one is finished once it
    /// has its turn end, whose answer is its reply; the person's message in
    /// it is the one that started it.
    public static func from(_ snapshot: ChatSnapshot, target: CallTarget) -> CallTargetState {
        var messages: [CallMessage] = []
        var turns: [CallTurn] = []
        var users: [String: String] = [:]
        var failures: [String: String] = [:]
        var lastUser: CallMessage?
        var lastUserTurn: String?
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
                let message = CallMessage(id: item.id, role: .user, text: text, time: item.time, delivery: delivery)
                messages.append(message)
                if let turn = item.turn, users[turn] == nil { users[turn] = text }
                lastUser = message
                lastUserTurn = item.turn
            case .agent:
                let text = item.text
                guard !text.isEmpty else { continue }
                messages.append(CallMessage(id: item.id, role: .assistant, text: text, time: item.time))
            case .failure(let failure):
                if let turn = item.turn { failures[turn] = failure.reason }
            case .turnEnd(let end):
                guard let turn = item.turn else { continue }
                turns.append(CallTurn(id: turn, user: users[turn], reply: end.copyText, ended: end.reason,
                                      error: end.reason == "error" ? failures[turn] : nil))
            case .question(let ask):
                if ask.phase != .answered { needsInput = true }
            default:
                continue
            }
        }
        // The agent's words are complete once it went on past them; while it
        // works, its last words may still grow. The person's messages, or
        // another agent's, coming in after them say nothing of that.
        if snapshot.working, let step = snapshot.items.last(where: Self.isStep), step.role == .agent,
           let index = messages.lastIndex(where: { $0.role == .assistant && $0.id == step.id }) {
            messages[index].final = false
        }
        let finished = Set(turns.map(\.id))
        let unanswered = lastUser.flatMap { message in lastUserTurn.map(finished.contains) == true ? nil : message }
        if case .awaitingAnswer? = snapshot.activity?.phase { needsInput = true }
        var target = target
        if needsInput { target.status = .needsInput }
        else if snapshot.working { target.status = .running }
        return CallTargetState(
            target: target, messages: messages, turns: turns, unanswered: unanswered, working: snapshot.working,
            needsInput: needsInput, writable: snapshot.loaded && snapshot.error == nil, hasDraft: !snapshot.draft.isEmpty,
            hasMore: snapshot.hasMore
        )
    }
}

extension CallTargetState {
    /// What the agent itself does in a turn: its words, a tool call, the
    /// turn's end or failure.
    static func isStep(_ item: ChatItem) -> Bool {
        switch item.role {
        case .agent, .tool, .turnEnd, .failure: true
        default: false
        }
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


/// Where a conversation the call opens goes on the stack it is opened
/// over: in place of a conversation on top, so a call that goes from one to
/// the next never piles them up behind each other; pushed over anything
/// else (home, Settings, a profile), which stays under it. Nothing at all
/// when it is already on top.
public enum CallNavigation {
    public static func opening<Screen>(_ conversation: Screen, over stack: [Screen], isConversation: (Screen) -> Bool) -> [Screen] {
        guard let top = stack.last, isConversation(top) else { return stack + [conversation] }
        return stack.dropLast() + [conversation]
    }
}
