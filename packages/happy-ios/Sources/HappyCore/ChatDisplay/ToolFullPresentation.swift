import Foundation
import HappyWire

/// A tool's own screen (session/[id]/message/[messageId].tsx with
/// ToolFullView.tsx and ToolHeader.tsx), decided: its title, then the whole
/// tool, output included. The chat collapses tools; this screen never does.
public struct ToolFullPresentation: Equatable, Sendable {
    /// What fills the screen.
    public enum Main: Equatable, Sendable {
        /// BashViewFull: CommandView with the output, then a shell
        /// control's typed input.
        case terminal(ToolFullTerminal, controlInput: String?)
        /// TaskView: the sub-agent's last tool calls.
        case task
        /// EditViewFull (line numbers always on), WriteView (the
        /// setting's), MultiEditViewFull (each edit headed "Edit N of M").
        case diff(ToolViewKind, chunks: [ToolDiffChunk], replaceAll: [Bool])
        /// CodexPatchViewFull: each file in a bordered card; nil when the
        /// patch can't be read and PatchFallback shows the raw text.
        case patch([ToolPatchFile]?)
        /// CodexDiffViewFull: the turn's diff in a bordered card; nil draws
        /// nothing.
        case unifiedDiff(ToolUnifiedDiff?)
        /// ToolFullView's fallback: description, input, output, error.
        case generic(ToolFullGeneric)
    }

    /// How a specialized view that shows the tool's inputs ends: the error,
    /// or the output.
    public enum Outcome: Equatable, Sendable {
        case error(ToolFullError)
        case output(String)
    }

    /// ToolHeader: the navigation title.
    public var title: ToolText
    public var main: Main
    public var outcome: Outcome?
    /// An edit tool's diffs run edge to edge on a phone instead of in a
    /// readable column (`getToolSummaryCategory(tool.name) === 'edit'`).
    public var wide: Bool

    public init(_ tool: ToolCall, root: String?, words: ToolActionWords) {
        title = Self.title(tool, root: root, words: words)
        let name = tool.name
        wide = ChatToolDisplay.category(name) == .edit
        let terminal = ChatToolDisplay.isTerminal(name) || Self.terminalNames.contains(name)
        if terminal {
            let command = ChatToolDisplay.terminalCommand(tool)
            let result = ToolFullTerminal.Result(tool)
            main = .terminal(
                ToolFullTerminal(
                    command: command ?? ChatToolDisplay.activityLabel(tool, words: words),
                    prompt: command != nil,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    error: tool.state == .error ? ToolFullError(result.error) : nil,
                    hideEmptyOutput: tool.state == .running
                ),
                controlInput: ChatToolDisplay.shellControl(tool)?.chars
            )
            outcome = nil
            return
        }
        if Self.taskNames.contains(name) {
            main = .task
        } else if let kind = Self.diffNames[name] {
            let chunks = ToolDiffInputs.chunks(kind, input: tool.input)
            let replaceAll = kind == .multiEdit
                ? (tool.input["edits"]?.arrayValue ?? []).map { $0["replace_all"]?.boolValue == true }
                : []
            main = .diff(kind, chunks: chunks, replaceAll: replaceAll)
        } else if Self.patchNames.contains(name) {
            main = .patch(ChatPatch.viewFiles(tool.input, root: root))
        } else if Self.unifiedDiffNames.contains(name) {
            main = .unifiedDiff(ToolUnifiedDiff(tool.input))
        } else {
            main = .generic(ToolFullGeneric(tool, words: words))
            outcome = nil
            return
        }
        // Specialized views show the inputs, not how the run ended.
        if tool.state == .error {
            outcome = .error(ToolFullError(Self.resultText(tool.result)))
        } else if tool.state == .completed, let result = tool.result, result != .null {
            outcome = .output(Self.resultText(result) ?? "")
        } else {
            outcome = nil
        }
    }

