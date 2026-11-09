import Foundation
import HappyWire

/// What a Happy Agent tool call did, decided for its own screen: the
/// daemon's typed `presentation` first (a terminal, a diff, the reads of an
/// exploration, a search), then the raw `arguments` and `result` read by
/// what the tool is (happy-providers' and happy-agent-modules' schemas),
/// and for anything else the arguments as labelled fields. JSON is shown
/// only for a value too deep to lay out as fields. Pure: built off the
/// main thread, its words are the screen's.
public struct ToolDetail: Equatable, Sendable {
    public enum Status: Equatable, Sendable { case running, completed, failed }

    /// What heads the screen, after desktop's `ToolCallPreview` titles.
    public enum Kind: Equatable, Sendable {
        case terminal, fileEdit, exploration, search, web, subagent, plan, message, question, compaction, media, tool
    }

    /// A section's heading, in the screen's words.
    public enum Title: Equatable, Sendable {
        case command, input, output, result, error, arguments, prompt, message, description, content, plan,
             explanation, sources, operations, questions, patch, files, review
    }

    public struct Field: Equatable, Sendable {
        public var label: String
        public var value: Value

        public init(_ label: String, _ value: Value) {
            self.label = label
            self.value = value
        }
    }

    public indirect enum Value: Equatable, Sendable {
        /// Short prose on the label's line when it fits.
        case text(String)
        /// A path, command, ID or pattern: monospaced.
        case mono(String)
        /// A number, a switch or null, quiet on the label's line.
        case scalar(String)
        /// Several lines: a block under the label.
        case block(String)
        case link(String)
        case list([Value])
        case fields([Field])
        /// A value nested too deep to lay out: pretty JSON.
        case json(String)
    }

    /// One file's change: the daemon's hunks as a unified patch, or both
    /// sides of an edit still running.
    public struct FileChange: Equatable, Sendable {
        public enum Source: Equatable, Sendable {
            case patch(String)
            case pair(old: String, new: String)
        }

        public var path: String
        /// `add`, `delete` or `update`.
        public var kind: String
        public var added: Int
        public var deleted: Int
        public var source: Source?
        public var omittedLines: Int

        public init(path: String, kind: String, added: Int, deleted: Int, source: Source?, omittedLines: Int = 0) {
            self.path = path; self.kind = kind; self.added = added; self.deleted = deleted; self.source = source; self.omittedLines = omittedLines
        }
    }

    public struct Operation: Equatable, Sendable {
        /// `list`, `read` or `search`.
        public var kind: String
        public var subject: String
        public var detail: String?

        public init(kind: String, subject: String, detail: String? = nil) {
            self.kind = kind; self.subject = subject; self.detail = detail
        }
    }

    public struct Todo: Equatable, Sendable {
        public enum State: Equatable, Sendable { case pending, active, done, cancelled }
        public var text: String
        public var state: State

        public init(_ text: String, _ state: State) {
            self.text = text
            self.state = state
        }

        static func state(_ raw: String?) -> State {
            switch raw?.lowercased() {
            case "completed", "done", "complete": .done
            case "in_progress", "in-progress", "active", "running": .active
            case "cancelled", "canceled", "deleted": .cancelled
            default: .pending
            }
        }
    }

    public struct Link: Equatable, Sendable {
        public var title: String
        public var url: String

        public init(title: String, url: String) {
            self.title = title
            self.url = url
        }
    }

    public struct Question: Equatable, Sendable {
        public var header: String?
        public var question: String
        public var answers: [String]

        public init(header: String?, question: String, answers: [String]) {
            self.header = header; self.question = question; self.answers = answers
        }
    }

    public enum Section: Equatable, Sendable {
        /// A shell command and what it printed; nil output while it runs.
        case terminal(command: String, output: String?, prompt: Bool)
        case files([FileChange], omittedFiles: Int)
        case operations([Operation])
        case fields(Title?, [Field])
        /// Prose: a prompt, a message, an explanation.
        case text(Title, String)
        /// Monospaced text: a file read, a search's matches, a patch.
        case code(Title, String, path: String?)
        case checklist(Title, [Todo])
        case links([Link])
        case questions([Question])
        case error(String)
        case review(AgentWire.ToolReview)
    }

