import Foundation
import HappyWire

// How a tool call reads in the chat: its category, its one-line activity
// label, and whether it gets a card or a compact row. A port of happy-app's
// `utils/toolDisplay.ts`, `utils/happyToolDisplay.ts` and
// `utils/toolCommand.ts`. The localized action words come in from the UI.

/// The words an activity row starts with (en.ts `toolGroup`).
public struct ToolActionWords: Equatable, Sendable {
    public var ran: String
    public var edited: String
    public var read: String
    public var searched: String
    public var fetched: String
    public var ranTask: String

    public init(ran: String, edited: String, read: String, searched: String, fetched: String, ranTask: String) {
        self.ran = ran
        self.edited = edited
        self.read = read
        self.searched = searched
        self.fetched = fetched
        self.ranTask = ranTask
    }
}

public enum ToolCategory: String, Equatable, Sendable {
    case terminal, edit, read, search, web, task, other
}

public enum ChatToolDisplay {
    static let terminalNames: Set<String> = [
        "Bash", "CodexBash", "GeminiBash", "shell", "execute", "exec_command", "run_terminal_command", "write_stdin",
    ]
    static let editNames: Set<String> = [
        "Edit", "MultiEdit", "Write", "CodexPatch", "GeminiPatch", "edit", "NotebookEdit", "apply_patch", "search_replace",
    ]
    static let readNames: Set<String> = [
        "Read", "read", "NotebookRead", "LS", "read_file", "read_agent_history", "view_image", "get_provider_usage", "get_goal", "agent_info",
    ]
    static let searchNames: Set<String> = [
        "Grep", "Glob", "grep", "search", "WebSearch", "list_dir", "list_agents", "list_projects", "list_workspaces",
        "list_workspace_sessions", "TaskList",
    ]
    static let webNames: Set<String> = ["WebFetch"]
    static let taskNames: Set<String> = [
        "Task", "Agent", "TaskCreate", "TaskOutput", "TaskStop", "TaskUpdate", "Workflow", "archive_workspace", "create_goal",
        "create_workspace", "delegate_to_workspace", "followup_task", "interrupt_agent", "schedule_message", "send_message",
        "agent_me", "agent_send", "spawn_agent", "stop_workflow", "update_goal", "update_plan", "wait_agent", "wait_for_workflow",
        "workflow", "workflow_status",
    ]
    static let interactiveQuestionNames: Set<String> = ["AskUserQuestion", "request_user_input"]
    /// knownTools entries marked `hidden`: never rendered at all.
    static let hiddenNames: Set<String> = [
        "CodexReasoning", "GeminiReasoning", "think", "change_title", "Skill", "ToolSearch", "tool_search",
    ]
    /// Patch tools head each changed file themselves, and `file` is a
    /// picture with no card, so none of them gets a card header.
    static let selfHeadingNames: Set<String> = ["CodexPatch", "GeminiPatch", "apply_patch", "file"]
    static let shellWrappers: Set<String> = ["bash", "/bin/bash", "sh", "/bin/sh", "zsh", "/bin/zsh"]

