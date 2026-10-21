import Foundation
import XCTest
import HappyWire
import HappyStore
@testable import HappyCore

enum ChatRecords {
    static func json(_ text: String) -> JSONValue { try! JSONValue.decode(Data(text.utf8)) }

    static func session(
        _ id: String, at time: Int64 = 100, role: String = "agent", turn: String? = "turn",
        parent: String? = nil, event: JSONValue, extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        var envelope = extra
        envelope["id"] = .string(id)
        envelope["time"] = .number(Double(time))
        envelope["role"] = .string(role)
        envelope["ev"] = event
        if let turn {
            envelope["turn"] = .string(turn)
        }
        if let parent {
            envelope["subagent"] = .string(parent)
        }
        return .object(["role": .string("session"), "content": .object(envelope)])
    }

    static func normalized(_ id: String, at time: Int64 = 100, raw: JSONValue, localId: String? = nil)
        -> NormalizedChatRecord
    {
        ChatNormalizer.normalize(id: id, localId: localId, createdAt: time, raw: raw)!
    }

    static func user(
        _ id: String, localId: String? = nil, at time: Int64 = 100, expects: Bool = false,
        text: String = "hello"
    ) -> NormalizedChatRecord {
        normalized(
            id, at: time,
            raw: .object([
                "role": .string("user"),
                "content": .object(["type": .string("text"), "text": .string(text)]),
                "meta": .object(["expectsAcceptance": .bool(expects)]),
            ]), localId: localId)
    }

    static func text(
        _ id: String, at time: Int64 = 100, parent: String? = nil, text: String = "answer",
        thinking: Bool = false
    ) -> NormalizedChatRecord {
        normalized(
            id,
            raw: session(
                id, at: time, parent: parent,
                event: .object(["t": .string("text"), "text": .string(text), "thinking": .bool(thinking)])))
    }

    static func call(
        _ id: String, call: String = "call", name: String = "Bash", at time: Int64 = 100,
        parent: String? = nil, input: JSONValue = .object([:])
    ) -> NormalizedChatRecord {
        normalized(
            id,
            raw: session(
                id, at: time, parent: parent,
                event: .object([
                    "t": .string("tool-call-start"), "call": .string(call), "name": .string(name),
                    "title": .string("Run command"), "description": .string("description"), "args": input,
                ])))
    }

    static func result(
        _ id: String, call: String = "call", at time: Int64 = 200, error: Bool = false,
        result: String = "done", parent: String? = nil
    ) -> NormalizedChatRecord {
        normalized(
            id,
            raw: session(
                id, at: time, parent: parent,
                event: .object([
                    "t": .string("tool-call-end"), "call": .string(call), "result": .string(result),
                    "isError": .bool(error),
                ])))
    }

    static func receipt(_ id: String, ref: String, at time: Int64 = 500, error: String? = nil)
        -> NormalizedChatRecord
    {
        let event: JSONValue =
            error.map {
                .object(["t": .string("user-message-rejected"), "ref": .string(ref), "reason": .string($0)])
            }
            ?? .object([
                "t": .string("user-message-accepted"), "id": .string(id), "ref": .string(ref),
                "runId": .string("run"),
            ])
        return normalized(id, raw: session(id, at: time, turn: nil, event: event))
    }

    static func agentEvent(_ id: String, at time: Int64 = 300, event: JSONValue) -> NormalizedChatRecord {
        normalized(
            id, at: time,
            raw: .object([
                "role": .string("agent"),
                "content": .object(["type": .string("event"), "id": .string(id), "data": event]),
            ]))
    }

    static func permissionState(
        _ id: String = "call", status: String? = nil, arguments: JSONValue = .object([:]),
        extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        var value = extra
        value["tool"] = .string("Bash")
        value["arguments"] = arguments
        value["createdAt"] = .number(50)
        if let status {
            value["status"] = .string(status)
            value["completedAt"] = .number(75)
        }
        return .object([status == nil ? "requests" : "completedRequests": .object([id: .object(value)])])
    }

    static func storeSession(
        _ id: String = "s", seq: Int = 0, metadata: JSONValue? = nil, agentState: JSONValue? = nil
    ) -> SessionRecord {
        SessionRecord(
            id: id, seq: seq, createdAt: 1, updatedAt: 100, active: true, activeAt: 100, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: metadata, agentStateVersion: 1,
            agentStateCipher: "c", agentState: agentState, dataKeyCipher: "key", decryptable: true)
    }

    static func stored(_ record: NormalizedChatRecord, seq: Int, sessionId: String = "s") -> MessageRecord {
        MessageRecord(
            id: record.id, sessionId: sessionId, seq: seq, localId: record.localId,
            createdAt: record.createdAt, updatedAt: record.createdAt, contentCipher: "cipher",
            content: record.raw)
    }

    static func userRow(_ messages: [ChatMessage]) throws -> UserTextMessage {
        try XCTUnwrap(
            messages.compactMap {
                if case .userText(let row) = $0 {
                    return row
                }
                return nil
            }.first)
    }

    static func toolRow(_ messages: [ChatMessage]) throws -> ToolCallMessage {
        try XCTUnwrap(
            messages.compactMap {
                if case .toolCall(let row) = $0 {
                    return row
                }
                return nil
            }.first)
    }
}