    public var kind: Kind
    /// The tool as named (`humanize`).
    public var toolName: String
    public var status: Status
    public var sections: [Section]
    /// The screen should read the whole call: its raw data is missing or
    /// was cut short on the phone, and the computer has it.
    public var wantsFullData: Bool

    /// `full` is the call's raw data read whole from the computer, which
    /// takes the place of what the phone kept.
    public init(_ tool: ChatItem.Tool, full: (arguments: JSONValue?, result: JSONValue?)? = nil) {
        let arguments = full?.arguments ?? tool.arguments
        let result = full?.result ?? tool.result
        status = tool.failed ? .failed : tool.running ? .running : .completed
        toolName = Self.humanize(tool.name)
        var builder = Builder(name: tool.name, arguments: arguments?.objectValue ?? [:], result: result, status: status)
        kind = builder.build(tool.presentation)
        sections = builder.sections
        if let review = tool.review { sections.append(.review(review)) }
        let complete = tool.presentation.map { ToolRaw.complete.contains($0.type) } ?? false
        wantsFullData = full == nil && !complete && !tool.running
            && (tool.arguments == nil || ToolRaw.isCut(tool.arguments) || ToolRaw.isCut(tool.result) || tool.result == nil)
    }

    // MARK: Names

    /// desktop's `humanize`: `run_terminal_command` → "Run terminal
    /// command", `mcp__github__create_issue` → "github · create issue".
    public static func humanize(_ name: String) -> String {
        if name.hasPrefix("mcp__") {
            let parts = name.components(separatedBy: "__").filter { !$0.isEmpty }
            if parts.count >= 3 { return "\(parts[1]) · \(humanize(parts[2...].joined(separator: " ")).lowercased())" }
        }
        var text = name.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// A field's label from its argument key.
    public static func label(_ key: String) -> String {
        if let known = labels[key] { return known }
        return humanize(key)
    }

    static let labels: [String: String] = [
        "cmd": "Command", "file_path": "File", "target_file": "File", "target_directory": "Folder", "path": "Path",
        "workdir": "Working directory", "cwd": "Working directory", "url": "URL", "-A": "Lines after", "-B": "Lines before",
        "-C": "Context lines", "-i": "Ignore case", "-n": "Line numbers", "timeout_ms": "Timeout (ms)", "timeout": "Timeout",
        "agentId": "Agent", "agent_id": "Agent", "task_name": "Task", "subagent_type": "Subagent type", "reasoning_effort": "Effort",
        "run_in_background": "In background", "replace_all": "Replace all", "output_mode": "Output", "head_limit": "Limit",
    ]

    /// Keys that say most about a call come first; the rest follow by name.
    static let order = [
        "title", "subject", "description", "task_name", "name", "command", "cmd", "chars", "file_path", "target_file", "path", "target_directory",
        "pattern", "query", "url", "to", "target", "agentId", "model", "provider",
    ]

    static func ordered(_ object: [String: JSONValue]) -> [(String, JSONValue)] {
        object.sorted { lhs, rhs in
            let left = order.firstIndex(of: lhs.key) ?? Int.max
            let right = order.firstIndex(of: rhs.key) ?? Int.max
            return left != right ? left < right : lhs.key < rhs.key
        }
    }

    // MARK: Values

    /// A raw value as a field's value: strings by their shape, objects as
    /// nested fields, lists of scalars as a list, and anything nested
    /// past `depth` as JSON.
    public static func value(_ json: JSONValue, key: String = "", depth: Int = 0) -> Value {
        switch json {
        case .null: return .scalar("null")
        case .bool(let flag): return .scalar(flag ? "true" : "false")
        case .number(let number): return .scalar(format(number))
        case .string(let text):
            if text.contains("\n") || text.count > 120 { return .block(text) }
            if isLink(text) { return .link(text) }
            if monoKeys.contains(key) || looksLikePath(text) { return .mono(text) }
            return .text(text)
        case .array(let items):
            if items.isEmpty { return .scalar("[]") }
            if depth >= 2 || items.count > 50 { return .json(pretty(json)) }
            return .list(items.map { value($0, key: key, depth: depth + 1) })
        case .object(let object):
            if object.isEmpty { return .scalar("{}") }
            if depth >= 2 { return .json(pretty(json)) }
            return .fields(ordered(object).map { Field(label($0.0), value($0.1, key: $0.0, depth: depth + 1)) })
        }
    }

    static let monoKeys: Set<String> = [
        "command", "cmd", "file_path", "target_file", "target_directory", "path", "pattern", "glob", "workdir", "cwd", "agentId", "agent_id",
        "id", "taskId", "task_id", "session_id", "model", "provider", "chars", "type", "name",
    ]

    static func format(_ number: Double) -> String {
        number.rounded() == number && abs(number) < 1e15 ? String(Int(number)) : String(number)
    }

    static func isLink(_ text: String) -> Bool {
        (text.hasPrefix("https://") || text.hasPrefix("http://")) && !text.contains(" ")
    }

    static func looksLikePath(_ text: String) -> Bool {
        !text.contains(" ") && (text.hasPrefix("/") || text.hasPrefix("./") || text.hasPrefix("~/"))
    }

    public static func pretty(_ json: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(json), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }

    /// What a raw result says, read as a person would: its `output` (or
    /// a text content list, as MCP results come), a string as it is, or
    /// fields. Output that is itself JSON is read as fields too.
    public enum ResultBody: Equatable, Sendable {
        case text(String)
        case fields([Field])
    }

    public static func resultBody(_ result: JSONValue?) -> ResultBody? {
        guard let result else { return nil }
        switch result {
        case .null: return nil
        case .string(let text): return textBody(text)
        case .object(let object):
            if let output = object["output"] {
                let rest = object.filter { $0.key != "output" && $0.value != .null }
                if rest.isEmpty { return resultBody(output) }
            }
            if let content = contentText(object["content"]), object.count <= 2 { return textBody(content) }
            if case .fields(let fields) = value(result) { return fields.isEmpty ? nil : .fields(fields) }
            return .text(pretty(result))
        case .array:
            if let content = contentText(result) { return textBody(content) }
            if case .list(let items) = value(result) { return .fields(items.enumerated().map { Field("\($0.offset + 1)", $0.element) }) }
            return .text(pretty(result))
        default:
            if case .scalar(let text) = value(result) { return .text(text) }
            return nil
        }
    }

    static func textBody(_ text: String) -> ResultBody? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let first = trimmed.first, first == "{" || first == "[", let data = trimmed.data(using: .utf8),
           let json = try? JSONDecoder().decode(JSONValue.self, from: data), json.objectValue != nil || json.arrayValue != nil {
            if let content = contentText(json) { return .text(content) }
            switch value(json) {
            case .fields(let fields): return .fields(fields)
            case .list(let items): return .fields(items.enumerated().map { Field("\($0.offset + 1)", $0.element) })
            default: break
            }
        }
        return .text(text)
    }