    /// ToolHeader: the known tool's title unless the provider named the
    /// call; for a terminal tool, what it ran.
    public static func title(_ tool: ToolCall, root: String?, words: ToolActionWords) -> ToolText {
        if ChatToolDisplay.isTerminal(tool.name) {
            return .literal(ChatToolDisplay.activityLabel(tool, words: words))
        }
        if (tool.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let known = ChatToolPresentation.knownTitle(tool, root: root) {
            return known
        }
        return .literal(ChatToolDisplay.displayTitle(tool, words: words))
    }

    /// toolResult.ts `toolResultText`.
    public static func resultText(_ value: JSONValue?) -> String? {
        guard let value, value != .null else { return nil }
        return value.stringValue ?? ChatToolPresentation.pretty(value)
    }

    /// toolFullViewRegistry's terminal entries; anything else in the
    /// terminal category joins them.
    static let terminalNames: Set<String> = ["Bash", "CodexBash"]
    static let taskNames: Set<String> = ["Task", "Agent"]
    static let patchNames: Set<String> = ["CodexPatch", "GeminiPatch", "apply_patch"]
    static let unifiedDiffNames: Set<String> = ["CodexDiff", "GeminiDiff"]
    static let diffNames: [String: ToolViewKind] = [
        "Edit": .edit, "search_replace": .edit, "Write": .write, "write": .write, "MultiEdit": .multiEdit,
    ]
}

extension ToolFullPresentation {
    /// ToolFullView's dev-mode "Raw JSON": the call as happy-app's
    /// `ToolCall` and its sub-agent's messages as `Message`s. Absent
    /// optionals are left out and nullable ones are null, as
    /// `JSON.stringify` writes them.
    public static func rawJSON(_ message: ToolCallMessage) -> JSONValue {
        // The screen lists the call's fields by name; a child's tool is the
        // whole `ToolCall`, call id included.
        var object = toolJSON(message.tool).objectValue ?? [:]
        object["callId"] = nil
        object["messages"] = .array(message.children.map(messageJSON))
        return .object(object)
    }

    static func toolJSON(_ tool: ToolCall) -> JSONValue {
        var object: [String: JSONValue] = [
            "name": .string(tool.name),
            "state": .string(tool.state.rawValue),
            "description": tool.description.map(JSONValue.string) ?? .null,
            "input": tool.input,
            "createdAt": .number(Double(tool.createdAt)),
            "startedAt": tool.startedAt.map { .number(Double($0)) } ?? .null,
            "completedAt": tool.completedAt.map { .number(Double($0)) } ?? .null,
        ]
        if let callId = tool.callId { object["callId"] = .string(callId) }
        if let title = tool.title { object["title"] = .string(title) }
        if let result = tool.result { object["result"] = result }
        if let permission = tool.permission {
            var record: [String: JSONValue] = ["id": .string(permission.id), "status": .string(permission.status.rawValue)]
            if let reason = permission.reason { record["reason"] = .string(reason) }
            if let mode = permission.mode { record["mode"] = .string(mode) }
            if let allowedTools = permission.allowedTools { record["allowedTools"] = .array(allowedTools.map(JSONValue.string)) }
            if let decision = permission.decision { record["decision"] = .string(decision.rawValue) }
            if let date = permission.date { record["date"] = .number(Double(date)) }
            object["permission"] = .object(record)
        }
        return .object(object)
    }

    static func messageJSON(_ message: ChatMessage) -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(message.id), "createdAt": .number(Double(message.createdAt))]
        var meta: MessageMeta?
        switch message {
        case .userText(let user):
            object["kind"] = .string("user-text")
            object["localId"] = user.localId.map(JSONValue.string) ?? .null
            object["text"] = .string(user.text)
            if let displayText = user.displayText { object["displayText"] = .string(displayText) }
            meta = user.meta
        case .agentText(let agent):
            object["kind"] = .string("agent-text")
            object["localId"] = agent.localId.map(JSONValue.string) ?? .null
            object["text"] = .string(agent.text)
            if agent.isThinking { object["isThinking"] = .bool(true) }
            if let turn = agent.turn { object["turn"] = .string(turn) }
            meta = agent.meta
        case .toolCall(let call):
            object["kind"] = .string("tool-call")
            object["localId"] = call.localId.map(JSONValue.string) ?? .null
            object["tool"] = toolJSON(call.tool)
            object["children"] = .array(call.children.map(messageJSON))
            if let turn = call.turn { object["turn"] = .string(turn) }
            meta = call.meta
        case .agentEvent(let event):
            object["kind"] = .string("agent-event")
            object["event"] = eventJSON(event.event)
            if let turn = event.turn { object["turn"] = .string(turn) }
            meta = event.meta
        case .unsupported(let unsupported):
            object["kind"] = .string(unsupported.kind)
        }
        if let meta, let data = try? JSONEncoder().encode(meta), let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            object["meta"] = value
        }
        return .object(object)
    }

    static func eventJSON(_ event: AgentEvent) -> JSONValue {
        switch event {
        case .modeSwitch(let mode): .object(["type": .string("switch"), "mode": .string(mode)])
        case .message(let message): .object(["type": .string("message"), "message": .string(message)])
        case .limitReached(let endsAt): .object(["type": .string("limit-reached"), "endsAt": .number(Double(endsAt))])
        case .ready: .object(["type": .string("ready")])
        case .userMessageAccepted(let ref): .object(["type": .string("user-message-accepted"), "ref": .string(ref)])
        case .userMessageRejected(let ref, let reason): .object(["type": .string("user-message-rejected"), "ref": .string(ref), "reason": .string(reason)])
        }
    }
}

