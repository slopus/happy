import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// The store hands each event to whoever follows its conversation or its
/// type, found by key: no one else hears it.
final class StoreDeliveryTests: XCTestCase {
    func testATypeIsFollowedWholeOrByEachPartUpToADot() {
        XCTAssertEqual(Set(Store.prefixes(of: "space.sidebar.proposal.updated")),
                       ["space.sidebar.proposal.updated", "space.", "space.sidebar.", "space.sidebar.proposal."])
        XCTAssertEqual(Store.prefixes(of: "hello"), ["hello"])
        XCTAssertEqual(Set(Store.prefixes(of: "todo.")), ["todo."])
    }

    func testEachFollowerHearsOnlyWhatItFollows() async throws {
        let client = AgentClient(transport: Silent(), token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let store = engine.spaces
        let mine = Heard(), other = Heard(), proposals = Heard(), retitled = Heard()
        let streams: [(AsyncStream<Store.ConversationEvent>, Heard)] = [
            (await store.conversationEvents("a"), mine),
            (await store.conversationEvents("b"), other),
            (await store.events(matching: ["space.sidebar.proposal."]), proposals),
            (await store.events(matching: ["agent.updated"]) { $0["payload"]?["changes"]?["title"] != nil }, retitled),
        ]
        let tasks = streams.map { stream, heard in
            Task { for await event in stream { if case .event(let envelope) = event { await heard.add(envelope["type"]?.stringValue ?? "") } } }
        }
        func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue { .object(["type": .string(type), "payload": .object(payload)]) }
        await store.externalEvent(event("message.delta", ["agentId": .string("a")]))
        await store.externalEvent(event("agent.updated", ["agentId": .string("b"), "changes": .object(["updatedAt": .number(1)])]))
        await store.externalEvent(event("agent.updated", ["agentId": .string("b"), "changes": .object(["title": .string("T")])]))
        await store.externalEvent(event("space.sidebar.proposal.updated", [:]))
        await store.externalEvent(event("space.sidebar.changed", [:]))
        try await Task.sleep(for: .milliseconds(200))
        let heard = (await mine.types, await other.types, await proposals.types, await retitled.types)
        XCTAssertEqual(heard.0, ["message.delta"])
        XCTAssertEqual(heard.1, ["agent.updated", "agent.updated"])
        XCTAssertEqual(heard.2, ["space.sidebar.proposal.updated"])
        XCTAssertEqual(heard.3, ["agent.updated"])
        tasks.forEach { $0.cancel() }
    }
}

private actor Heard {
    var types: [String] = []
    func add(_ type: String) { types.append(type) }
}

private actor Silent: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        .init(status: 200, body: Data("{}".utf8))
    }

    func close() {}
}
