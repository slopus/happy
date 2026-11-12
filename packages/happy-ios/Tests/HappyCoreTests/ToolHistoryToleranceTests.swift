import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// A presentation is optional display data: an unreadable or unsupported
/// one must never discard its tool call or the surrounding conversation.
final class ToolHistoryToleranceTests: XCTestCase {
    private static let arguments: JSONValue = .object(["depth": .number(2)])
    private static let result: JSONValue = .object(["output": .string("Saved.")])
    private static let cases: [(name: String, presentation: JSONValue, decodedType: String?)] = [
        ("show_ui", .object(["type": .string("ui"), "ui": .object(["id": .string("u"), "components": .array([])])]), "ui"),
        ("suggest_replies", .object(["type": .string("quick_replies"), "options": .array([.string("Yes")])]), "quick_replies"),
        ("future_tool", .object(["type": .string("hologram"), "contents": .array([])]), "hologram"),
        ("show_ui", .object(["type": .string("ui"), "items": .string("malformed")]), nil),
        ("suggest_replies", .object(["type": .number(7)]), nil),
        ("future_tool", .string("malformed"), nil),
    ]

    private static var calls: [JSONValue] {
        cases.enumerated().map { index, entry in
            .object([
                "type": .string("tool_call"), "id": .string("c\(index)"), "name": .string(entry.name), "status": .string("completed"),
                "arguments": arguments, "result": result, "presentation": entry.presentation,
            ])
        }
    }

    private static var message: JSONValue {
        .object(["id": .string("m"), "role": .string("agent"), "createdAt": .number(1), "content": .array(
            [.object(["type": .string("text"), "text": .string("Before.")])] + calls +
            [.object(["type": .string("text"), "text": .string("After.")])]
        )])
    }

    func testUnsupportedAndMalformedPresentationsKeepGenericToolData() throws {
        for (index, raw) in Self.calls.enumerated() {
            let block = try raw.decode(as: AgentWire.Block.self)
            guard case .toolCall(let id, let name, let status, let presentation, let arguments, _, let result, _) = block else {
                return XCTFail("Lost call \(index)")
            }
            XCTAssertEqual(id, "c\(index)")
            XCTAssertEqual(name, Self.cases[index].name)
            XCTAssertEqual(presentation?.type, Self.cases[index].decodedType)
            XCTAssertEqual(arguments, Self.arguments)
            XCTAssertEqual(result, Self.result)
            let detail = ToolDetail(ChatItem.Tool(name: name, status: status, presentation: presentation, callId: id, arguments: arguments, result: result))
            XCTAssertEqual(detail.kind, .tool)
            XCTAssertEqual(detail.sections, [.fields(.arguments, [.init("Depth", .scalar("2"))]), .code(.result, "Saved.", path: nil)])
            let kept = try JSONDecoder().decode(AgentWire.Block.self, from: JSONEncoder().encode(block))
            XCTAssertEqual(kept, block, "Persisting a decoded call keeps its generic data")
        }
    }

    func testHistoryRendersEveryToolBetweenItsSurroundingWords() async throws {
        let server = ToolHistoryServer(message: Self.message)
        let client = AgentClient(transport: server, token: "t")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = SyncEngine(client: client, directory: root)
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        var updates = conversation.updates.makeAsyncIterator()
        await conversation.start()
        var loaded: ChatSnapshot?
        while let snapshot = await updates.next() {
            if snapshot.loaded { loaded = snapshot; break }
        }
        await conversation.stop()
        let snapshot = try XCTUnwrap(loaded)
        let tools = snapshot.items.compactMap { item -> ChatItem.Tool? in
            if case .tool(let tool) = item.role { return tool }
            return nil
        }
        XCTAssertEqual(tools.map(\.callId), Self.calls.indices.map { "c\($0)" })
        XCTAssertEqual(tools.map(\.name), Self.cases.map(\.name))
        XCTAssertTrue(tools.allSatisfy { $0.arguments == Self.arguments && $0.result == Self.result })
        XCTAssertEqual(snapshot.items.filter { $0.role == .agent }.map(\.text), ["Before.", "After."])
        XCTAssertEqual(snapshot.items.filter { $0.role == .agent }.flatMap(\.pieces), [.text("Before."), .text("After.")])
    }

    func testRemovedBlocksAndReplyMetadataDoNotBreakOrdinaryMessagesOrQueuedText() throws {
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(#"{"id":"u","role":"user","createdAt":1,"content":[{"type":"text","text":"Yes"},{"type":"ui","ui":{}},{"type":"action"},{"type":"quick_replies","options":["Yes"]}],"quickReply":{"messageId":"m","index":0}}"#.utf8))
        XCTAssertEqual(message.content, [.text("Yes"), .unknown("ui"), .unknown("action"), .unknown("quick_replies")])
        let queued = try JSONDecoder().decode(QueuedMessage.self, from: Data(#"{"id":"u","agentID":"a","text":"Yes","pictures":[],"quickReply":{"messageId":"m","index":0}}"#.utf8))
        XCTAssertEqual(queued.text, "Yes")
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(queued))
        XCTAssertNil(encoded["quickReply"])
    }

    func testRequestsAndEventStreamDoNotAdvertiseChatWidgets() async throws {
        let server = ToolHistoryServer(message: Self.message)
        let client = AgentClient(transport: server, token: "t")
        _ = try await client.agentMode("a")
        do { _ = try await client.events(after: "cursor") } catch { /* The fixture has no live stream. */ }
        let headers = await server.receivedHeaders
        XCTAssertEqual(headers.count, 2)
        XCTAssertTrue(headers.allSatisfy { $0.keys.allSatisfy { $0.lowercased() != "happy-protocol" } })
        XCTAssertEqual(headers.last?["Last-Event-ID"], "cursor")
    }
}

private actor ToolHistoryServer: AgentTransport {
    let message: JSONValue
    private(set) var receivedHeaders: [[String: String]] = []
    init(message: JSONValue) { self.message = message }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        receivedHeaders.append(headers)
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([
                .object(["id": .string("r"), "status": .string("completed"), "messages": .array([message])]),
            ])])
        } else if path.hasSuffix("/bootstrap") {
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        receivedHeaders.append(headers)
        throw URLError(.cannotConnectToHost)
    }

    func close() {}
}