    /// Happy Agent's own tools: a category and a readable title.
    static let happyTools: [String: (category: ToolCategory, title: String)] = [
        "BashInput": (.terminal, "Send shell input"),
        "BashOutput": (.terminal, "Read shell output"),
        "BashStop": (.terminal, "Stop shell"),
        "write_stdin": (.terminal, "Shell session"),
        "kill_session": (.terminal, "Stop shell"),
        "get_command_or_subagent_output": (.terminal, "Read shell output"),
        "send_command_input": (.terminal, "Send shell input"),
        "kill_command_or_subagent": (.terminal, "Stop shell"),
        "create_agent": (.task, "Start collaborator"),
        "send_agent_message": (.task, "Send agent message"),
        "interrupt_agent": (.task, "Interrupt agent"),
        "create_task": (.task, "Create task"),
        "list_tasks": (.search, "List tasks"),
        "get_task": (.read, "Read task"),
        "update_task": (.task, "Update task"),
        "complete_task": (.task, "Complete task"),
        "remove_task": (.task, "Remove task"),
        "create_goal": (.task, "Create goal"),
        "get_goal": (.read, "Read goal"),
        "update_goal": (.task, "Update goal"),
        "clear_goal": (.task, "Clear goal"),
        "create_workspace": (.task, "Create workspace"),
        "create_child_workspace": (.task, "Create workspace"),
        "list_workspaces": (.search, "List workspaces"),
        "get_workspace": (.read, "Read workspace"),
        "rename_workspace": (.task, "Rename workspace"),
        "archive_workspace": (.task, "Archive workspace"),
        "get_workspace_branch_metadata": (.read, "Read branch metadata"),
        "list_projects": (.search, "List projects"),
        "set_project_avatar": (.task, "Set project avatar"),
        "run_workflow": (.task, "Run workflow"),
        "list_workflows": (.search, "List workflows"),
        "workflow_status": (.read, "Check workflow"),
        "workflow_logs": (.read, "Read workflow logs"),
        "wait_workflow": (.task, "Wait for workflow"),
        "cancel_workflow": (.task, "Cancel workflow"),
        "resume_workflow": (.task, "Resume workflow"),
        "wait": (.task, "Wait"),
        "wait_until": (.task, "Wait until"),
        "schedule_message": (.task, "Schedule message"),
        "list_scheduled_messages": (.search, "List scheduled messages"),
        "cancel_scheduled_message": (.task, "Cancel scheduled message"),
        "read_user_input": (.read, "Read answer"),
        "cancel_ask": (.task, "Cancel question"),
        "get_presence": (.read, "Check presence"),
        "list_presences": (.search, "List presence states"),
        "set_presence": (.task, "Set presence"),
        "list_secrets": (.search, "List secret references"),
        "reference_secret": (.read, "Read secret reference"),
        "create_secret": (.task, "Create secret"),
        "update_secret": (.task, "Update secret"),
        "attach_secret": (.task, "Attach secret"),
        "detach_secret": (.task, "Detach secret"),
        "list_mcp_servers": (.search, "List MCP servers"),
        "list_mcp_tools": (.search, "List MCP tools"),
        "list_mcp_resources": (.search, "List MCP resources"),
        "list_mcp_resource_templates": (.search, "List MCP resource templates"),
        "list_mcp_prompts": (.search, "List MCP prompts"),
        "read_mcp_resource": (.read, "Read MCP resource"),
        "get_mcp_prompt": (.read, "Read MCP prompt"),
        "call_mcp_tool": (.task, "Call MCP tool"),
        "configure_mcp_server": (.task, "Configure MCP server"),
        "reload_mcp_servers": (.task, "Reload MCP servers"),
        "list_skills": (.search, "List skills"),
        "read_skill": (.read, "Read skill"),
        "get_usage": (.read, "Read token usage"),
        "get_agent_tree_usage": (.read, "Read agent-tree usage"),
        "read_agent_history": (.read, "Read agent history"),
        "create_bot": (.task, "Create bot"),
        "list_bots": (.search, "List bots"),
        "send_bot_message": (.task, "Send bot message"),
        "set_bot_avatar": (.task, "Set bot avatar"),
        "codex_imagegen": (.task, "Generate image"),
        "gemini_imagegen": (.task, "Generate image"),
        "gemini_generate_music": (.task, "Generate music"),
        "gemini_analyze_media": (.read, "Analyze media"),
        "javascript": (.task, "Run JavaScript"),
        "python": (.task, "Run Python"),
        "write": (.edit, "Write file"),
        "web_fetch": (.web, "Fetch URL"),
        "bedrock_web_search": (.search, "Search the web"),
        "claude_web_search": (.search, "Search the web"),
        "codex_web_search": (.search, "Search the web"),
        "gemini_web_search": (.search, "Search the web"),
        "grok_web_search": (.search, "Search the web"),
        "grok_x_search": (.search, "Search X"),
    ]

    public static func isHidden(_ name: String) -> Bool { hiddenNames.contains(name) }

    public static func isInteractiveQuestion(_ name: String) -> Bool { interactiveQuestionNames.contains(name) }

    public static func isTerminal(_ name: String) -> Bool {
        terminalNames.contains(name) || happyTools[name]?.category == .terminal
    }

    public static func rendersCardHeader(_ name: String) -> Bool { !selfHeadingNames.contains(name) }

