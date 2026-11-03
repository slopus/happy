import Foundation
import HappyWire

/// The hosted agent's five client tools. Their schemas live here, the one
/// place both the hosted agent's configuration and this phone read them
/// from; the relay's tools (`sendMessageToSession`, `processPermissionRequest`)
/// are not among them and never run for this agent. There is no tool for
/// permissions or questions: those stay in the app.
public enum CallTool: String, CaseIterable, Sendable {
    case listSessions
    case getSessionContext
    case openSession
    case setSessionWatch
    case sendMessage

    /// The parameters, as JSON Schema for the hosted agent's client tool.
    public var parameters: JSONValue {
        func string(_ description: String) -> JSONValue {
            .object(["type": .string("string"), "description": .string(description)])
        }
        let revision: JSONValue = .object(["type": .string("integer"), "description": .string("The context's focusRevision this request was made under.")])
        func object(_ properties: [String: JSONValue], required: [String]) -> JSONValue {
            .object(["type": .string("object"), "properties": .object(properties), "required": .array(required.map(JSONValue.string))])
        }
        switch self {
        case .listSessions:
            return object([
                "query": string("Words in the conversation's name, or empty for all."),
                "cursor": string("The nextCursor of the previous page."),
            ], required: [])
        case .getSessionContext:
            return object([
                "targetRef": string("A targetRef from the context or listSessions."),
            ], required: ["targetRef"])
        case .openSession:
            return object([
                "targetRef": string("The conversation to show on screen."),
                "focusRevision": revision,
            ], required: ["targetRef", "focusRevision"])
        case .setSessionWatch:
            return object([
                "targetRef": string("The conversation to follow, or stop following."),
                "enabled": .object(["type": .string("boolean"), "description": .string("true to follow, false to stop.")]),
            ], required: ["targetRef", "enabled"])
        case .sendMessage:
            return object([
                "targetRef": string("The conversation to send to."),
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
