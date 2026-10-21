import Foundation
import HappyWire

// How ToolView.tsx draws one tool call: a one-line activity row, a card
// with a header and the tool's own view, or a bare attachment; its title,
// subtitle, icon and status glyph; and what goes in the card. A port of
// ToolView.tsx's decisions and of the knownTools table (knownTools.tsx), with
// the copy left to the UI as `ToolText`.
//
// One deliberate difference from happy-app: a tool's body (its view, its
// error, its raw input and output) is collapsed by default, and only the
// header shows. Tapping the header opens it (`ToolDisplayState.expanded`).
// While the person has to decide something (a pending permission, a running
// question), what they need to decide is open, but never the output.

/// Copy a tool's header shows, resolved to strings by the UI (en.ts
/// `tools.names` / `tools.desc` / `tools.askUserQuestion`).
public enum ToolText: Equatable, Sendable {
    case literal(String)
    case name(ToolName)
    /// tools.desc.multiEditEdits: "path (N edits)"
    case multiEditEdits(path: String, count: Int)
    /// tools.desc.modifyingMultipleFiles: "file and N more"
    case modifyingMultipleFiles(file: String, count: Int)
    /// tools.askUserQuestion.multipleQuestions: "N questions"
    case multipleQuestions(Int)
}

/// en.ts `tools.names`.
public enum ToolName: String, Equatable, Sendable, CaseIterable {
    case task, terminal, searchFiles, search, searchContent, listFiles, planProposal, readFile, editFile, writeFile
    case fetchUrl, readNotebook, editNotebook, todoList, webSearch, reasoning, applyChanges, viewDiff, question
}

/// The header glyph (knownTools' ICON_* and ToolView's fallbacks).
public enum ToolIcon: Equatable, Sendable {
    case task, terminal, search, read, edit, web, exit, todo, reasoning, question
    /// An MCP tool: extension-puzzle-outline, secondary.
    case mcp
    /// No category: construct-outline, secondary.
    case generic
}

/// The tool-specific views of views/_all.tsx `toolViewRegistry`.
public enum ToolViewKind: Equatable, Sendable {
    case edit, bash, codexBash, codexPatch, codexDiff, write, todo, exitPlan, multiEdit, task
    case askUserQuestion, requestUserInput, geminiEdit, geminiExecute, file

    static let registry: [String: ToolViewKind] = [
        "Edit": .edit, "Bash": .bash, "CodexBash": .codexBash, "CodexPatch": .codexPatch, "CodexDiff": .codexDiff,
        "Write": .write, "write": .write, "search_replace": .edit, "TodoWrite": .todo,
        "ExitPlanMode": .exitPlan, "exit_plan_mode": .exitPlan, "MultiEdit": .multiEdit, "Task": .task, "Agent": .task,
        "AskUserQuestion": .askUserQuestion, "request_user_input": .requestUserInput,
        "edit": .geminiEdit, "execute": .geminiExecute, "GeminiDiff": .codexDiff, "GeminiPatch": .codexPatch,
        "apply_patch": .codexPatch, "file": .file,
    ]

    public init?(toolName: String) {
        guard let kind = Self.registry[toolName] else { return nil }
        self = kind
    }

    /// Whether the view draws anything for this call (several return null
    /// for an empty input).
    public func hasContent(_ tool: ToolCall, children: [ChatMessage]) -> Bool {
        let input = tool.input
        switch self {
        case .todo:
            return !(input["todos"]?.arrayValue ?? []).isEmpty || !(tool.result?["newTodos"]?.arrayValue ?? []).isEmpty
        case .task:
            return children.contains { child in
                guard case .toolCall(let call) = child else { return false }
                return !ChatToolDisplay.isHidden(call.tool.name)
            }
        case .multiEdit:
            return !(input["edits"]?.arrayValue ?? []).isEmpty
        case .codexDiff:
            return input["unified_diff"]?.stringValue != nil
        case .geminiExecute:
            guard let title = input["toolCall"]?["title"]?.stringValue else { return false }
            return !title.isEmpty
        default:
            return true
        }
    }
}

extension ToolPresentation.Body {
    /// What a decision needs: the input, never the result or an error.
    var inputOnly: ToolPresentation.Body {
        switch self {
        case .none, .error: .none
        case .view(let kind, _): .view(kind, error: nil)
        case .raw(let input, _): input.map { .raw(input: $0, output: nil) } ?? .none
        }
    }
}

