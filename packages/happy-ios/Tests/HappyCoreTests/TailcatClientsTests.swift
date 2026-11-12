import Foundation
@testable import HappyCore
import HappyWire
import Tailcat
import XCTest

/// An agent connection's Tailcat clients by request category, and which
/// category each request is.
final class TailcatClientsTests: XCTestCase {
    private final class Client: @unchecked Sendable {
        let category: RequestCategory
        let key: Data
        private let lock = NSLock()
        private var isClosed = false
        var closed: Bool { lock.withLock { isClosed } }
        init(category: RequestCategory, key: Data) { self.category = category; self.key = key }
        func close() { lock.withLock { isClosed = true } }
    }

    /// Every client made, in order.
    private final class Made: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [Client] = []
        var all: [Client] { lock.withLock { list } }
        func add(_ client: Client) { lock.withLock { list.append(client) } }
    }

    /// A clock the test moves; by default past the second that makes a file request long.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var instant = ContinuousClock.now
        var now: ContinuousClock.Instant { lock.withLock { instant } }
        func advance(_ duration: Duration = .milliseconds(1100)) { lock.withLock { instant += duration } }
    }

    private func pool(_ made: Made, clock: Clock = Clock(), idleTimeout: Duration = .seconds(45)) -> TailcatClients<Client> {
        TailcatClients(now: { clock.now }, idleTimeout: idleTimeout, connect: { category, key in
            let client = Client(category: category, key: try key.publicKey.rawValue)
            made.add(client)
            return client
        }, disconnect: { $0.close() })
    }

    func testTheStreamAndQueriesShareAClientAndFilesHaveTheirOwn() async throws {
        let made = Made()
        let clients = pool(made)
        let realtime = try await clients.lease(.realtime)
        let query = try await clients.lease(.query)
        let file = try await clients.lease(.file)
        XCTAssertIdentical(query.client, realtime.client)
        XCTAssertNotIdentical(file.client, realtime.client)
        XCTAssertEqual(made.all.map(\.category), [.realtime, .file])
        XCTAssertEqual(Set(made.all.map(\.key)).count, 2)
        XCTAssertEqual(clients.count(.query), 1)
        // The next stream or query reuses the shared client, busy or not.
        let realtimeAgain = try await clients.lease(.realtime)
        let queryAgain = try await clients.lease(.query)
        XCTAssertIdentical(realtimeAgain.client, realtime.client)
        XCTAssertIdentical(queryAgain.client, realtime.client)
        file.release()
        let fileAgain = try await clients.lease(.file)
        XCTAssertIdentical(fileAgain.client, file.client)
        XCTAssertEqual(made.all.count, 2)
    }

    func testParallelSmallFilesShareOneClient() async throws {
        let made = Made()
        let clients = pool(made)
        let leases = try await withThrowingTaskGroup(of: TailcatClients<Client>.Lease.self) { group in
            for _ in 1...10 { group.addTask { try await clients.lease(.file) } }
            var leases: [TailcatClients<Client>.Lease] = []
            for try await lease in group { leases.append(lease) }
            return leases
        }
        XCTAssertEqual(made.all.count, 1)
        XCTAssertTrue(leases.allSatisfy { $0.client === made.all[0] })
        for lease in leases { lease.release() }
        await clients.close()
    }

    func testLongFilesSpreadOverAtMostThreeClients() async throws {
        let made = Made(), clock = Clock()
        let clients = pool(made, clock: clock)
        var leases: [TailcatClients<Client>.Lease] = []
        for _ in 1...10 {
            leases.append(try await clients.lease(.file))
            clock.advance()
        }
        XCTAssertEqual(clients.count(.file), maxFileClients)
        XCTAssertEqual(made.all.count, 3)
        XCTAssertEqual(Set(made.all.map(\.key)).count, 3)
        XCTAssertEqual(Set(leases.prefix(3).map { ObjectIdentifier($0.client) }).count, 3)
        XCTAssertIdentical(leases[3].client, made.all[0])
        XCTAssertIdentical(leases[4].client, made.all[1])
        // An idle client is used before any busy one.
        for lease in leases where lease.client === made.all[2] { lease.release() }
        let next = try await clients.lease(.file)
        XCTAssertIdentical(next.client, made.all[2])
        XCTAssertEqual(clients.count(.query), 0)
        await clients.close()
    }

    func testCompletedLongRequestDoesNotTriggerExpansion() async throws {
        let made = Made(), clock = Clock()
        let clients = pool(made, clock: clock)
        let long = try await clients.lease(.file)
        clock.advance()
        long.release()
        let short = try await clients.lease(.file)
        let next = try await clients.lease(.file)
        XCTAssertIdentical(short.client, next.client)
        XCTAssertEqual(made.all.count, 1)
        await clients.close()
    }

    func testIdleExtraClientClosesButBaseAndBusyClientStay() async throws {
        let made = Made(), clock = Clock()
        let clients = pool(made, clock: clock, idleTimeout: .milliseconds(10))
        let first = try await clients.lease(.file)
        clock.advance()
        let second = try await clients.lease(.file)
        clock.advance()
        let third = try await clients.lease(.file)
        first.release()
        second.release()
        second.release()
        for _ in 0..<100 where !second.client.closed { try await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(second.client.closed)
        XCTAssertFalse(first.client.closed)
        XCTAssertFalse(third.client.closed)
        XCTAssertEqual(clients.count(.file), 2)
        await clients.close()
    }

    func testReusingExtraCancelsItsIdleClose() async throws {
        let made = Made(), clock = Clock()
        let clients = pool(made, clock: clock, idleTimeout: .milliseconds(10))
        _ = try await clients.lease(.file)
        clock.advance()
        let extra = try await clients.lease(.file)
        extra.release()
        let reused = try await clients.lease(.file)
        XCTAssertIdentical(extra.client, reused.client)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(reused.client.closed)
        XCTAssertEqual(clients.count(.file), 2)
        reused.release()
        for _ in 0..<100 where !reused.client.closed { try await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(reused.client.closed)
        await clients.close()
    }

    func testAFailedClientIsResetAloneAndReconnectsUnderANewKey() async throws {
        let made = Made(), clock = Clock()
        let clients = pool(made, clock: clock)
        let realtime = try await clients.lease(.realtime)
        let query = try await clients.lease(.query)
        let first = try await clients.lease(.file)
        clock.advance()
        let second = try await clients.lease(.file)
        XCTAssertNotIdentical(first.client, second.client)
        await clients.reset(second)
        XCTAssertTrue(second.client.closed)
        XCTAssertEqual([realtime, query, first].map(\.client.closed), [false, false, false])
        // The next file request goes to the idle place, which connects again under a key no client had.
        second.release()
        let again = try await clients.lease(.file)
        XCTAssertIdentical(again.slot, second.slot)
        XCTAssertNotIdentical(again.client, second.client)
        XCTAssertEqual(Set(made.all.map(\.key)).count, 4)
        // A late reset for the old failure leaves the new client be.
        await clients.reset(second)
        XCTAssertFalse(again.client.closed)
        let realtimeAgain = try await clients.lease(.realtime)
        XCTAssertIdentical(realtimeAgain.client, realtime.client)
    }

    func testResettingFilesLeavesTheSharedClient() async throws {
        let made = Made()
        let clients = pool(made)
        let realtime = try await clients.lease(.realtime)
        var files: [TailcatClients<Client>.Lease] = []
        for _ in 1...3 { files.append(try await clients.lease(.file)) }
        await clients.reset(.file)
        XCTAssertTrue(files.allSatisfy(\.client.closed))
        XCTAssertFalse(realtime.client.closed)
    }

    /// A move (`SyncEngine.moved`) resets `.realtime`: the shared client is
    /// made again for the stream and the queries both, and files stay.
    func testResettingTheStreamRemakesTheSharedClient() async throws {
        let made = Made()
        let clients = pool(made)
        let realtime = try await clients.lease(.realtime)
        let file = try await clients.lease(.file)
        await clients.reset(.realtime)
        XCTAssertTrue(realtime.client.closed)
        XCTAssertFalse(file.client.closed)
        let query = try await clients.lease(.query)
        let stream = try await clients.lease(.realtime)
        XCTAssertNotIdentical(query.client, realtime.client)
        XCTAssertIdentical(stream.client, query.client)
        XCTAssertEqual(made.all.count, 3)
    }

    /// A query that timed out while the stream's heartbeats came keeps the
    /// shared client, so the stream stays; once nothing came for
    /// `carrierHeardWithin`, the next failure lets it go.
    func testAFailedQueryKeepsTheSharedClientWhileItIsHeard() async throws {
        let made = Made()
        let clock = Clock()
        let clients = pool(made, clock: clock)
        let stream = try await clients.lease(.realtime)
        let query = try await clients.lease(.query)
        clock.advance(.seconds(15))
        stream.heard()
        clock.advance(.seconds(15))
        await clients.reset(query, ifSilent: true)
        XCTAssertFalse(stream.client.closed)
        query.release()
        let next = try await clients.lease(.query)
        XCTAssertIdentical(next.client, stream.client)

        clock.advance(.seconds(10))
        let late = try await clients.lease(.query)
        await clients.reset(late, ifSilent: true)
        XCTAssertTrue(stream.client.closed)
        let remade = try await clients.lease(.query)
        XCTAssertNotIdentical(remade.client, stream.client)
    }

    /// The stream's own failure, and any file's, resets its client whatever was heard.
    func testTheStreamsFailureResetsTheSharedClient() async throws {
        let made = Made()
        let clients = pool(made)
        let stream = try await clients.lease(.realtime)
        let file = try await clients.lease(.file)
        stream.heard()
        file.heard()
        await clients.reset(file, ifSilent: true)
        XCTAssertTrue(file.client.closed)
        XCTAssertFalse(stream.client.closed)
        await clients.reset(stream)
        XCTAssertTrue(stream.client.closed)
    }

    func testCloseClosesEveryClientAndNothingConnectsAfter() async throws {
        let made = Made()
        let clients = pool(made)
        _ = try await clients.lease(.realtime)
        _ = try await clients.lease(.query)
        _ = try await clients.lease(.file)
        _ = try await clients.lease(.file)
        await clients.close()
        XCTAssertTrue(made.all.allSatisfy(\.closed))
        do { _ = try await clients.lease(.query); XCTFail("leased after close") } catch is CancellationError {}
        XCTAssertEqual(made.all.count, 2)
    }

    func testAFailedConnectIsTriedAgain() async throws {
        let attempts = Made()
        let clients = TailcatClients<Client>(connect: { category, key in
            let client = Client(category: category, key: try key.publicKey.rawValue)
            attempts.add(client)
            if attempts.all.count == 1 { throw PairingError.unavailable }
            return client
        }, disconnect: { $0.close() })
        do { _ = try await clients.lease(.file); XCTFail("expected a failure") } catch PairingError.unavailable {}
        _ = try await clients.lease(.file)
        XCTAssertEqual(clients.count(.file), 1)
        XCTAssertEqual(attempts.all.count, 2)
    }

    func testTheTransportPutsEachKindOfTrafficOnItsCategory() async throws {
        let asked = Made()
        let transport = TailcatHTTPTransport(port: 24781) { category, key in
            asked.add(Client(category: category, key: try key.publicKey.rawValue))
            throw PairingError.unavailable
        }
        _ = try? await transport.request(method: "GET", path: "/v0/bootstrap/desktop", credential: "token", body: nil, headers: [:])
        _ = try? await transport.request(method: "GET", path: "/v0/bots/b1/avatar", credential: "token", body: nil, headers: [:], category: .file)
        _ = try? await transport.upload(path: "/v0/workspaces/w1/file", credential: "token", body: Data("{}".utf8))
        _ = try? await transport.send(method: "POST", path: "/v0/agents/a1/send", credential: "token", body: Data("{}".utf8), category: .file) { _ in }
        _ = try? await transport.stream(path: "/v0/events/stream", credential: "token", headers: [:])
        _ = try? await transport.browserConnection()
        XCTAssertEqual(asked.all.map(\.category), [.realtime, .file, .file, .file, .realtime, .file])
        XCTAssertEqual(Set(asked.all.map(\.key)).count, 6)
    }

    // MARK: Call sites

    /// What each request was sent as.
    private actor Recorder: AgentTransport {
        var seen: [String] = []

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            try await request(method: method, path: path, credential: credential, body: body, headers: headers, category: .query)
        }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
            seen.append("\(method) \(path) \(category)")
            switch path {
            case "/v0/health": return HTTP1Response(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}}"#.utf8))
            case "/v0/config": return HTTP1Response(status: 200, body: Data(#"{"config":{"node":{"name":"Studio","avatar":{"thumbhash":"x"}}}}"#.utf8))
            case "/v0/profile/photo" where method == "PUT":
                return HTTP1Response(status: 200, body: Data(#"{"profile":{"version":"1","name":"Steve"}}"#.utf8))
            default: return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: Data([1]))
            }
        }

        func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
            seen.append("\(method) \(path) \(category) progress")
            return HTTP1Response(status: 200, body: Data("{}".utf8))
        }

        func reset(_ category: RequestCategory) async { seen.append("reset \(category)") }

        func close() async {}
    }

    func testTheEndpointPassesTheCategoryOn() async throws {
        let base = Recorder()
        let endpoint = AgentEndpoint(AgentConnectionCredentials(address: "tailcat", port: 24781, deviceID: "device", deviceToken: "token")) { _ in }
        let transport = AgentEndpointTransport(endpoint: endpoint) { _ in base }
        _ = try await transport.request(method: "GET", path: "/v0/agents/a1/files/x", credential: "token", body: nil, headers: [:], category: .file)
        _ = try await transport.send(method: "POST", path: "/v0/agents/a1/send", credential: "token", body: Data(), category: .file) { _ in }
        await transport.reset(.realtime)
        let seen = await base.seen
        XCTAssertEqual(seen, ["GET /v0/agents/a1/files/x file", "POST /v0/agents/a1/send file progress", "reset realtime"])
        await transport.close()
    }

    func testCallSitesTagTheirCategory() async throws {
        let agent = Recorder()
        let client = AgentClient(transport: agent, token: "token")
        let mode = AgentWire.Mode(providerId: "claude", modelId: "anthropic/sonnet-5", effort: "high", serviceTier: nil, permissionMode: "auto")
        _ = try await client.health()
        _ = try await client.media("a1", toolCallId: "t1", index: 0)
        _ = try await client.artifactFile("r1", version: 2, path: "report.md")
        _ = try await client.image("/v0/bots/b1/avatar")
        try await client.sendMessage("a1", id: "m1", text: "hi", images: [], mode: mode)
        try await client.sendMessage("a1", id: "m2", text: "", images: [(mimeType: "image/png", data: Data([1]))], mode: mode)
        try await client.sendMessage("a1", id: "m3", text: "", images: [(mimeType: "image/png", data: Data([1]))], mode: mode) { _ in }
        _ = try? await client.setProfilePhoto(Data([1]), contentType: "image/jpeg")
        _ = try await AgentIdentity.refresh(AgentConnection(id: "c1", name: "Studio"), transport: agent, token: "token")
        let seen = await agent.seen
        XCTAssertEqual(seen, [
            "GET /v0/health query",
            "GET /v0/agents/a1/tool-calls/t1/media/0 file",
            "GET /v0/artifacts/r1/versions/2/files/report.md file",
            "GET /v0/bots/b1/avatar file",
            "POST /v0/agents/a1/send query",
            "POST /v0/agents/a1/send file",
            "POST /v0/agents/a1/send file progress",
            "PUT /v0/profile/photo file",
            "GET /v0/health query",
            "GET /v0/config query",
            "GET /v0/node/avatar file",
        ])
    }

    func testMeteringCountsFilesOnMediaAndResetsOneCategory() async throws {
        actor Resets: AgentTransport {
            var categories: [RequestCategory] = []
            func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
                HTTP1Response(status: 200)
            }
            func reset(_ category: RequestCategory) async { categories.append(category) }
            func close() async {}
        }
        let base = Resets()
        let metrics = ConnectionMetrics()
        let metered = MeteredAgentTransport(base: base, metrics: metrics)
        _ = try await metered.request(method: "GET", path: "/v0/bots/b1/avatar", credential: "token", body: nil, headers: [:], category: .file)
        _ = try await metered.request(method: "GET", path: "/v0/bots/b1", credential: "token", body: nil, headers: [:], category: .query)
        await metered.reset(.realtime)
        let totals = await metrics.snapshot().totals
        XCTAssertEqual(totals.count(.requests2xx, .media), 1)
        XCTAssertEqual(totals.count(.requests2xx, .tailcat), 1)
        let reset = await base.categories
        XCTAssertEqual(reset, [.realtime])
    }
}