    /// `[{type: "text", text}]`, MCP's content list, as its text.
    static func contentText(_ json: JSONValue?) -> String? {
        guard let items = json?.arrayValue, !items.isEmpty else { return nil }
        var texts: [String] = []
        for item in items {
            guard item["type"]?.stringValue == "text", let text = item["text"]?.stringValue else { return nil }
            texts.append(text)
        }
        return texts.joined(separator: "\n\n")
    }

    /// A `result`'s error, when the call failed.
    static func errorText(_ result: JSONValue?) -> String? {
        if let error = result?["error"] {
            return error.stringValue ?? error["message"]?.stringValue ?? pretty(error)
        }
        switch resultBody(result) {
        case .text(let text)?: return text
        case .fields(let fields)?: return fields.map { "\($0.label): \(plain($0.value))" }.joined(separator: "\n")
        case nil: return nil
        }
    }

    static func plain(_ value: Value) -> String {
        switch value {
        case .text(let text), .mono(let text), .scalar(let text), .block(let text), .link(let text), .json(let text): text
        case .list(let items): items.map(plain).joined(separator: ", ")
        case .fields(let fields): fields.map { "\($0.label): \(plain($0.value))" }.joined(separator: ", ")
        }
    }

    // MARK: Building

    struct Builder {
        let name: String
        var arguments: [String: JSONValue]
        let result: JSONValue?
        let status: Status
        var sections: [Section] = []
        /// Argument keys already shown by a dedicated section.
        var used: Set<String> = []