/// A failure's words, or tools.fullView.error ("Error") when it said
/// nothing.
public enum ToolFullError: Equatable, Sendable {
    case text(String)
    case unspecified

    init(_ text: String?) {
        if let text, !text.isEmpty { self = .text(text) } else { self = .unspecified }
    }
}

/// CommandView on the tool's screen: what it ran and everything it said.
public struct ToolFullTerminal: Equatable, Sendable {
    /// The command, or the activity label when there is none.
    public var command: String
    /// "$ " before a command; nothing before a label.
    public var prompt: Bool
    /// Shown only when there is more than whitespace.
    public var stdout: String?
    public var stderr: String?
    public var error: ToolFullError?
    /// No "[Command completed with no output]" while it is running.
    public var hideEmptyOutput: Bool

    public init(command: String, prompt: Bool, stdout: String?, stderr: String?, error: ToolFullError?, hideEmptyOutput: Bool) {
        self.command = command
        self.prompt = prompt
        self.stdout = stdout
        self.stderr = stderr
        self.error = error
        self.hideEmptyOutput = hideEmptyOutput
    }

    /// The output lines CommandView draws (`stdout && stdout.trim()`).
    public var visibleStdout: String? { Self.visible(stdout) }
    public var visibleStderr: String? { Self.visible(stderr) }

    /// "[Command completed with no output]": nothing at all came back,
    /// not even whitespace.
    public var showsEmptyOutput: Bool {
        (stdout ?? "").isEmpty && (stderr ?? "").isEmpty && error == nil && !hideEmptyOutput
    }

    private static func visible(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    /// toolResult.ts `getTerminalToolResult`: Happy's result is text, but
    /// CLI providers may still send stdout and stderr in an object.
    struct Result {
        var stdout: String?
        var stderr: String?
        var error: String?

        init(_ tool: ToolCall) {
            let result = tool.result
            let record = result?.objectValue
            let structured = record.map { record in ["stdout", "stderr", "output"].contains { record[$0]?.stringValue != nil } } ?? false
            if structured, let record {
                stdout = record["stdout"]?.stringValue ?? record["output"]?.stringValue
                stderr = record["stderr"]?.stringValue
            } else {
                stdout = tool.state == .completed ? ToolFullPresentation.resultText(result) : nil
                stderr = nil
            }
            if tool.state == .error {
                let source = record?["error"].flatMap { $0 == .null ? nil : $0 } ?? result
                error = ToolFullPresentation.resultText(source)
            } else {
                error = nil
            }
        }
    }
}

/// ToolFullView's fallback sections, each nil when it isn't shown.
public struct ToolFullGeneric: Equatable, Sendable {
    /// `tool.description || getToolDisplayTitle(tool)`, shown when the
    /// call has a description or a title.
    public var description: String?
    /// The input as JSON.
    public var input: String?
    public var output: String?
    public var error: String?
    /// "Tool completed successfully" / "No output was produced".
    public var completedWithoutOutput: Bool

    public init(_ tool: ToolCall, words: ToolActionWords) {
        let describedBy = [tool.description, tool.title].compactMap { $0 }.first { !$0.isEmpty }
        description = describedBy == nil ? nil : (tool.description.flatMap { $0.isEmpty ? nil : $0 } ?? ChatToolDisplay.displayTitle(tool, words: words))
        input = tool.input == .null ? nil : ChatToolPresentation.pretty(tool.input)
        let hasResult = ChatToolPresentation.truthy(tool.result)
        output = tool.state == .completed && hasResult ? ToolFullPresentation.resultText(tool.result) : nil
        error = tool.state == .error && hasResult ? ToolFullPresentation.resultText(tool.result) : nil
        completedWithoutOutput = tool.state == .completed && !hasResult
    }
}