    /// A one-line activity row instead of a card. Name-agnostic on purpose,
    /// so a new provider tool never falls back to a raw JSON card; pictures
    /// and anything that needs its context on screen stay expanded.
    public static func usesCompactRow(_ tool: ToolCall, compactMode: Bool, hasInlineView: Bool = true) -> Bool {
        if tool.name == "file" || isInteractiveQuestion(tool.name) { return false }
        let pending = tool.permission?.status == .pending
        if (tool.name == "ExitPlanMode" || tool.name == "exit_plan_mode") && pending { return false }
        if !hasInlineView && pending { return false }
        return compactMode || !hasInlineView
    }

    public static func category(_ name: String) -> ToolCategory {
        if let happy = happyTools[name] { return happy.category }
        if terminalNames.contains(name) { return .terminal }
        if editNames.contains(name) { return .edit }
        if readNames.contains(name) { return .read }
        if searchNames.contains(name) { return .search }
        if webNames.contains(name) { return .web }
        if taskNames.contains(name) { return .task }
        return .other
    }

    /// The tool's title: the provider's, Happy Agent's, or the action word.
    public static func displayTitle(_ tool: ToolCall, words: ToolActionWords) -> String {
        if let title = tool.title?.trimmed, !title.isEmpty { return title }
        if let happy = happyTools[tool.name] { return happy.title }
        return action(category(tool.name), name: tool.name, words: words)
    }

    /// The row's label: the command for a terminal tool, otherwise the
    /// provider's description when it says more than the arguments do, and
    /// failing that the action and its detail.
    public static func activityLabel(_ tool: ToolCall, words: ToolActionWords) -> String {
        if let command = terminalCommand(tool) { return command }
        if let control = shellControl(tool) { return control.label }
        var withoutDescription = tool
        withoutDescription.description = nil
        let summary = summaryDetail(withoutDescription)
        let detail = isGenericDescription(tool.name, summary) ? nil : summary
        if let description = providerDescription(tool, detail: detail) { return description }
        let action = displayTitle(tool, words: words)
        guard let detail, normalize(detail) != normalize(action) else { return action }
        return "\(action): \(detail)"
    }