        init(name: String, arguments: [String: JSONValue], result: JSONValue?, status: Status) {
            self.name = name
            self.arguments = arguments
            self.result = result
            self.status = status
        }

        func string(_ keys: String...) -> String? {
            for key in keys { if let text = arguments[key]?.stringValue, !text.isEmpty { return text } }
            return nil
        }

        mutating func take(_ keys: String...) -> String? {
            for key in keys {
                if let text = arguments[key]?.stringValue, !text.isEmpty {
                    used.insert(key)
                    return text
                }
            }
            return nil
        }

        mutating func build(_ presentation: AgentWire.Presentation?) -> Kind {
            if let presentation, let kind = fromPresentation(presentation) { return kind }
            return fromArguments()
        }

        // MARK: Presentations

        mutating func fromPresentation(_ presentation: AgentWire.Presentation) -> Kind? {
            switch presentation.type {
            case "exec_command":
                sections.append(.terminal(command: presentation.command ?? "", output: status == .running ? nil : presentation.output ?? Self.output(result), prompt: true))
                if status == .failed, presentation.output == nil, let error = ToolDetail.errorText(result) { sections.append(.error(error)) }
                return .terminal
            case "background_terminal_interaction":
                sections.append(.terminal(command: presentation.input ?? "", output: nil, prompt: false))
                if let command = presentation.command, !command.isEmpty { sections.append(.fields(nil, [Field("Terminal", .mono(command))])) }
                outcome()
                return .terminal
            case "file_diff":
                let files = (presentation.files ?? []).map(Self.change)
                sections.append(.files(files, omittedFiles: presentation.omittedFiles ?? 0))
                return .fileEdit
            case "exploration":
                let operations = (presentation.operations ?? []).map(Self.operation)
                sections.append(.operations(operations))
                // A single read shows the file as it came back; anything else its matches.
                let read = operations.count == 1 && operations[0].kind == "read" ? operations[0].subject : nil
                if status == .failed { outcome() } else if let output = Self.output(result) { sections.append(.code(read == nil ? .result : .content, output, path: read)) }
                return .exploration
            case "search":
                var fields = [Field("Query", .text(presentation.query ?? ""))]
                if let target = presentation.target { fields.append(Field("Searched", .text(target == "x" ? "X" : "Web"))) }
                sections.append(.fields(nil, fields))
                if let sources = presentation.sources, !sources.isEmpty { sections.append(.links(sources.map { Link(title: $0.title, url: $0.url) })) }
                outcome()
                return .search
            case "agent_spawn":
                if let model = presentation.model { sections.append(.fields(nil, [Field("Model", .text(model.name))])) }
                _ = fromArguments()
                return .subagent
            case "compaction":
                var fields: [Field] = []
                if let before = presentation.tokensBefore { fields.append(Field("Before", .scalar(ToolDetail.tokens(before)))) }
                if let after = presentation.tokensAfter { fields.append(Field("After", .scalar(ToolDetail.tokens(after)))) }
                if !fields.isEmpty { sections.append(.fields(nil, fields)) }
                return .compaction
            case "media":
                let names = (presentation.items ?? []).map { Value.mono($0.source?.path ?? $0.name) }
                if !names.isEmpty { sections.append(.fields(nil, [Field("Files", .list(names))])) }
                return .media
            case "artifact":
                var fields: [Field] = []
                if let title = presentation.title { fields.append(Field("Title", .text(title))) }
                if let type = presentation.artifactType { fields.append(Field("Type", .text(type))) }
                if let version = presentation.version { fields.append(Field("Version", .scalar(String(version)))) }
                if !fields.isEmpty { sections.append(.fields(nil, fields)) }
                return .media
            default:
                // Unknown presentations fall back to the raw data.
                return nil
            }
        }

        static func change(_ file: AgentWire.Presentation.DiffFile) -> FileChange {
            let hunks = file.hunks ?? []
            return FileChange(
                path: file.path, kind: file.kind, added: file.added ?? 0, deleted: file.deleted ?? 0,
                source: hunks.isEmpty ? nil : .patch(FileDiffPatch.unified(path: file.path, kind: file.kind, hunks: hunks)),
                omittedLines: file.omittedLines ?? 0
            )
        }

