import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// Whether the agent a tapped push names is on its server: asked of the
/// server itself, and only a plain "no such agent" keeps its chat shut.
final class PushedAgentTests: XCTestCase {
    /// A server answering `GET /v0/agents/:id` one way.
    actor Server: AgentTransport {
        enum Says: Sendable { case answer(Int, String), fails, nothing }
        let says: Says
        private(set) var asked: [String] = []
        init(_ says: Says) { self.says = says }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            asked.append("\(method) \(path)")
            switch says {
            case .answer(let status, let body): return HTTP1Response(status: status, body: Data(body.utf8))
            case .fails: throw URLError(.cannotConnectToHost)
            case .nothing:
                try await Task.sleep(for: .seconds(30))
                throw URLError(.timedOut)
            }
        }
        func close() {}
    }

    private func ask(_ says: Server.Says, agent: String = "build-agent", limit: Duration = .seconds(2)) async -> (PushedAgent.Answer, [String]) {
        let server = Server(says)
        let answer = await PushedAgent.ask(agent, client: AgentClient(transport: server, token: "t"), limit: limit)
        return (answer, await server.asked)
    }

    func testAnAgentTheServerHasIsThereByItsName() async {
        let (answer, asked) = await ask(.answer(200, #"{"agent":{"id":"build-agent","workspaceId":"w","status":"idle","title":"Preview 24"}}"#))
        XCTAssertEqual(answer, .there(title: "Preview 24"))
        XCTAssertEqual(asked, ["GET /v0/agents/build-agent"])
    }

    func testOneWithNoNameIsThereAllTheSame() async {
        let (answer, _) = await ask(.answer(200, #"{"agent":{"id":"build-agent","title":null}}"#))
        XCTAssertEqual(answer, .there(title: nil))
    }

    func testAnAgentTheServerDoesNotHaveIsGone() async {
        let (answer, asked) = await ask(.answer(404, #"{"code":"not_found","error":"Agent not found."}"#))
        XCTAssertEqual(answer, .gone)
        XCTAssertEqual(asked, ["GET /v0/agents/build-agent"])
    }

    /// Nothing but a 404 says the agent is gone: a server in trouble, one
    /// that refuses the phone, and one out of reach all leave it unknown.
    func testAnyOtherAnswerSaysNeither() async {
        for says in [Server.Says.answer(500, "{}"), .answer(503, ""), .answer(401, "{}"), .answer(403, "{}"), .answer(429, "{}"), .answer(200, "not json"), .fails] {
            let (answer, _) = await ask(says)
            XCTAssertEqual(answer, .unknown, "\(says)")
        }
    }

    /// A tap is not held for a server that says nothing.
    func testAServerThatSaysNothingIsWaitedForOnlySoLong() async {
        let started = ContinuousClock.now
        let (answer, asked) = await ask(.nothing, limit: .milliseconds(150))
        XCTAssertEqual(answer, .unknown)
        XCTAssertEqual(asked.count, 1)
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
    }

    /// A tap that opened by its row meanwhile lets go of the request.
    func testAnAskNoLongerWaitedForIsLetGoOf() async {
        let server = Server(.nothing)
        let started = ContinuousClock.now
        let asking = Task { await PushedAgent.ask("build-agent", client: AgentClient(transport: server, token: "t"), limit: .seconds(20)) }
        for _ in 0..<200 where await server.asked.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        asking.cancel()
        let answer = await asking.value
        XCTAssertEqual(answer, .unknown)
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(10))
    }

    /// The id is the push's, from anyone who holds the relay token: it
    /// goes into the path as one segment, whatever it holds.
    func testTheIdIsOneSegmentOfThePath() async {
        let (_, asked) = await ask(.answer(404, "{}"), agent: "a/../b?c")
        XCTAssertEqual(asked, ["GET /v0/agents/a%2F..%2Fb%3Fc"])
    }
}
