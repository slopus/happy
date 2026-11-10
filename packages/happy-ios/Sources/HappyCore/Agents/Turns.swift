import Foundation
import HappyWire

/// A turn's own rows, as desktop's transcript draws them
/// (`happyAgentConnectGroupProject`): each tool call while the turn runs,
/// the line that says how it ended, the questions it asked, and once it
/// ended the control that folds its work away.
extension ChatItem {
    /// One tool call (desktop's `AgentToolActivity`, single line).
    public struct Tool: Equatable, Sendable {
        public var name: String
        /// `running`, `completed` or `failed`.
        public var status: String
        public var presentation: AgentWire.Presentation?
        /// The call's own ID, which its screen fetches the whole call by.
        public var callId: String
        /// The raw data a call without a complete presentation keeps
        /// (`ToolRaw`), and what the automatic reviewer decided.
        public var arguments: JSONValue?
        public var result: JSONValue?
        public var review: AgentWire.ToolReview?

        public init(name: String, status: String, presentation: AgentWire.Presentation? = nil, callId: String = "", arguments: JSONValue? = nil, result: JSONValue? = nil, review: AgentWire.ToolReview? = nil) {
            self.name = name
            self.status = status
            self.presentation = presentation
            self.callId = callId
            self.arguments = arguments
            self.result = result
            self.review = review
        }

        public var running: Bool { status == "running" }
        public var failed: Bool { status == "failed" }
        /// A file edit, presented media or a published artifact is a result
        /// the reader can open: it stays when the turn folds.
        public var isResult: Bool { ["file_diff", "media", "artifact"].contains(presentation?.type) }
    }

    /// How a turn ended (desktop's `turnStatus` row, `TurnSummary`).
    public struct TurnEnd: Equatable, Sendable {
        /// `completed`, `steering`, `abort` or `error`.
        public var reason: String
        public var durationMs: Double?
        /// Its tool calls, every kind.
        public var tools: Int
        /// The turn's final answer, which the row's copy button copies.
        public var copyText: String?
        /// It follows a step of the turn, which it keeps 4 more from
        /// (`happy-turn-status--after-trace`); `TurnFold` says.
        public var afterStep = false
        /// When the run ended, in ms; nil where it isn't known.
        public var endedAt: Double?

        public init(reason: String, durationMs: Double?, tools: Int, copyText: String?, endedAt: Double? = nil) {
            self.reason = reason
            self.durationMs = durationMs
            self.tools = tools
            self.copyText = copyText
            self.endedAt = endedAt
        }

        /// Desktop's `TurnSummary` status: a steered turn, one that failed
        /// or was stopped, or one complete, which alone offers its copy.
        public var complete: Bool { reason == "completed" || reason == "compaction" }

        /// "Completed in 12s": the verb and joiner `words` gives for its
        /// reason, and the duration as desktop writes it.
        public func label(_ words: (_ reason: String) -> (verb: String, joiner: String)) -> String {
            let (verb, joiner) = words(reason)
            guard let durationMs else { return verb }
            return "\(verb) \(joiner)\u{00a0}\(Self.duration(durationMs))"
        }

        /// TurnSummary.tsx `durationFormat`: 42s, 3m 07s as 3m 7s, 2h 5m.
        public static func duration(_ ms: Double) -> String {
            let total = max(0, Int((ms / 1000).rounded(.down)))
            if total < 60 { return "\(total)s" }
            let minutes = total / 60
            if minutes < 60 { return "\(minutes)m\u{00a0}\(total % 60)s" }
            return "\(minutes / 60)h\u{00a0}\(minutes % 60)m"
        }
    }

    /// A question the agent asked (`request_user_input`): pending, pinned
    /// to the transcript's end, or answered, where it was asked.
    public struct Ask: Equatable, Sendable {
        public enum Phase: Equatable, Sendable {
            case pending
            /// The answer is on its way.
            case submitting
            /// Refused or lost: why, and the answer may go again.
            case failed(String)
            case answered
        }

        public var question: AgentWire.Question
        public var phase: Phase
        /// The options the person ticked, not yet sent, by prompt ID: the
        /// screen's own, set on the item before it is planned.
        public var picked: [String: [String]] = [:]

        public init(question: AgentWire.Question, phase: Phase) {
            self.question = question
            self.phase = phase
        }

        /// Every prompt has a pick: Submit may go.
        public var complete: Bool {
            question.questions.allSatisfy { !(picked[$0.id] ?? []).isEmpty }
        }

        /// What a message typed in the composer answers (desktop's
        /// `pendingQuestionAnswer`): each prompt its picks, else the text;
        /// `textUsed` when any prompt took the text.
        public func answers(typed text: String) -> (answers: [String: [String]], textUsed: Bool) {
            var answers: [String: [String]] = [:]
            var textUsed = false
            for prompt in question.questions {
                let chosen = picked[prompt.id] ?? []
                if chosen.isEmpty { answers[prompt.id] = [text]; textUsed = true } else { answers[prompt.id] = chosen }
            }
            return (answers, textUsed)
        }