/// What the reader has done to one tool row.
public struct ToolDisplayState: Equatable, Sendable {
    /// They tapped its header open.
    public var expanded: Bool

    public init(expanded: Bool = false) {
        self.expanded = expanded
    }
}

public struct ToolPresentation: Equatable, Sendable {
    public enum Form: Equatable, Sendable {
        /// The one-line activity row.
        case compact
        /// A card: header, the tool's view, the permission buttons.
        case card
        /// A user attachment: the picture alone, no card.
        case inline
    }

    public enum StatusGlyph: Equatable, Sendable {
        /// The tool is running.
        case spinner
        /// Denied, canceled, or refused before it ran (remove-circle-outline).
        case stopped
        /// Failed (alert-circle-outline).
        case failed
    }

    /// What a card shows under its header.
    public enum Body: Equatable, Sendable {
        case none
        /// The tool's own view, then its error when it failed.
        case view(ToolViewKind, error: String?)
        /// ToolError alone.
        case error(String)
        /// The fallback: INPUT as JSON, OUTPUT once it completed.
        case raw(input: String?, output: String?)
    }

    public var form: Form
    public var title: ToolText
    /// extractStatus: a dimmed suffix after the title.
    public var status: ToolText?
    /// extractSubtitle: the line under the title.
    public var subtitle: ToolText?
    public var icon: ToolIcon
    public var statusGlyph: StatusGlyph?
    /// The running timer.
    public var showsElapsed: Bool
    /// Every row has a header but an attachment.
    public var showsHeader: Bool
    /// What shows under the header now: nothing while collapsed, unless a
    /// decision is waiting on what it shows.
    public var body: Body
    /// What tapping the header open shows; `.none` when there is nothing
    /// to open, and the header opens the tool's screen instead.
    public var expandedBody: Body
    /// A pending permission or a running question: the input stays open.
    public var awaitingDecision: Bool
    public var showsPermissionFooter: Bool
    /// The compact row's label.
    public var activityLabel: String
    /// Edit, MultiEdit and Write open the file; everything else the message.
    public var opensFile: String?
}

/// What ToolView knows about the session around a tool.
public struct ToolContext: Equatable, Sendable {
    /// metadata.path: paths under it are shown relative to it.
    public var root: String?
    public var flavor: String?
    /// settings.compactToolCalls
    public var compactMode: Bool

    public init(root: String? = nil, flavor: String? = nil, compactMode: Bool = false) {
        self.root = root
        self.flavor = flavor
        self.compactMode = compactMode
    }
}

public enum ChatToolPresentation {
    static let minimalNames: Set<String> = [
        "Bash", "Glob", "Grep", "LS", "Read", "read", "WebFetch", "NotebookRead", "WebSearch", "CodexBash",
        "CodexReasoning", "GeminiReasoning", "think", "change_title", "search", "shell", "GeminiBash", "GeminiPatch", "Skill",
    ]
    static let noStatusNames: Set<String> = [
        "TodoWrite", "change_title", "CodexDiff", "GeminiDiff", "AskUserQuestion", "request_user_input",
    ]
    static let hideDefaultErrorNames: Set<String> = [
        "Bash", "CodexBash", "CodexPatch", "apply_patch", "GeminiBash", "GeminiPatch", "CodexDiff", "GeminiDiff",
    ]
    /// Every name with a knownTools entry.
    static let knownNames: Set<String> = minimalNames.union(noStatusNames).union(hideDefaultErrorNames).union([
        "Task", "Agent", "ExitPlanMode", "exit_plan_mode", "Edit", "MultiEdit", "Write", "NotebookEdit", "edit", "execute",
        "ToolSearch", "tool_search",
    ])
    static let fileEditNames: Set<String> = ["Edit", "MultiEdit", "Write"]

