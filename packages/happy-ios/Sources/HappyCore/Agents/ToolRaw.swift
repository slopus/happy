import Foundation
import HappyWire

/// Which tool calls keep their raw `arguments` and `result` on the phone,
/// and how much of them. A presentation that already carries what the call
/// did (a command and its output, a diff, media, an artifact) makes the raw
/// data redundant; only its bounded display fields survive (`ToolSummary`).
/// Any other call is shown on its screen from the raw data,
/// so it is kept, every string cut to `maxString` characters so one long
/// read or output can't swell the kept conversation.
///
/// Chat-based onboarding is deferred. If revisited, prefer settings
/// widgets, top-level tools like MCP apps, or general Card/Button/Text/
/// Column UI (json-render/A2UI/ChatGPT-style), not this widget protocol.
/// Unrecognized or malformed presentations use ordinary tool rows and
/// bounded raw data, including historical calls.
public enum ToolRaw {
    /// Presentations that say everything the call's screen shows.
    static let complete: Set<String> = ["exec_command", "file_diff", "media", "artifact", "background_terminal_interaction", "compaction"]

    public static let maxString = 32 * 1024
    /// What a cut string ends with.
    public static let cutMark = "\n…"

    public static func keeps(name: String, presentation: String?) -> Bool {
        guard let presentation else { return true }
        return !complete.contains(presentation)
    }

    /// `value` with every string longer than `maxString` cut there.
    public static func bounded(_ value: JSONValue, maxString: Int = maxString) -> JSONValue {
        switch value {
        case .string(let text):
            guard text.count > maxString else { return value }
            return .string(String(text.prefix(maxString)) + cutMark)
        case .array(let items): return .array(items.map { bounded($0, maxString: maxString) })
        case .object(let object): return .object(object.mapValues { bounded($0, maxString: maxString) })
        default: return value
        }
    }

    /// Some string in `value` was cut by `bounded`.
    public static func isCut(_ value: JSONValue?, maxString: Int = maxString) -> Bool {
        switch value {
        case .string(let text)?: text.hasSuffix(cutMark) && text.count == maxString + cutMark.count
        case .array(let items)?: items.contains { isCut($0, maxString: maxString) }
        case .object(let object)?: object.values.contains { isCut($0, maxString: maxString) }
        default: false
        }
    }
}