        /// A pick on prompt `promptId`: one alone, or one more of many,
        /// taken back when picked again (desktop's `toggleValue`).
        public func picking(_ label: String, in promptId: String) -> [String: [String]] {
            var picked = picked
            let current = picked[promptId] ?? []
            let many = question.questions.first { $0.id == promptId }?.multiSelect ?? false
            if current.contains(label) { picked[promptId] = current.filter { $0 != label } }
            else { picked[promptId] = many ? current + [label] : [label] }
            return picked
        }
    }

    /// A finished turn's "View traces" / "Hide traces" control.
    public struct Trace: Equatable, Sendable {
        public var turn: String
        public var open: Bool
        public var tools: Int

        public init(turn: String, open: Bool, tools: Int) {
            self.turn = turn
            self.open = open
            self.tools = tools
        }
    }
}

/// Folds each finished turn as desktop does (`happyAgentConnectGroupProject`):
/// closed, a turn keeps the person's words, its final answer (else its last
/// step), what other agents said, file edits, the media and artifacts its
/// calls showed, failures and how it ended,
/// and its "View traces" control rides the answer. Open, every step shows
/// and the control rides the turn's first step. A turn still running, or
/// with nothing to hide, is left as it is. Then calls showing pictures one
/// after another are one grid (`MediaRuns`).
public enum TurnFold {
    public static func fold(_ items: [ChatItem], expanded: Set<String>) -> [ChatItem] {
        var result: [ChatItem] = []
        result.reserveCapacity(items.count)
        var index = 0
        while index < items.count {
            guard let turn = items[index].turn else {
                result.append(items[index])
                index += 1
                continue
            }
            var end = index
            while end < items.count, items[end].turn == turn { end += 1 }
            result += fold(turn: turn, Array(items[index..<end]), open: expanded.contains(turn))
            index = end
        }
        // How a turn ended keeps 4 more from a step right above it.
        for index in result.indices.dropFirst() {
            guard case .turnEnd(var ended) = result[index].role else { continue }
            let afterStep = isStep(result[index - 1])
            guard ended.afterStep != afterStep else { continue }
            ended.afterStep = afterStep
            // Read from nothing but whether a step is above it: the same
            // turn's end so placed again is the same making (`ChatItem.revision`).
            result[index] = result[index].derived(afterStep ? 1 : 2) { $0.role = .turnEnd(ended) }
        }
        return MediaRuns.join(result)
    }

    static func fold(turn: String, _ group: [ChatItem], open: Bool) -> [ChatItem] {
        guard let status = group.firstIndex(where: { if case .turnEnd = $0.role { true } else { false } }),
              case .turnEnd(let ended) = group[status].role else { return group }
        // Quick replies are no answer; they stay under it.
        func replies(_ item: ChatItem) -> Bool { item.pieces.contains { if case .quickReplies = $0 { true } else { false } } }
        func shows(_ item: ChatItem) -> Bool { item.pieces.contains { if case .ui = $0 { true } else if case .mediaRows = $0 { true } else { false } } }
        let finalAgent = group.lastIndex { $0.role == .agent && !replies($0) }
        let anchor = finalAgent ?? group.lastIndex(where: isStep)
        let kept = group.indices.filter { index in
            if index == anchor { return true }
            switch group[index].role {
            case .turnEnd, .user, .collaborator, .failure, .trace: return true
            case .tool(let tool): return tool.isResult
            case .question(let ask): return ask.phase != .answered
            // Chat UI stays: a live control, a tree or media the agent
            // showed, and quick replies, each with the words that brought it.
            case .agent:
                return replies(group[index]) || shows(group[index])
                    || (group.indices.contains(index + 1) && (replies(group[index + 1]) || shows(group[index + 1])))
            }
        }
        guard kept.count < group.count else { return group }
        let trace = ChatItem(id: "\(turn):trace", role: .trace(ChatItem.Trace(turn: turn, open: open, tools: ended.tools)), pieces: [], delivery: .sent, turn: turn)
        if open {
            var items = group
            items.insert(trace, at: group.firstIndex(where: holdsTrace) ?? status)
            return items
        }
        // The control rides above the answer and the words kept with it.
        var traceAt = anchor
        if var at = anchor {
            while let previous = kept.last(where: { $0 < at }), previous == at - 1, group[previous].role == .agent, !replies(group[previous]) { at = previous }
            traceAt = at
        }
        var items: [ChatItem] = []
        for index in kept {
            if index == traceAt { items.append(trace) }
            items.append(group[index])
        }
        return items
    }

    /// The work of a turn, which a closed turn hides.
    static func isStep(_ item: ChatItem) -> Bool {
        switch item.role {
        case .tool, .collaborator: true
        default: false
        }
    }

    /// What the control may ride (desktop's `withTrace`): the agent's
    /// words or one of its steps.
    static func holdsTrace(_ item: ChatItem) -> Bool {
        switch item.role {
        case .agent, .tool, .collaborator: true
        default: false
        }
    }
}

