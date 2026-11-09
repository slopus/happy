import Foundation
import HappyWire

/// The built-in tools' display fields, not arbitrary arguments that happen
/// to be called `name` or `description`. MCP inputs retain their own meaning.
public enum ToolSummary {
    private static let described: Set<String> = [
        "Bash", "exec_command", "run_terminal_command", "python", "apply_patch",
        "BashInput", "TaskInput", "send_command_input", "write_stdin", "BashStop", "TaskStop",
        "kill_command_or_subagent", "kill_session", "archive_agent", "archive_subtask", "archive_task",
        "interrupt_agent", "delete_permanently", "preview_delete", "delete_artifact", "delete_calendar_event",
        "delete_todo", "update_artifact", "update_calendar_event", "update_document", "update_surface",
        "update_todo", "reorder_todo", "write_artifact_data", "restore_vault_file", "restore_vault_folder",
        "add_surface_user", "remove_surface_user", "attach_secret", "detach_secret", "reference_secret",
        "attach_compute", "detach_compute", "attach_repository", "add_mcp_server", "update_mcp_server",
        "set_mcp_server_enabled", "set_bot_avatar", "set_node_avatar", "cancel_ask", "message_task",
        "create_task", "create_bot", "create_calendar_event", "codex_imagegen"
    ]

    private static func fields(_ name: String) -> [String] {
        guard !name.hasPrefix("mcp__") else { return [] }
        let fallback: [String]
        switch name {
        case "send_agent_message", "send_bot_message", "send_task_message", "update_plan": fallback = ["explanation"]
        case "create_agent", "create_subtask", "create_artifact", "codex_imagegen", "create_calendar_event", "update_calendar_event", "update_artifact": fallback = ["title"]
        case "create_calendar_surface", "create_chat_surface", "create_document_surface", "create_todo_surface", "set_bot_name", "set_node_name", "set_title", "remove_mcp_server", "create_task", "create_bot", "update_surface": fallback = ["name"]
        case "create_vault_folder", "delete_vault_file", "delete_vault_folder", "edit_artifact_file", "edit_vault_file", "list_vault_versions", "read_artifact_file", "read_vault_file", "view_image", "write_artifact_file", "write_vault_artifact", "write_vault_file", "list_vault": fallback = ["path"]
        case "copy_vault_file", "move_vault_file", "move_vault_folder": fallback = ["path", "toPath"]
        case "glob_vault", "grep_vault": fallback = ["pattern"]
        case "tool_search", "web_search", "read_agent_history": fallback = ["query"]
        case "add_repository", "web_fetch": fallback = ["url"]
        case "create_todo", "update_todo": fallback = ["text"]
        default: fallback = []
        }
        return (described.contains(name) ? ["description"] : []) + fallback
    }

    /// Matches the server's Unicode-scalar limit, including combining marks
    /// and emoji sequences, rather than counting UTF-16 units or graphemes.
    public static func normalized(_ text: String) -> String? {
        let words = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !words.isEmpty else { return nil }
        return String(String.UnicodeScalarView(words.unicodeScalars.prefix(120)))
    }

    public static func text(name: String, arguments: JSONValue?) -> String? {
        for field in fields(name) {
            if let value = arguments?[field]?.stringValue, let label = normalized(value) { return label }
        }
        if name == "request_user_input", case .array(let questions)? = arguments?["questions"] {
            for question in questions {
                if let value = question["question"]?.stringValue, let label = normalized(value) { return label }
            }
        }
        return nil
    }

    private struct Field: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }

    /// A rich presentation already owns its detail body. Decode only its
    /// small display fields, never the potentially large patch/code payload.
    static func compactArguments(name: String, from decoder: Decoder) throws -> JSONValue? {
        let fields = fields(name)
        guard !fields.isEmpty else { return nil }
        let container = try decoder.container(keyedBy: Field.self)
        var values: [String: JSONValue] = [:]
        for field in fields {
            if let value = try? container.decode(String.self, forKey: Field(field)), let label = normalized(value) {
                values[field] = .string(label)
            }
        }
        return values.isEmpty ? nil : .object(values)
    }
}