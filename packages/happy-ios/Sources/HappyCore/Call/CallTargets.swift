import Foundation

/// One conversation a call can talk about, as the sidebar lists it: a bot,
/// a task, a subtask under any of them, or a project's conversation. The
/// call sees what the person sees, nothing more and nothing less.
public struct CallTarget: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable, Encodable {
        case bot, task, subtask
        /// A project's or a worktree's own conversation.
        case conversation
    }

    /// What a conversation sits under in the sidebar, outermost first: a
    /// project or a worktree heading, or the conversation a subtask is of.
    public struct Parent: Equatable, Sendable {
        /// The sidebar row's ID, unique among the rows.
        public var id: String
        public var title: String
        /// `project` or `workspace` for a heading, else the conversation's kind.
        public var kind: String
        /// The conversation's, for one; nil for a heading.
        public var agentId: String?

        public init(id: String, title: String, kind: String, agentId: String? = nil) {
            self.id = id
            self.title = title
            self.kind = kind
            self.agentId = agentId
        }
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
    /// The sidebar's label, whatever it is: "New Task" or "Untitled" too.
    public var title: String
    public var kind: Kind
    public var status: Status
    public var parents: [Parent]
    /// When the sidebar says it last did something (ms since 1970, to the
    /// minute), what it orders by; nil when it doesn't say.
    public var activityAt: Double?

    public init(agentId: String, title: String, kind: Kind, status: Status, parents: [Parent] = [], activityAt: Double? = nil) {
        self.agentId = agentId
        self.title = title
        self.kind = kind
        self.status = status
        self.parents = parents
        self.activityAt = activityAt
    }

    /// The project and worktree it runs in, outermost first: the headings
    /// it sits under. Empty for a bot or a task, which run in a workspace
    /// of their own. The computer tells the phone no folder paths.
    public var workspace: [String] {
        parents.filter { $0.agentId == nil }.map(\.title)
    }

    /// The labels the sidebar shows for work nobody has named yet: the
    /// computer's, until the first message names it (`AgentClient.createTask`,
    /// `createBot`), and the rows' own for none.
    public static let placeholders: Set<String> = ["", "New Task", "New Bot", "Untitled"]

    /// Longest a title goes into the call, in UTF-8.
    static let titleBytes = 200

    /// Every conversation the sidebar's rows open, in their order, once
    /// each (the first row wins), with what each sits under. Rows that
    /// open none (surfaces, artifacts, todos) are skipped; a project or a
    /// worktree is a heading.
    public static func list(_ rows: [Row]) -> [CallTarget] {
        var result: [CallTarget] = []
        var seen = Set<String>()
        var path: [(depth: Int, parent: Parent)] = []
        for row in rows {
            while let last = path.last, last.depth >= row.depth { path.removeLast() }
            if row.kind == .space, row.agentId == nil, let kind = row.targetKind, kind == "project" || kind == "workspace" {
                path.append((row.depth, Parent(id: row.id, title: clean(row.label), kind: kind)))
                continue
            }
            guard var target = from(row) else { continue }
            if target.kind == .conversation, path.last?.parent.agentId != nil { target.kind = .subtask }
            target.parents = path.map(\.parent)
            path.append((row.depth, Parent(id: row.id, title: target.title, kind: target.kind.rawValue, agentId: target.agentId)))
            if seen.insert(target.agentId).inserted { result.append(target) }
        }
        return result
    }

    /// A sidebar row's conversation, as it stands alone; nil for rows that
    /// open none. A row is a bot or a task by what it is the conversation
    /// of (`targetKind`), never by where it sits. `list` says what it is under.
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
        return CallTarget(agentId: agentId, title: clean(row.label), kind: kind, status: status, activityAt: row.activityTime)
    }

    /// A label on one line, without control characters, cut at `titleBytes`.
    public static func clean(_ label: String) -> String {
        // A line break, a tab or any other control character is a space.
        let plain = String(String.UnicodeScalarView(label.unicodeScalars.map { $0.properties.generalCategory == .control ? " " : $0 }))
        let line = plain.trimmingCharacters(in: .whitespaces)
        return CallContext.truncated(line, bytes: titleBytes)
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
    /// The agent's run it is of (`ChatItem.turn`), for the agent's words.
    public var turn: String?

    public init(id: String, role: Role, text: String, time: Double? = nil, final: Bool = true, delivery: Delivery? = nil, turn: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.time = time
        self.final = final
        self.delivery = delivery
        self.turn = turn
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
    /// When it ended, in ms; nil where that isn't known.
    public var endedAt: Double?

    public init(id: String, user: String? = nil, reply: String? = nil, ended: String = "completed", error: String? = nil, endedAt: Double? = nil) {
        self.id = id
        self.user = user
        self.reply = reply
        self.ended = ended
        self.error = error
        self.endedAt = endedAt
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
    /// The model and effort its next message goes with, if the computer's
    /// models are known.
    public var mode: CallMode?
    /// What it may switch to (`CallModel.options`); empty while the
    /// computer's models aren't known.
    public var models: [CallModel]

    public init(target: CallTarget, messages: [CallMessage] = [], turns: [CallTurn] = [], unanswered: CallMessage? = nil,
                working: Bool = false, needsInput: Bool = false, writable: Bool = true, hasDraft: Bool = false, hasMore: Bool = false,
                mode: CallMode? = nil, models: [CallModel] = []) {
        self.target = target
        self.messages = messages
        self.turns = turns
        self.unanswered = unanswered
        self.working = working
        self.needsInput = needsInput
        self.writable = writable
        self.hasDraft = hasDraft
        self.hasMore = hasMore
        self.mode = mode
        self.models = models
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
                messages.append(CallMessage(id: item.id, role: .assistant, text: text, time: item.time, turn: item.turn))
            case .failure(let failure):
                if let turn = item.turn { failures[turn] = failure.reason }
            case .turnEnd(let end):
                guard let turn = item.turn else { continue }
                turns.append(CallTurn(id: turn, user: users[turn], reply: end.copyText, ended: end.reason,
                                      error: end.reason == "error" ? failures[turn] : nil, endedAt: end.endedAt))
            case .question(let ask):
                if ask.phase != .answered { needsInput = true }
            default:
                continue
            }
        }
        // The agent's words are complete once it went on past them in their
        // run, or the run is over. As the transcript itself has it, only the
        // newest run while the agent works may end mid-block; in it, words
        // with a step of that run after them (a tool call, more words, the
        // run's end) are complete. Anything else coming after them, the
        // person's message or another agent's, says nothing of that.
        if snapshot.working, let live = snapshot.items.last(where: { $0.turn != nil })?.turn,
           let last = snapshot.items.last(where: { $0.turn == live && Self.isStep($0) }), last.role == .agent,
           let index = messages.lastIndex(where: { $0.role == .assistant && $0.id == last.id }) {
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
    /// What the agent itself does in a run: its words, a tool call, the
    /// run's end or failure.
    static func isStep(_ item: ChatItem) -> Bool {
        switch item.role {
        case .agent, .tool, .turnEnd, .failure: true
        default: false
        }
    }
}

/// A model the call may switch a conversation to: one the composer's model
/// picker offers.
public struct CallModel: Equatable, Sendable {
    public var id: String
    public var name: String
    /// Least to most; empty for a model that takes no effort.
    public var efforts: [String]
    /// What switching to it runs at unless an effort is asked for.
    public var defaultEffort: String

    public init(id: String, name: String, efforts: [String], defaultEffort: String? = nil) {
        self.id = id
        self.name = name
        self.efforts = efforts
        self.defaultEffort = defaultEffort ?? efforts.first ?? ""
    }

    /// Every model the pickers list: each switched-on, shown account's
    /// models, less those it keeps out of the pickers, once each in the
    /// catalog's order.
    public static func options(_ catalog: ModelCatalog) -> [CallModel] {
        var seen = Set<String>()
        var result: [CallModel] = []
        for provider in catalog.providers where !provider.isDisabled && !provider.hidden {
            for model in provider.models where !provider.hiddenModels.contains(model.id) && seen.insert(model.id).inserted {
                result.append(CallModel(id: model.id, name: model.name, efforts: model.efforts, defaultEffort: model.defaultEffort))
            }
        }
        return result
    }
}

/// The model and effort a conversation's next message goes with.
public struct CallMode: Equatable, Sendable {
    public var modelId: String
    /// As the picker names it.
    public var model: String
    public var effort: String

    public init(modelId: String, model: String, effort: String) {
        self.modelId = modelId
        self.model = model
        self.effort = effort
    }

    public init(_ mode: AgentWire.Mode, catalog: ModelCatalog) {
        self.init(modelId: mode.modelId, model: catalog.model(mode)?.name ?? mode.modelId, effort: mode.effort)
    }
}

/// What a send by voice changes first, checked against the conversation's
/// `CallTargetState.models`: another model, another effort, or both.
public struct CallModeChange: Equatable, Sendable {
    public var modelId: String?
    public var effort: String?

    public init(modelId: String? = nil, effort: String? = nil) {
        self.modelId = modelId
        self.effort = effort
    }

    /// `current` with this change, as the composer's pickers make it
    /// (`ModelCatalog.select`): another model on the first account that
    /// offers it, with the effort asked for or the model's own default.
    public func applied(to current: AgentWire.Mode, catalog: ModelCatalog) -> AgentWire.Mode {
        if let modelId, modelId != current.modelId {
            return catalog.select(providerId: nil, modelId: modelId, effort: effort, from: current)
        }
        var next = current
        if let effort { next.effort = effort }
        return next
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
    /// send does but without touching its draft or attachments; with
    /// `change`, as the composer's pickers would have switched it first.
    func send(_ agentId: String, text: String, id: String, change: CallModeChange?) async -> CallSendOutcome
    /// Keeps a conversation read (or lets it go) while the call follows it.
    func follow(_ agentId: String, _ following: Bool) async
    /// New work on screen, as compose opens it, chosen as `kind` and
    /// named `name` (blank for its first message to name it): the empty
    /// conversation, which the sidebar lists only once its first message
    /// has made it. Nil if it didn't open.
    func newWork(_ kind: CallTarget.Kind, name: String) async -> CallTarget?
    /// New work on screen under `agentId` that the sidebar doesn't list
    /// yet (compose's, opened by hand or by `newWork`); nil for anything else.
    func unlisted(_ agentId: String) async -> CallTarget?
    /// Back one screen: what is presented over the app closes, else the
    /// screen on top goes.
    func back() async -> CallScreenMove
    /// Home, with nothing over it.
    func home() async -> CallScreenMove
}

/// Where going back or home left the screen.
public enum CallScreenMove: Equatable, Sendable {
    case moved(atHome: Bool)
    case refused(String)
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