    /// The command a terminal tool ran, from whichever field carried it.
    public static func terminalCommand(_ tool: ToolCall) -> String? {
        guard isTerminal(tool.name) else { return nil }
        if let parsed = tool.input["parsed_cmd"]?.arrayValue, !parsed.isEmpty,
           let command = parsed.lazy.compactMap({ $0["cmd"]?.stringValue }).first(where: { !$0.trimmed.isEmpty }) {
            return command.trimmed
        }
        if let command = stringifyCommand(tool.input["command"] ?? tool.input["cmd"]) { return command }
        if let title = tool.input["toolCall"]?["title"]?.stringValue {
            let command: Substring
            if let bracket = title.range(of: " ["), bracket.lowerBound > title.startIndex {
                command = title[..<bracket.lowerBound]
            } else {
                command = Substring(title)
            }
            let trimmed = String(command).trimmed
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// A command as a string or an argv; `bash -c "…"` shows only the script.
    public static func stringifyCommand(_ command: JSONValue?) -> String? {
        if let string = command?.stringValue {
            let trimmed = string.trimmed
            return trimmed.isEmpty ? nil : trimmed
        }
        guard let array = command?.arrayValue else { return nil }
        let parts = array.compactMap(\.stringValue).map(\.trimmed).filter { !$0.isEmpty }
        if parts.isEmpty { return nil }
        if parts.count >= 3, shellWrappers.contains(parts[0]), parts[1] == "-c" || parts[1] == "-lc" {
            let wrapped = parts[2...].joined(separator: " ").trimmed
            return wrapped.isEmpty ? nil : wrapped
        }
        return parts.joined(separator: " ")
    }

    /// Stop, read and type into a running shell. These carry a session id,
    /// never a command, so the id is never shown as one.
    public static func shellControl(_ tool: ToolCall) -> (label: String, chars: String?)? {
        let args = tool.input
        var target = ""
        if let id = args["session_id"] ?? args["bash_id"] ?? args["task_id"], let text = id.stringValue ?? id.numberValue.map(formatNumber) {
            target = " (\(text))"
        } else if let ids = args["task_ids"]?.arrayValue?.compactMap(\.stringValue), !ids.isEmpty {
            target = " (\(ids.joined(separator: ", ")))"
        }
        switch tool.name {
        case "kill_session", "BashStop", "kill_command_or_subagent":
            return ("Stopping shell\(target)", nil)
        case "BashOutput", "get_command_or_subagent_output":
            return ("Reading shell output\(target)", nil)
        case "write_stdin", "BashInput", "send_command_input":
            let chars = (tool.name == "write_stdin" ? args["chars"] : args["input"])?.stringValue
            if let chars, !chars.isEmpty { return ("Sending input to shell\(target)", chars) }
            return ("Waiting for shell output\(target)", nil)
        default:
            return nil
        }
    }

    /// The argument that says what the tool worked on: a command, a path, a
    /// pattern, a URL or a short identifier. Never code or message bodies.
    public static func summaryDetail(_ tool: ToolCall) -> String? {
        if let command = terminalCommand(tool) { return command }
        let input = tool.input
        if let path = (input["file_path"] ?? input["target_file"])?.stringValue, !path.trimmed.isEmpty { return path.trimmed }
        let files = ChatPatch.files(input)
        if let first = files.first { return files.count == 1 ? first : "\(first) +\(files.count - 1)" }
        if let path = (input["path"] ?? input["target_directory"])?.stringValue, !path.trimmed.isEmpty { return path.trimmed }
        if let pattern = input["pattern"]?.stringValue, !pattern.trimmed.isEmpty { return pattern.trimmed }
        if let url = input["url"]?.stringValue, !url.trimmed.isEmpty { return url.trimmed }
        let args = input["input"]?.objectValue != nil ? input["input"]! : input
        for key in ["query", "title", "name", "objective", "workspaceId", "requestId", "ask_id", "id", "task_id", "toAgentId", "targetAgentId", "target", "agent_id", "server", "at"] {
            if let value = args[key]?.stringValue, !value.trimmed.isEmpty { return value.trimmed }
        }
        if let description = tool.description?.trimmed, !description.isEmpty { return description }
        return nil
    }

    /// `mcp__linear__create_issue` as `MCP: Linear Create Issue`.
    public static func mcpTitle(_ name: String) -> String {
        let bare = name.hasPrefix("mcp__") ? String(name.dropFirst(5)) : name
        let parts = bare.components(separatedBy: "__").map { part in
            part.split(separator: "_").map { word in word.prefix(1).uppercased() + word.dropFirst().lowercased() }.joined(separator: " ")
        }
        return "MCP: \(parts.joined(separator: " "))"
    }

    /// `snake_case` and `camelCase` as Title Case words.
    public static func formatName(_ value: String) -> String {
        var spaced = ""
        var previous: Character?
        for character in value {
            if character == "_" || character == "-" {
                if previous != "_" && previous != "-" { spaced.append(" ") }
            } else {
                if let previous, previous.isLowercaseASCII, character.isUppercaseASCII { spaced.append(" ") }
                spaced.append(character)
            }
            previous = character
        }
        return spaced.split(whereSeparator: \.isWhitespace).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    static func action(_ category: ToolCategory, name: String, words: ToolActionWords) -> String {
        switch category {
        case .terminal: words.ran
        case .edit: words.edited
        case .read: words.read
        case .search: words.searched
        case .web: words.fetched
        case .task: name == "Task" || name == "Agent" ? words.ranTask : formatName(name)
        case .other: name.hasPrefix("mcp__") ? mcpTitle(name) : formatName(name)
        }
    }

    static func providerDescription(_ tool: ToolCall, detail: String?) -> String? {
        guard let description = tool.description?.trimmed, !description.isEmpty,
              normalize(description) != normalize(detail ?? "") else { return nil }
        let generic: Set<String> = [
            normalize(tool.name), normalize(formatName(tool.name)),
            normalize("Running \(tool.name)"), normalize("Running \(formatName(tool.name))"),
            "terminal", "bash", "run command", "running command", "search", "web search", "read", "read file",
            "edit", "edit file", "write", "write file", "fetch url", "task",
        ]
        return generic.contains(normalize(description)) ? nil : description
    }

    static func isGenericDescription(_ name: String, _ value: String?) -> Bool {
        guard let value else { return false }
        let normalized = normalize(value)
        return normalized == normalize(name) || normalized == normalize(formatName(name))
            || normalized == normalize("Running \(name)") || normalized == normalize("Running \(formatName(name))")
    }

    static func normalize(_ value: String) -> String {
        value.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    static func formatNumber(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

extension Character {
    var isLowercaseASCII: Bool { ("a"..."z").contains(self) }
    var isUppercaseASCII: Bool { ("A"..."Z").contains(self) }
}