        static func operation(_ operation: AgentWire.Presentation.Operation) -> Operation {
            switch operation.kind {
            case "list": return Operation(kind: "list", subject: operation.target ?? "")
            case "read": return Operation(kind: "read", subject: operation.name ?? "")
            default:
                let subject = operation.query ?? operation.command ?? ""
                let detail = [operation.path, operation.query == nil ? nil : operation.command].compactMap { $0 }.first { !$0.isEmpty && $0 != subject }
                return Operation(kind: operation.kind, subject: subject, detail: detail)
            }
        }

        static func output(_ result: JSONValue?) -> String? {
            switch ToolDetail.resultBody(result) {
            case .text(let text)?: text
            case .fields(let fields)?: fields.map { "\($0.label): \(ToolDetail.plain($0.value))" }.joined(separator: "\n")
            case nil: nil
            }
        }

        /// How the call ended: its error, or what it returned.
        mutating func outcome(_ title: Title = .result) {
            guard status != .running else { return }
            if status == .failed {
                if let error = ToolDetail.errorText(result) { sections.append(.error(error)) }
                return
            }
            switch ToolDetail.resultBody(result) {
            case .text(let text)?: sections.append(.code(title, text, path: nil))
            case .fields(let fields)?: sections.append(.fields(title, fields))
            case nil: break
            }
        }

        // MARK: Raw arguments

        mutating func fromArguments() -> Kind {
            let lower = name.lowercased()
            switch name {
            case "Bash", "exec_command", "run_terminal_command", "monitor":
                let command = take("command", "cmd") ?? ""
                sections.append(.terminal(command: command, output: status == .running ? nil : Self.output(result), prompt: true))
                if status == .failed, let error = ToolDetail.errorText(result), Self.output(result) == nil { sections.append(.error(error)) }
                rest()
                return .terminal
            case "write_stdin", "send_command_input":
                let typed = take("chars", "input", "text") ?? ""
                sections.append(.terminal(command: typed, output: nil, prompt: false))
                rest()
                outcome(.output)
                return .terminal
            case "Read", "read_file", "view_image":
                let path = take("file_path", "target_file", "path") ?? ""
                sections.append(.operations([Operation(kind: "read", subject: path)]))
                rest()
                if status == .failed { outcome() } else if let output = Self.output(result) { sections.append(.code(.content, output, path: path)) }
                return .exploration
            case "list_dir", "Glob", "Grep", "grep":
                let subject = take("pattern", "target_directory", "path") ?? ""
                let kind = name == "list_dir" ? "list" : "search"
                let detail = kind == "search" ? take("path") : nil
                sections.append(.operations([Operation(kind: kind, subject: subject, detail: detail)]))
                rest()
                if status == .failed { outcome() } else if let output = Self.output(result) { sections.append(.code(.result, output, path: nil)) }
                return .exploration
            case "Edit", "search_replace":
                let path = take("file_path", "path") ?? ""
                let old = take("old_string") ?? ""
                let new = take("new_string") ?? ""
                sections.append(.files([FileChange(path: path, kind: "update", added: 0, deleted: 0, source: .pair(old: old, new: new))], omittedFiles: 0))
                rest()
                outcome()
                return .fileEdit
            case "Write", "write":
                let path = take("file_path", "path") ?? ""
                let content = take("content") ?? ""
                sections.append(.files([FileChange(path: path, kind: "add", added: 0, deleted: 0, source: .pair(old: "", new: content))], omittedFiles: 0))
                rest()
                outcome()
                return .fileEdit
            case "apply_patch":
                if let patch = take("input", "patch") { sections.append(.code(.patch, patch, path: nil)) }
                rest()
                outcome()
                return .fileEdit
            case "update_plan", "todo_write", "TodoWrite":
                let items = (arguments["plan"] ?? arguments["todos"])?.arrayValue ?? []
                used.formUnion(["plan", "todos"])
                let todos = items.compactMap { item -> Todo? in
                    guard let text = item["step"]?.stringValue ?? item["content"]?.stringValue ?? item["id"]?.stringValue else { return nil }
                    return Todo(text, Todo.state(item["status"]?.stringValue))
                }
                if let explanation = take("explanation") { sections.append(.text(.explanation, explanation)) }
                if !todos.isEmpty { sections.append(.checklist(.plan, todos)) }
                rest()
                if status == .failed { outcome() }
                return .plan
            case "Agent", "spawn_agent", "spawn_subagent", "create_agent", "create_subtask":
                var fields: [Field] = []
                if let title = take("title", "task_name", "description") { fields.append(Field("Task", .text(title))) }
                if let model = take("model") { fields.append(Field("Model", .mono(model))) }
                if !fields.isEmpty { sections.append(.fields(nil, fields)) }
                if let prompt = take("prompt", "message", "initialMessage", "instructions") { sections.append(.text(.prompt, prompt)) }
                rest()
                outcome()
                return .subagent
            case "send_agent_message", "SendMessage", "send_message", "followup_task", "send_bot_message":
                var fields: [Field] = []
                if let to = take("to", "target", "agentId", "agent_id", "botId") { fields.append(Field("To", .mono(to))) }
                if let summary = take("summary") { fields.append(Field("Summary", .text(summary))) }
                if !fields.isEmpty { sections.append(.fields(nil, fields)) }
                if let message = take("message", "text") { sections.append(.text(.message, message)) }
                rest()
                outcome()
                return .message
            case "WebFetch", "web_fetch":
                if let url = take("url") { sections.append(.fields(nil, [Field("URL", .link(url))])) }
                if let prompt = take("prompt") { sections.append(.text(.prompt, prompt)) }
                rest()
                outcome()
                return .web
            case "WebSearch", "web_search", "x_search":
                if let query = take("query") { sections.append(.fields(nil, [Field("Query", .text(query))])) }
                rest()
                outcome()
                return .search
            case AgentWire.Question.toolName:
                used.insert("questions")
                let asked = AgentWire.Question.asked(id: "", arguments: .object(arguments), output: Self.output(result))
                let questions = (asked?.questions ?? []).map { prompt in
                    Question(header: prompt.header, question: prompt.question, answers: asked?.answers?[prompt.id] ?? [])
                }
                if !questions.isEmpty { sections.append(.questions(questions)) }
                rest()
                if status == .failed { outcome() }
                return .question
            default:
                if lower.contains("search") && arguments["query"] != nil {
                    if let query = take("query") { sections.append(.fields(nil, [Field("Query", .text(query))])) }
                    rest()
                    outcome()
                    return .search
                }
                rest(title: .arguments)
                outcome()
                return .tool
            }
        }

