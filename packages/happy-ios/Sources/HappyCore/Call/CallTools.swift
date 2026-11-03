import Foundation
import HappyWire

/// The hosted agent's four client tools. Their schemas and descriptions
/// live here, the one place both the hosted agent's configuration and this
/// phone read them from; the relay's tools (`sendMessageToSession`,
/// `processPermissionRequest`) are not among them and never run for this
/// agent. There is no tool for permissions or questions, and none to choose
/// what the call hears: it hears the last conversations the person visited.
public enum CallTool: String, CaseIterable, Sendable {
    case listSessions
    case getSessionContext
    case openSession
    case sendMessage

    /// The client tool's description, as the hosted agent shows it to the model.
    public var summary: String {
        switch self {
        case .listSessions:
            "List the conversations the person sees in the app (bots, tasks, subtasks and project conversations), in the sidebar's order, with their targetRef, title, kind, status and parents (the titles of what each sits under). query keeps those whose title contains it as a case-insensitive substring. Page with nextCursor."
        case .getSessionContext:
            "Read one conversation: whether it is working or needs the person, and its last five turns, each the person's message and the agent's last words, or as much of the pair as there is; the person's latest message, if nothing has answered it yet, is the fifth (pendingUserMessage). It doesn't open the conversation or change what you hear from."
        case .openSession:
            "Show a conversation on the person's screen. Like any conversation they open, it joins the four most recently visited, whose new replies you hear."
        case .sendMessage:
            "Send the person's message to a conversation's agent, exactly as given (at most 8 KiB of UTF-8). It doesn't open the conversation. \"queued\" means queued on the person's device, not confirmed delivered or read; after \"uncertain\", never send it again."
        }
    }

    /// The parameters, as JSON Schema for the hosted agent's client tool.
    public var parameters: JSONValue {
        func string(_ description: String) -> JSONValue {
            .object(["type": .string("string"), "description": .string(description)])
        }
        let revision: JSONValue = .object(["type": .string("integer"), "description": .string("The latest focusRevision you have seen.")])
        let target = string("A targetRef from the context or listSessions.")
        func object(_ properties: [String: JSONValue], required: [String]) -> JSONValue {
            .object(["type": .string("object"), "properties": .object(properties), "required": .array(required.map(JSONValue.string))])
        }
        switch self {
        case .listSessions:
            return object([
                "query": string("A case-insensitive substring of the title; omit for all."),
                "cursor": string("The nextCursor of the previous page; omit for the first."),
            ], required: [])
        case .getSessionContext:
            return object(["targetRef": target], required: ["targetRef"])
        case .openSession:
            return object(["targetRef": target, "focusRevision": revision], required: ["targetRef", "focusRevision"])
        case .sendMessage:
            return object([
                "targetRef": target,
                "text": string("The person's message, exactly as they asked to send it."),
                "focusRevision": revision,
            ], required: ["targetRef", "text", "focusRevision"])
        }
    }
}

/// One tool call as the SDK hands it over.
public struct CallToolCall: Equatable, Sendable {
    public var id: String
    public var name: String
    public var parameters: Data
    public var expectsResponse: Bool

    public init(id: String, name: String, parameters: Data, expectsResponse: Bool = true) {
        self.id = id
        self.name = name
        self.parameters = parameters
        self.expectsResponse = expectsResponse
    }
}

public struct CallToolResult: Equatable, Sendable {
    public var text: String
    public var isError: Bool

    public init(text: String, isError: Bool = false) {
        self.text = text
        self.isError = isError
    }

    static func json(_ value: [String: Any], isError: Bool = false) -> CallToolResult {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
        return CallToolResult(text: String(decoding: data, as: UTF8.self), isError: isError)
    }

    static func refused(_ reason: String) -> CallToolResult {
        json(["ok": false, "reason": reason], isError: true)
    }
}
