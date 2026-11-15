@testable import HappyCore
import HappyWire
import XCTest

final class BrowserComputeTests: XCTestCase {
    func testAnAgentsComputeSaysWhetherItIsThere() throws {
        func compute(_ json: String) throws -> BrowserCompute? { BrowserCompute(compute: try JSONValue.decode(Data(json.utf8))) }
        XCTAssertEqual(try compute(#"{"type":"none"}"#), .detached)
        XCTAssertEqual(try compute(#"{"type":"computer","computerId":"c1","status":"offline"}"#), .detached)
        XCTAssertEqual(try compute(#"{"type":"computer","computerId":"c1","status":"online"}"#), .attached)
        XCTAssertNil(try compute(#"{"type":"computer","computerId":"c1"}"#))
        XCTAssertNil(BrowserCompute(compute: nil))
    }

    func testOnlyTheComputesRefusalsCloseThePage() {
        for (status, code) in [(409, "no_compute"), (503, "compute_offline"), (503, "runner_unavailable"), (503, "draining")] {
            XCTAssertTrue(BrowserCompute.gone(status: status, code: code), "\(status) \(code)")
        }
        for (status, code) in [(409, "conflict"), (503, nil), (502, "compute_offline"), (429, "too_many_tunnels"), (404, "not_found")] as [(Int, String?)] {
            XCTAssertFalse(BrowserCompute.gone(status: status, code: code), "\(status) \(code ?? "nil")")
        }
    }

    func testAPageClosesOnceAndReopensWhenTheComputeIsBack() {
        var gate = BrowserComputeGate()
        XCTAssertNil(gate.apply(.attached))
        XCTAssertEqual(gate.apply(.detached), .close)
        // The compute's own news of a loss a tunnel told first doesn't close it again.
        XCTAssertNil(gate.apply(.detached))
        XCTAssertTrue(gate.closed)
        XCTAssertEqual(gate.apply(.attached), .reopen)
        XCTAssertNil(gate.apply(.attached))
        XCTAssertEqual(gate.apply(.detached), .close)
    }

    func testARefusedTunnelSaysWhenTheComputeIsGone() {
        let origin = "https://compute-\(UUID().uuidString.lowercased()).example"
        let body = { (code: String) in Data(#"{"error":"x","code":"\#(code)"}"#.utf8) }
        XCTAssertEqual(AgentHTTPTransport.classify(TunnelRefusal(status: 503, contentType: "application/json", body: body("compute_offline")), origin: origin) as? BrowserError, .computeGone)
        XCTAssertEqual(AgentHTTPTransport.classify(TunnelRefusal(status: 409, contentType: "application/json", body: body("no_compute")), origin: origin) as? BrowserError, .computeGone)
        XCTAssertEqual(AgentHTTPTransport.classify(TunnelRefusal(status: 503, contentType: "application/json", body: body("unavailable")), origin: origin) as? BrowserError, .upstream(503))
        XCTAssertNil(TunnelSupport.shared.mode(origin))
        XCTAssertFalse(BrowserCompute.gone(status: 503, body: Data("not json".utf8)))
    }

    func testAnAgentsComputeIsFollowedFromItsEventsOnceItHasAStatus() async throws {
        let transport = Agents(computes: [#"{"type":"computer","status":"online"}"#, #"{"type":"computer","status":"offline"}"#])
        let client = AgentClient(transport: transport, token: "test")
        let store = Store(client: client)
        var changes = BrowserAgentCompute(client: client, store: store).changes(agentID: "a1").makeAsyncIterator()
        let first = await changes.next()
        XCTAssertEqual(first, .attached)
        await store.externalEvent(Self.updated("other", compute: #"{"type":"none"}"#))
        await store.externalEvent(Self.updated("a1", compute: nil))
        await store.externalEvent(Self.updated("a1", compute: #"{"type":"none"}"#))
        let detached = await changes.next()
        XCTAssertEqual(detached, .detached)
        // Events may have been lost: the agent is read again.
        await store.externalResync(loadSidebar: false)
        let reread = await changes.next()
        XCTAssertEqual(reread, .detached)
        await store.externalEvent(Self.updated("a1", compute: #"{"type":"computer","status":"online"}"#))
        let back = await changes.next()
        XCTAssertEqual(back, .attached)
    }

    func testAComputersOwnAgentIsNeverClosedForHavingNoCompute() async throws {
        let transport = Agents(computes: [#"{"type":"none"}"#])
        let client = AgentClient(transport: transport, token: "test")
        let store = Store(client: client)
        let changes = BrowserAgentCompute(client: client, store: store).changes(agentID: "a1")
        let reading = Task { var first = changes.makeAsyncIterator(); return await first.next() }
        await transport.waitForRead()
        await store.externalEvent(Self.updated("a1", compute: #"{"type":"none"}"#))
        await store.externalEvent(Self.updated("a1", compute: #"{"type":"computer","status":"online"}"#))
        let first = await reading.value
        XCTAssertEqual(first, .attached)
    }

    private static func updated(_ agentID: String, compute: String?) -> JSONValue {
        var changes: [String: JSONValue] = ["status": .string("idle")]
        if let compute { changes["compute"] = try? JSONValue.decode(Data(compute.utf8)) }
        return .object(["type": .string("agent.updated"), "payload": .object(["agentId": .string(agentID), "changes": .object(changes)])])
    }

    /// `GET /v0/agents/a1`, its compute each read the next of `computes` (the last kept).
    private actor Agents: AgentTransport {
        private var computes: [String]
        private var reads = 0
        private var waiting: [CheckedContinuation<Void, Never>] = []
        init(computes: [String]) { self.computes = computes }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            guard path == "/v0/agents/a1" else { return HTTP1Response(status: 404, body: Data("{}".utf8)) }
            let compute = computes.count > 1 ? computes.removeFirst() : computes[0]
            reads += 1
            for waiter in waiting { waiter.resume() }
            waiting = []
            return HTTP1Response(status: 200, body: Data(#"{"agent":{"id":"a1","workspaceId":"w1","status":"idle","compute":\#(compute)}}"#.utf8))
        }
        func waitForRead() async {
            if reads > 0 { return }
            await withCheckedContinuation { waiting.append($0) }
        }
        nonisolated func close() async {}
    }

    func testThePageHearsOfATunnelRefusedForItsCompute() throws {
        let refusals = BrowserRefusals()
        let heard = Heard()
        refusals.onComputeGone { heard.count += 1 }
        let authority = try XCTUnwrap(BrowserPolicy.Authority(url: XCTUnwrap(URL(string: "http://localhost:5173"))))
        refusals.record(BrowserProxyRefusal(status: 502, code: "browser_proxy_upstream_refused"), for: authority)
        XCTAssertEqual(heard.count, 0)
        let failure = BrowserFailure(BrowserError.computeGone)
        refusals.record(BrowserProxyRefusal(status: failure.status, code: failure.code), for: authority)
        XCTAssertEqual(heard.count, 1)
    }

    private final class Heard: @unchecked Sendable { var count = 0 }
}