/// Consecutive calls that each show only pictures in the same column grid
/// (several screenshots read one after another, a batch of generated
/// images) are one grid, as desktop draws them (`conversationMediaRuns`):
/// every picture of the run, in order, under the run's last call; the calls
/// before it keep only their line. An exploration between two of them is
/// part of the work and the run goes on across it; anything else ends it,
/// as does a call with another column count. A run of one is no run.
public enum MediaRuns {
    public static func join(_ items: [ChatItem]) -> [ChatItem] {
        var result = items
        var members: [Int] = []
        var columns: Int?
        func close() {
            if members.count >= 2, let columns, let last = members.last {
                var media: [Media] = []
                for index in members {
                    guard case .gallery(let shown, _)? = result[index].pieces.first else { continue }
                    media += shown
                }
                for index in members.dropLast() { result[index].pieces = [] }
                result[last].pieces = [.gallery(media, columns: columns)]
            }
            members = []
            columns = nil
        }
        for index in items.indices {
            guard let grid = Self.columns(items[index]) else {
                if !Self.passesOver(items[index]) { close() }
                continue
            }
            if grid != columns { close() }
            columns = grid
            members.append(index)
        }
        close()
        return result
    }

    /// The column count of a call that can join a run: it showed only
    /// pictures, in the columns the producer asked for.
    static func columns(_ item: ChatItem) -> Int? {
        guard case .tool(let tool) = item.role, tool.presentation?.type == "media", item.pieces.count == 1,
              case .gallery(let media, let columns) = item.pieces[0], columns == 1 || columns == 2,
              !media.isEmpty, media.allSatisfy({ $0.item.kind == "image" }) else { return nil }
        return columns
    }

    /// A row a run goes on across: an exploration.
    static func passesOver(_ item: ChatItem) -> Bool {
        guard case .tool(let tool) = item.role else { return false }
        return tool.presentation?.type == "exploration"
    }
}

extension AgentWire.Question {
    /// A question as its call asked it (`request_user_input` arguments)
    /// and, from the result the agent was given (`formatUserInputForModel`),
    /// how it was answered; nil when the call says neither.
    public static func asked(id: String, arguments: JSONValue?, output: String?) -> AgentWire.Question? {
        guard let entries = arguments?["questions"]?.arrayValue, !entries.isEmpty else { return nil }
        var prompts: [Prompt] = []
        for (offset, entry) in entries.enumerated() {
            guard let question = entry["question"]?.stringValue else { return nil }
            // Options come as a list, or as `{ choices, multiSelect }`.
            let options = entry["options"]
            let choices = options?.arrayValue ?? options?["choices"]?.arrayValue ?? []
            prompts.append(Prompt(
                id: entry["id"]?.stringValue ?? "question_\(offset + 1)",
                header: entry["header"]?.stringValue, question: question,
                multiSelect: entry["multiSelect"]?.boolValue ?? options?["multiSelect"]?.boolValue ?? false,
                options: choices.compactMap { choice in
                    choice["label"]?.stringValue.map { Option(label: $0, description: choice["description"]?.stringValue) }
                }
            ))
        }
        guard let output else { return AgentWire.Question(id: id, status: "pending", questions: prompts) }
        guard output.contains("\nStatus: Answered") else { return AgentWire.Question(id: id, status: "canceled", questions: prompts) }
        return AgentWire.Question(id: id, status: "answered", questions: prompts, answers: answers(output, prompts: prompts))
    }

    /// Each prompt's values from a result's `Answer:` section: `id: value`
    /// lines, a value `Selected: a, b` then any text typed under it.
    static func answers(_ output: String, prompts: [Prompt]) -> [String: [String]] {
        guard let range = output.range(of: "\nAnswer:\n") else { return [:] }
        let lines = output[range.upperBound...].components(separatedBy: "\n")
        var answers: [String: [String]] = [:]
        var current: String?
        var values: [String: [String]] = [:]
        for line in lines {
            if let prompt = prompts.first(where: { line.hasPrefix("\($0.id): ") }) {
                current = prompt.id
                values[prompt.id] = [String(line.dropFirst(prompt.id.count + 2))]
            } else if let current {
                values[current, default: []].append(line)
            } else if prompts.count == 1 {
                // A single question's answer carries no ID.
                current = prompts[0].id
                values[prompts[0].id] = [line]
            }
        }
        for prompt in prompts {
            guard var body = values[prompt.id], !body.isEmpty else { continue }
            var picked: [String] = []
            if body[0].hasPrefix("Selected: ") {
                let labels = (prompt.options ?? []).map(\.label)
                let selected = String(body[0].dropFirst("Selected: ".count))
                // Labels may hold ", " themselves: the known ones are read whole.
                picked = labels.filter { selected == $0 || selected.hasPrefix("\($0), ") || selected.hasSuffix(", \($0)") || selected.contains(", \($0), ") }
                if picked.isEmpty { picked = selected.components(separatedBy: ", ") }
                body.removeFirst()
            }
            let text = body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { picked.append(text) }
            answers[prompt.id] = picked
        }
        return answers
    }
}
