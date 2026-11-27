import Foundation
import HappyStore

// A Happy account's sessions (Happy CLI's, and Happy Agent's over the
// relay), as a call reads them: the same `CallTarget` and
// `CallTargetState` an agent connection's conversations are, made from the
// relay's records, its chat (`LegacyChatSnapshot`) and the composer's own
// chips (`ComposerModes`). Pure, so the call's view of them is tested
// without a phone.

extension CallTarget {
    /// Home's sessions as a call's directory: not archived (a Happy CLI
    /// session that stopped is), no side chats or retired tasks. Happy
    /// Agent publishes no subtasks to the relay, so there are none. Bots
    /// and tasks first, each on its own, then every other session under its
    /// project's heading and, in a worktree, the worktree's. The order is
    /// stable, not home's by activity, so a reply never moves anything: the
    /// newest created first, headings by their newest session, a project's
    /// own checkout before its worktrees.
    public static func legacyDirectory(_ sessions: [SessionRecord], projects: [ProjectRecord] = []) -> [CallTarget] {
        let linked = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let live = sessions.filter { $0.metadata?["isSideChat"]?.boolValue != true && !$0.isRetiredTask && !$0.isArchived }
            .sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id < $1.id }
        var own: [CallTarget] = []
        // Each project in the order its newest session comes, with its own
        // checkout's sessions, then each worktree's.
        var projectOrder: [String] = []
        var groups: [String: [(key: String, targets: [CallTarget])]] = [:]
        for session in live {
            var target = legacy(session)
            guard target.kind == .conversation else {
                own.append(target)
                continue
            }
            let place = SessionPlace(session, projects: linked)
            let machine = session.metadata?["machineId"]?.stringValue ?? ""
            let project = clean(place.projectName)
            let projectId = "project:\(machine):\(project)"
            var key = ""
            if !project.isEmpty {
                target.parents.append(Parent(id: projectId, title: project, kind: "project"))
                if let workspace = place.workspaceName.map(clean), !workspace.isEmpty {
                    key = "\(projectId):workspace:\(workspace)"
                    target.parents.append(Parent(id: key, title: workspace, kind: "workspace"))
                }
            }
            if groups[projectId] == nil { projectOrder.append(projectId) }
            var lines = groups[projectId] ?? []
            if let index = lines.firstIndex(where: { $0.key == key }) {
                lines[index].targets.append(target)
            } else if key.isEmpty {
                lines.insert((key, [target]), at: 0)
            } else {
                lines.append((key, [target]))
            }
            groups[projectId] = lines
        }
        return own + projectOrder.flatMap { groups[$0]?.flatMap(\.targets) ?? [] }
    }

    /// A session the agent hasn't named yet, as home's row names it, so
    /// the name the person sees is the one the call knows.
    public static let unnamedSession = "New chat"

    /// One session as it stands alone: a bot or a task by what it is, any
    /// other a conversation; named as home names it.
    public static func legacy(_ session: SessionRecord) -> CallTarget {
        let kind: Kind = session.isBot ? .bot : session.isTask ? .task : .conversation
        let title = session.title.map(clean) ?? ""
        return CallTarget(agentId: session.id, title: title.isEmpty ? unnamedSession : title, kind: kind, status: legacyStatus(session),
                          activityAt: Double(session.lastActivityAt))
    }

    /// Thinking is running, a permission or a question waiting is the
    /// person's, anything else (stopped too) idle.
    static func legacyStatus(_ session: SessionRecord) -> Status {
        if session.active, session.hasPendingPermissionRequests || session.hasPendingCommunications { return .needsInput }
        if session.active, session.thinking { return .running }
        return .idle
    }
}

extension CallTargetState {
    /// Happy Agent's words for a run that failed (`mapHappyMessages.ts`
    /// `#mapSettled`), under the run's event ID with this suffix: the
    /// relay's turn end that carries the failure never reaches the chat.
    static let failurePrefix = "The run failed: "
    static let failureSuffix = ":failure"