        /// The arguments no section showed, as fields: short prose and
        /// values on their lines, long text in blocks.
        mutating func rest(title: Title? = nil) {
            let left = arguments.filter { !used.contains($0.key) }
            guard !left.isEmpty else { return }
            let fields = ToolDetail.ordered(left).map { Field(ToolDetail.label($0.0), ToolDetail.value($0.1, key: $0.0)) }
            sections.append(.fields(title, fields))
        }
    }

    static func tokens(_ count: Double) -> String {
        count >= 1000 ? String(format: "%.1fk", count / 1000).replacingOccurrences(of: ".0k", with: "k") : format(count)
    }
}

/// A `file_diff` file's hunks as the unified patch git writes, which the
/// diff engine parses and colours.
public enum FileDiffPatch {
    public static func unified(path: String, kind: String, hunks: [AgentWire.Presentation.Hunk]) -> String {
        var lines = ["diff --git a/\(path) b/\(path)"]
        if kind == "add" { lines.append("new file mode 100644") }
        if kind == "delete" { lines.append("deleted file mode 100644") }
        lines.append(kind == "add" ? "--- /dev/null" : "--- a/\(path)")
        lines.append(kind == "delete" ? "+++ /dev/null" : "+++ b/\(path)")
        for hunk in hunks {
            let oldCount = hunk.lines.filter { $0.kind != "add" }.count
            let newCount = hunk.lines.filter { $0.kind != "delete" }.count
            lines.append("@@ -\(hunk.oldStart),\(oldCount) +\(hunk.newStart),\(newCount) @@")
            for line in hunk.lines {
                let marker = line.kind == "add" ? "+" : line.kind == "delete" ? "-" : " "
                // A line is one line: a stray break inside it would end the hunk early.
                lines.append(marker + line.text.replacingOccurrences(of: "\n", with: " "))
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }
}