    /// `nil` for a tool that renders as nothing.
    public static func present(
        _ tool: ToolCall, children: [ChatMessage] = [], context: ToolContext, state: ToolDisplayState = ToolDisplayState(), words: ToolActionWords
    ) -> ToolPresentation? {
        let name = tool.name
        if ChatToolDisplay.isHidden(name) { return nil }
        let known = knownNames.contains(name)

        var minimal = !known && context.flavor == "gemini"
        var title = ToolText.literal(ChatToolDisplay.displayTitle(tool, words: words))
        var icon = categoryIcon(name)
        if name.hasPrefix("mcp__") {
            title = .literal(ChatToolDisplay.mcpTitle(name))
            icon = .mcp
            minimal = true
        } else if let knownTitle = knownTitle(tool, root: context.root) {
            title = knownTitle
        }
        let subtitle = self.subtitle(tool, root: context.root)
        if known, let knownMinimal = knownMinimal(tool, children: children) {
            minimal = knownMinimal
        }
        if name == "CodexBash", let first = tool.input["parsed_cmd"]?.arrayValue?.first {
            switch first["type"]?.stringValue {
            case "read": icon = .read
            case "write": icon = .edit
            default: icon = .terminal
            }
        } else if let knownIcon = knownIcon(name) {
            icon = knownIcon
        }
        let noStatus = noStatusNames.contains(name)
        var hideDefaultError = hideDefaultErrorNames.contains(name)

        let isToolUseError = tool.state == .error && toolUseError(tool.result?.stringValue) != nil
        let stoppedByPermission = tool.permission?.status == .denied || tool.permission?.status == .canceled
        var statusGlyph: ToolPresentation.StatusGlyph?
        if stoppedByPermission {
            statusGlyph = .stopped
        } else if isToolUseError {
            statusGlyph = .stopped
            hideDefaultError = true
            minimal = true
        } else {
            switch tool.state {
            case .running: statusGlyph = noStatus ? nil : .spinner
            case .completed: statusGlyph = nil
            case .error: statusGlyph = .failed
            }
        }

        let view = ToolViewKind(toolName: name)
        let needsApprovalInput = tool.permission?.status == .pending && view == nil
        let compact = !needsApprovalInput && (
            ChatToolDisplay.usesCompactRow(tool, compactMode: context.compactMode, hasInlineView: view != nil)
                || minimal
                || ChatToolDisplay.terminalCommand(tool) != nil
        )
        let form: ToolPresentation.Form = compact ? .compact : name == "file" ? .inline : .card

        // What ToolView draws in the card. A compact row has none in
        // happy-app; here it opens to the same body as the card would.
        let errorText = tool.state == .error && truthy(tool.result) && !stoppedByPermission ? tool.result.map(resultText) : nil
        var full = ToolPresentation.Body.none
        if let view {
            let error = hideDefaultError ? nil : errorText
            if view.hasContent(tool, children: children) || error != nil { full = .view(view, error: error) }
        } else if let errorText, !isToolUseError {
            full = .error(errorText)
        } else {
            let input = truthy(tool.input) ? pretty(tool.input) : nil
            let output = tool.state == .completed && truthy(tool.result) ? tool.result.map { $0.stringValue ?? pretty($0) } : nil
            if input != nil || output != nil { full = .raw(input: input, output: output) }
        }

        let awaitingDecision = tool.permission?.status == .pending
            || (ChatToolDisplay.isInteractiveQuestion(name) && tool.state == .running)
        let body: ToolPresentation.Body
        if form == .inline || state.expanded {
            // An attachment is the person's own picture, not tool output.
            body = full
        } else if awaitingDecision {
            body = full.inputOnly
        } else {
            body = .none
        }

        let filePath = fileEditNames.contains(name) ? tool.input["file_path"]?.stringValue : nil
        return ToolPresentation(
            form: form,
            title: title,
            status: status(tool, root: context.root),
            subtitle: subtitle,
            icon: icon,
            statusGlyph: statusGlyph,
            showsElapsed: tool.state == .running,
            // The header is what opens and closes the body, so even a patch,
            // which heads each file itself in happy-app, keeps it.
            showsHeader: form != .inline,
            body: body,
            expandedBody: form == .inline ? .none : full,
            awaitingDecision: awaitingDecision,
            showsPermissionFooter: tool.permission != nil && name != "AskUserQuestion",
            activityLabel: ChatToolDisplay.activityLabel(tool, words: words),
            opensFile: filePath
        )
    }

    // MARK: knownTools

