import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A conversation whose server answers 404 to its read: an agent since
/// gone, or one a push or a link made up. It says so (`notFound`, with
/// the server's own words), so its screen can, rather than stay empty.
final class ConversationNotFoundTests: XCTestCase {
    /// A server that has the agent only once `appear()` is called, and
    /// otherwise answers `status`.
    actor Server: AgentTransport {
        private var has = false
        private let status: Int
        init(status: Int = 404) { self.status = status }
        func appear() { has = true }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
            guard has else { return .init(status: status, body: Data(#"{"code":"not_found","error":"The agent was not found."}"#.utf8)) }
            let body = path.contains("/messages") ? #"{"hasMore":false,"runs":[]}"#
                : path.hasSuffix("/bootstrap") ? #"{"agent":{"id":"a1","workspaceId":"w","status":"idle","title":"Fresh one"},"pending":[]}"# : "{}"
            return .init(status: 200, body: Data(body.utf8))
        }
        func close() {}
    }

    private func conversation(_ server: Server) -> (Conversation, AsyncStream<ChatSnapshot>.AsyncIterator) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a1")
        return (conversation, conversation.updates.makeAsyncIterator())
    }

    private func next(_ updates: inout AsyncStream<ChatSnapshot>.AsyncIterator, where wanted: (ChatSnapshot) -> Bool) async -> ChatSnapshot? {
        while let snapshot = await updates.next() { if wanted(snapshot) { return snapshot } }
        return nil
    }

    func testAConversationItsServerDoesNotHaveSaysSo() async throws {
        let server = Server()
        var (conversation, updates) = conversation(server)
        await conversation.start()
        await conversation.setVisible(true)
        let read = await next(&updates) { $0.loaded }
        XCTAssertEqual(read?.notFound, true)
        XCTAssertEqual(read?.error, "The agent was not found.")
        XCTAssertEqual(read?.items.isEmpty, true)
        // It is asked again, as any read that failed: there after all, it shows.
        await server.appear()
        let there = await next(&updates) { $0.synced }
        XCTAssertEqual(there?.notFound, false)
        XCTAssertNil(there?.error)
        XCTAssertEqual(there?.title, "Fresh one")
        await conversation.stop()
    }

    /// Only a 404 says it: a server in trouble, or one that refuses the
    /// phone, has said nothing about the agent.
    func testAnyOtherFailureDoesNotSayIt() async throws {
        for status in [500, 503, 403, 429] {
            let server = Server(status: status)
            var (conversation, updates) = conversation(server)
            await conversation.start()
            await conversation.setVisible(true)
            let read = await next(&updates) { $0.loaded }
            XCTAssertEqual(read?.notFound, false, "\(status)")
            XCTAssertNotNil(read?.error, "\(status)")
            await conversation.stop()
        }
    }
}