    /// A Happy account's session as the call reads it. Only words count:
    /// the person's messages and the agent's text, never its thinking,
    /// tools or a sub-agent's work. Each of the person's messages starts an
    /// exchange whose answer is the agent's last words before the next; the
    /// newest has none yet while the agent works, or while nothing of the
    /// agent's came after it. Happy Agent's failed run ends its exchange in
    /// an error. It works while the session thinks, and waits for the
    /// person while a permission or a question is pending. It takes a
    /// message once read, while it runs on its computer. `modes` are the
    /// composer's chips for it: the models and efforts a message may switch
    /// it to, and whether its computer lets it. `current`: read from the
    /// server while the account's link is live.
    public static func legacy(_ chat: LegacyChatSnapshot, session: SessionRecord, target: CallTarget, modes: ComposerModes? = nil,
                              current: Bool = true, checkedAt: Double? = nil) -> CallTargetState {
        struct Exchange {
            var user: CallMessage?
            var id: String
            var reply: String?
            var endedAt: Double?
            var error: String?
            /// The agent did something after the person's message.
            var acted = false
            /// Its last step is words, at this index of `messages`.
            var lastWords: Int?
        }
        var messages: [CallMessage] = []
        var exchanges: [Exchange] = []
        for message in chat.messages {
            switch message {
            case .userText(let user):
                let text = user.displayText ?? user.text
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let delivery: CallMessage.Delivery = switch user.localId.flatMap({ chat.delivery[$0] }) {
                case .queued?, .sending?: .queued
                case .failed?: .failed
                case nil: user.sendError == nil ? .accepted : .failed
                }
                // On a team, who wrote it: the reader's own are the person's.
                let by = user.author.map { $0.owner == true ? "the person" : CallTarget.clean($0.name) }
                let said = CallMessage(id: user.id, role: .user, text: text, time: Double(user.createdAt), delivery: delivery,
                                       author: user.author?.id, by: by)
                messages.append(said)
                exchanges.append(Exchange(user: said, id: user.id))
            case .agentText(let agent):
                guard !agent.isThinking, !agent.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                if exchanges.isEmpty { exchanges.append(Exchange(id: agent.id)) }
                let last = exchanges.count - 1
                exchanges[last].acted = true
                exchanges[last].endedAt = Double(agent.createdAt)
                if agent.id.hasSuffix(failureSuffix), agent.text.hasPrefix(failurePrefix) {
                    exchanges[last].error = String(agent.text.dropFirst(failurePrefix.count))
                    exchanges[last].lastWords = nil
                    continue
                }
                messages.append(CallMessage(id: agent.id, role: .assistant, text: agent.text, time: Double(agent.createdAt), turn: exchanges[last].id))
                exchanges[last].reply = agent.text
                exchanges[last].error = nil
                exchanges[last].lastWords = messages.count - 1
            case .toolCall:
                guard !exchanges.isEmpty else { continue }
                exchanges[exchanges.count - 1].acted = true
                exchanges[exchanges.count - 1].lastWords = nil
            case .agentEvent, .unsupported:
                continue
            }
        }
        let working = session.active && session.thinking
        let needsInput = session.active && (session.hasPendingPermissionRequests || session.hasPendingCommunications)
        // While it works, the words it wrote last with nothing after them may go on.
        if working, let index = exchanges.last(where: \.acted)?.lastWords { messages[index].final = false }
        // The newest exchange is open while the agent works on it, or hasn't started on it.
        var unanswered: CallMessage?
        if let last = exchanges.last, let user = last.user, working || !last.acted {
            unanswered = user
            exchanges.removeLast()
        }
        let turns = exchanges.map {
            CallTurn(id: $0.id, user: $0.user?.text, reply: $0.reply, ended: $0.error == nil ? "completed" : "error", error: $0.error,
                     endedAt: $0.endedAt, userAuthor: $0.user?.author, userBy: $0.user?.by)
        }
        var target = target
        target.status = needsInput ? .needsInput : working ? .running : .idle
        var state = CallTargetState(
            target: target, messages: messages, turns: turns, unanswered: unanswered, working: working, needsInput: needsInput,
            writable: chat.isLoaded && session.active && session.decryptable && !session.isArchived,
            hasMore: chat.hasMoreOlder, fresh: current && !session.hasUnsyncedMessages, checkedAt: checkedAt
        )
        if let modes {
            let metadata = session.metadata
            let flavor = metadata?["flavor"]?.stringValue
            state.models = modes.availableModels.filter { !$0.isDisabled }.prefix(CallContext.Limits.models).map { model in
                let efforts = ModelModeOptions.effortLevelsForModel(flavor: flavor, modelKey: model.key, metadata: metadata).map(\.key)
                return CallModel(id: model.key, name: model.name, efforts: efforts, defaultEffort: model.defaultThinkingLevel)
            }
            state.mode = modes.modelMode.map { CallMode(modelId: $0.key, model: $0.name, effort: modes.effortLevel?.key ?? "") }
            state.modelLocked = !RigCatalog.isModelSelectionEnabled(metadata)
            state.effortLocked = !RigCatalog.isReasoningSelectionEnabled(metadata)
        }
        return state
    }
}

/// Where a call's new work starts on a Happy account: Happy Agent on the
/// computer compose would use, as compose starts a bot or a task
/// (`NewSessionChoices.resolve`, `SessionStarter`).
public enum LegacyNewWork {
    public struct Refusal: Error, Equatable, Sendable {
        public var reason: String

        public init(reason: String) {
            self.reason = reason
        }
    }

    /// The computer `kind` (nil: either) starts on: the one compose has
    /// picked if its Happy Agent makes it and answers, else the only one
    /// that does; or why none.
    public static func machine(for kind: CallTarget.Kind?, machines: [MachineRecord], picked: String?) -> Result<String, Refusal> {
        let targets = MachineChoice.collect(machines.sorted { $0.createdAt > $1.createdAt }).map(MachineTarget.init)
        let kinds: [HomeDockKind] = switch kind {
        case .bot?: [.bot]
        case .task?: [.task]
        default: [.task, .bot]
        }
        let able = targets.filter { target in kinds.contains { target.makes($0) && target.isOnline(for: $0) } }
        if let chosen = able.first(where: { $0.id == picked }) { return .success(chosen.id) }
        guard let only = able.first else { return .failure(Refusal(reason: CallContext.HappyCLI.noNewWork)) }
        guard able.count == 1 else { return .failure(Refusal(reason: CallContext.HappyCLI.severalComputers)) }
        return .success(only.id)
    }

    /// The models and efforts new work may start on there, and what it
    /// starts on unless asked: the computer's Happy Agent's own catalog and
    /// defaults, as compose's pickers offer them.
    public static func modes(machineId: String, machines: [MachineRecord]) -> (models: [CallModel], mode: CallMode?) {
        let choice = MachineChoice.collect(machines.sorted { $0.createdAt > $1.createdAt }).first { $0.id == machineId }
        guard let rig = RigSessionCreation(metadata: choice?.rigMachine?.metadata) else { return ([], nil) }
        let models = rig.models.prefix(CallContext.Limits.models).map {
            CallModel(id: $0.key, name: $0.name, efforts: $0.thinkingLevels, defaultEffort: $0.defaultThinkingLevel)
        }
        let mode = rig.defaultModelKey.flatMap { key in
            models.first { $0.id == key }.map { CallMode(modelId: key, model: $0.name, effort: rig.defaultEffort(forModel: key) ?? "") }
        }
        return (Array(models), mode)
    }
}