    static func knownTitle(_ tool: ToolCall, root: String?) -> ToolText? {
        let input = tool.input
        func path(_ value: JSONValue?) -> String? { value?.stringValue.map { resolvePath($0, root: root) } }
        switch tool.name {
        case "Task", "Agent":
            if let description = input["description"]?.stringValue, !description.isEmpty { return .literal(description) }
            return .name(.task)
        case "Bash":
            if let description = tool.description, !description.isEmpty { return .literal(description) }
            return .name(.terminal)
        case "Glob":
            return input["pattern"]?.stringValue.map(ToolText.literal) ?? .name(.searchFiles)
        case "Grep":
            return input["pattern"]?.stringValue.map { .literal("grep(pattern: \($0))") } ?? .literal("Search Content")
        case "LS":
            return path(input["path"]).map(ToolText.literal) ?? .name(.listFiles)
        case "ExitPlanMode", "exit_plan_mode":
            return .name(.planProposal)
        case "Read":
            if let file = path(input["file_path"]) { return .literal(file) }
            if let location = locationPath(input), let file = path(.string(location)) { return .literal(file) }
            return .name(.readFile)
        case "read":
            if let location = locationPath(input), let file = path(.string(location)) { return .literal(file) }
            if let file = path(input["file_path"]) { return .literal(file) }
            return .name(.readFile)
        case "Edit":
            return path(input["file_path"]).map(ToolText.literal) ?? .name(.editFile)
        case "MultiEdit":
            guard let file = path(input["file_path"]) else { return .name(.editFile) }
            let count = input["edits"]?.arrayValue?.count ?? 0
            return count > 1 ? .multiEditEdits(path: file, count: count) : .literal(file)
        case "Write":
            return path(input["file_path"]).map(ToolText.literal) ?? .name(.writeFile)
        case "WebFetch":
            guard let url = input["url"]?.stringValue, let host = hostname(url) else { return .name(.fetchUrl) }
            return .literal(host)
        case "NotebookRead":
            return path(input["notebook_path"]).map(ToolText.literal) ?? .name(.readNotebook)
        case "NotebookEdit":
            return path(input["notebook_path"]).map(ToolText.literal) ?? .name(.editNotebook)
        case "TodoWrite":
            return .name(.todoList)
        case "WebSearch":
            return input["query"]?.stringValue.map(ToolText.literal) ?? .name(.webSearch)
        case "CodexBash":
            if let parsed = input["parsed_cmd"]?.arrayValue, parsed.count == 1, parsed[0]["type"]?.stringValue == "read",
               let name = parsed[0]["name"]?.stringValue, !name.isEmpty {
                return .literal(resolvePath(name, root: root))
            }
            return .name(.terminal)
        case "CodexReasoning", "GeminiReasoning", "think":
            if let title = input["title"]?.stringValue, !title.isEmpty { return .literal(title) }
            return .name(.reasoning)
        case "change_title":
            return .literal("Change Title")
        case "search":
            return .name(.search)
        case "edit":
            var file: String?
            if let first = input["toolCall"]?["content"]?.arrayValue?.first?["path"]?.stringValue, !first.isEmpty {
                file = first
            } else if let title = input["toolCall"]?["title"]?.stringValue, !title.isEmpty {
                return .literal(title)
            } else if let first = input["input"]?.arrayValue?.first?["path"]?.stringValue, !first.isEmpty {
                file = first
            } else if let direct = input["path"]?.stringValue {
                file = direct
            }
            if let file, !file.isEmpty { return .literal(resolvePath(file, root: root)) }
            return .name(.editFile)
        case "shell", "GeminiBash":
            return .name(.terminal)
        case "execute":
            guard let title = input["toolCall"]?["title"]?.stringValue, !title.isEmpty else { return .name(.terminal) }
            if let bracket = title.range(of: " ["), bracket.lowerBound > title.startIndex {
                return .literal(String(title[..<bracket.lowerBound]))
            }
            return .literal(title)
        case "CodexPatch", "apply_patch", "GeminiPatch":
            return .name(.applyChanges)
        case "CodexDiff", "GeminiDiff":
            return .name(.viewDiff)
        case "AskUserQuestion":
            if let header = input["questions"]?.arrayValue?.first?["header"]?.stringValue, !header.isEmpty { return .literal(header) }
            return .name(.question)
        case "request_user_input":
            if let header = firstUserInputQuestion(input)?["header"]?.stringValue { return .literal(header) }
            return .name(.question)
        default:
            return nil
        }
    }

    /// extractSubtitle, when it gives a non-empty string.
    static func subtitle(_ tool: ToolCall, root: String?) -> ToolText? {
        let input = tool.input
        let value: ToolText?
        switch tool.name {
        case "Bash":
            value = input["command"]?.stringValue.map(ToolText.literal)
        case "CodexBash":
            let parsed = input["parsed_cmd"]?.arrayValue ?? []
            if parsed.count == 1, parsed[0]["type"]?.stringValue == "read", let command = parsed[0]["cmd"]?.stringValue, !command.isEmpty {
                value = .literal(command.count > 50 ? String(command.prefix(50)) + "..." : command)
            } else if let command = parsed.first?["cmd"]?.stringValue, !command.isEmpty {
                value = .literal(command)
            } else {
                value = ChatToolDisplay.stringifyCommand(input["command"]).map(ToolText.literal)
            }
        case "execute":
            value = input["toolCall"]?["title"]?.stringValue.flatMap(trailingParenthesis).map(ToolText.literal)
        case "CodexPatch", "apply_patch":
            value = patchSubtitle(ChatPatch.files(input), root: root)
        case "GeminiPatch":
            value = patchSubtitle(input["changes"]?.objectValue.map { $0.keys.sorted() } ?? [], root: root)
        case "GeminiBash":
            value = ChatToolDisplay.stringifyCommand(input["command"]).map(ToolText.literal)
        case "CodexDiff":
            value = diffFileName(input["unified_diff"]?.stringValue).map(ToolText.literal)
        case "GeminiDiff":
            if let path = input["filePath"]?.stringValue, !path.isEmpty {
                value = .literal(basename(path))
            } else {
                value = diffFileName(input["unified_diff"]?.stringValue).map(ToolText.literal)
            }
        case "AskUserQuestion":
            guard let questions = input["questions"]?.arrayValue else { return nil }
            value = questions.count == 1 ? questions[0]["question"]?.stringValue.map(ToolText.literal) : .multipleQuestions(questions.count)
        case "request_user_input":
            value = firstUserInputQuestion(input)?["question"]?.stringValue.map(ToolText.literal)
        default:
            value = nil
        }
        if case .literal(let text) = value, text.isEmpty { return nil }
        return value
    }

    /// extractStatus (MultiEdit only).
    static func status(_ tool: ToolCall, root: String?) -> ToolText? {
        guard tool.name == "MultiEdit", let file = tool.input["file_path"]?.stringValue else { return nil }
        let path = resolvePath(file, root: root)
        let count = tool.input["edits"]?.arrayValue?.count ?? 0
        if count > 0 { return .multiEditEdits(path: path, count: count) }
        return path.isEmpty ? nil : .literal(path)
    }

    /// knownTools `minimal`, where the entry sets it.
    static func knownMinimal(_ tool: ToolCall, children: [ChatMessage]) -> Bool? {
        switch tool.name {
        case _ where minimalNames.contains(tool.name):
            return true
        case "Task", "Agent":
            return !children.contains { if case .toolCall = $0 { return true } else { return false } }
        case "TodoWrite":
            let todos = tool.input["todos"]?.arrayValue ?? []
            let newTodos = tool.result?["newTodos"]?.arrayValue ?? []
            return todos.isEmpty && newTodos.isEmpty
        case "execute":
            if let title = tool.input["toolCall"]?["title"]?.stringValue, !title.trimmed.isEmpty { return false }
            let command = tool.input["command"]
            if let string = command?.stringValue, !string.trimmed.isEmpty { return false }
            if let parts = command?.arrayValue, parts.contains(where: { !($0.stringValue?.trimmed.isEmpty ?? true) }) { return false }
            return true
        case "CodexPatch", "apply_patch", "CodexDiff", "GeminiDiff", "AskUserQuestion", "request_user_input":
            return false
        default:
            return nil
        }
    }

    static func knownIcon(_ name: String) -> ToolIcon? {
        switch name {
        case "Task", "Agent", "Skill": .task
        case "Bash", "CodexBash", "shell", "execute", "GeminiBash": .terminal
        case "Glob", "LS", "search", "ToolSearch", "tool_search": .search
        case "Grep", "Read", "read", "NotebookRead": .read
        case "ExitPlanMode", "exit_plan_mode": .exit
        case "Edit", "MultiEdit", "Write", "NotebookEdit", "change_title", "edit", "CodexPatch", "apply_patch", "GeminiPatch", "CodexDiff", "GeminiDiff": .edit
        case "WebFetch", "WebSearch": .web
        case "TodoWrite": .todo
        case "CodexReasoning", "GeminiReasoning", "think": .reasoning
        case "AskUserQuestion", "request_user_input": .question
        default: nil
        }
    }

    /// getToolCategoryIcon, or the generic glyph.
    static func categoryIcon(_ name: String) -> ToolIcon {
        switch ChatToolDisplay.category(name) {
        case .terminal: .terminal
        case .read: .read
        case .edit: .edit
        case .search: .search
        case .web: .web
        case .task: .task
        case .other: .generic
        }
    }

    // MARK: Helpers

    /// pathUtils `resolvePath`: a path under the session's root, relative
    /// to it; the root itself as `<root>`.
    public static func resolvePath(_ path: String, root: String?) -> String {
        guard let root, path.lowercased().hasPrefix(root.lowercased()) else { return path }
        let remainder = String(path.dropFirst(root.count))
        guard remainder.isEmpty || remainder.hasPrefix("/") else { return path }
        let relative = remainder.hasPrefix("/") ? String(remainder.dropFirst()) : remainder
        return relative.isEmpty ? "<root>" : relative
    }

    /// The message inside `<tool_use_error>…</tool_use_error>`, if any
    /// (toolErrorParser `parseToolUseError`).
    public static func toolUseError(_ message: String?) -> String? {
        guard let message, let open = message.range(of: "<tool_use_error>"),
              let close = message.range(of: "</tool_use_error>", range: open.upperBound..<message.endIndex) else { return nil }
        return String(message[open.upperBound..<close.lowerBound]).trimmed
    }

    /// `JSON.stringify(value, null, 2)`, keys sorted (happy-app keeps the
    /// order they arrived in, which a decoded dictionary no longer has).
    public static func pretty(_ value: JSONValue, indent: String = "") -> String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return ChatToolDisplay.formatNumber(number)
        case .string(let string): return quoted(string)
        case .array(let items):
            if items.isEmpty { return "[]" }
            let inner = indent + "  "
            return "[\n" + items.map { inner + pretty($0, indent: inner) }.joined(separator: ",\n") + "\n\(indent)]"
        case .object(let object):
            if object.isEmpty { return "{}" }
            let inner = indent + "  "
            let entries = object.keys.sorted().map { inner + quoted($0) + ": " + pretty(object[$0]!, indent: inner) }
            return "{\n" + entries.joined(separator: ",\n") + "\n\(indent)}"
        }
    }

    static func quoted(_ string: String) -> String {
        var result = "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case "\n": result += "\\n"
            case "\r": result += "\\r"
            case "\t": result += "\\t"
            case "\u{08}": result += "\\b"
            case "\u{0C}": result += "\\f"
            case _ where scalar.value < 0x20:
                result += String(format: "\\u%04x", scalar.value)
            default:
                result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    /// `String(tool.result)` for ToolError: the text, or the value as JSON.
    static func resultText(_ value: JSONValue) -> String {
        value.stringValue ?? pretty(value)
    }

    /// JavaScript truthiness, for `tool.result && …`.
    static func truthy(_ value: JSONValue?) -> Bool {
        switch value {
        case nil, .null?: false
        case .bool(let flag)?: flag
        case .number(let number)?: number != 0 && !number.isNaN
        case .string(let string)?: !string.isEmpty
        default: true
        }
    }

    static func locationPath(_ input: JSONValue) -> String? {
        guard let path = input["locations"]?.arrayValue?.first?["path"]?.stringValue, !path.isEmpty else { return nil }
        return path
    }

    static func firstUserInputQuestion(_ input: JSONValue) -> JSONValue? {
        let body = input["input"].flatMap { $0 == .null ? nil : $0 } ?? input
        if let questions = body["questions"]?.arrayValue { return questions.first }
        return body
    }

    static func hostname(_ url: String) -> String? {
        guard let components = URLComponents(string: url), components.scheme != nil, let host = components.host else { return nil }
        return host.lowercased()
    }

    /// `/\(([^)]+)\)$/`: the text in the parentheses that close the title.
    public static func trailingParenthesis(_ title: String) -> String? {
        guard title.hasSuffix(")") else { return nil }
        let body = title.dropLast()
        let tail = body.lastIndex(of: ")").map { body[body.index(after: $0)...] } ?? body
        guard let open = tail.firstIndex(of: "(") else { return nil }
        let inner = tail[tail.index(after: open)...]
        return inner.isEmpty ? nil : String(inner)
    }

    static func patchSubtitle(_ files: [String], root: String?) -> ToolText? {
        guard let first = files.first else { return nil }
        let name = basename(resolvePath(first, root: root))
        return files.count > 1 ? .modifyingMultipleFiles(file: name, count: files.count - 1) : .literal(name)
    }

    static func diffFileName(_ diff: String?) -> String? {
        guard let diff else { return nil }
        for line in diff.components(separatedBy: "\n") where line.hasPrefix("+++ ") {
            var name = String(line.dropFirst(4))
            if name.hasPrefix("b/") { name.removeFirst(2) }
            return basename(name)
        }
        return nil
    }

    static func basename(_ path: String) -> String {
        let last = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
        return last.isEmpty ? path : last
    }
}
