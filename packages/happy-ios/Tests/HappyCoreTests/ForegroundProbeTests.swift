import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Back from the background, the tunnels an engine kept through the
/// suspension look for every way to the computer again before its stream
/// asks them for anything, as after a network change on screen.
@MainActor
final class ForegroundProbeTests: XCTestCase {
    /// A computer that answers the identity checks, refuses everything
    /// else, and writes down what the engine asked and when its transport
    /// was told it came back.
    private actor Computer: AgentTransport {
        /// How long waking its tunnels takes: a relay iOS reclaimed in the
        /// suspension, connected again over a network still coming back.
        private let waking: Duration
        init(waking: Duration = .zero) { self.waking = waking }
        private(set) var log: [String] = []
        func mark(_ text: String) { log.append(text) }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            switch path {
            case "/v0/health": return HTTP1Response(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}}"#.utf8))
            case "/v0/config": return HTTP1Response(status: 200, body: Data(#"{"config":{"node":{"name":"Studio","avatar":null}}}"#.utf8))
            default:
                log.append(path)
                return HTTP1Response(status: 503, body: Data("{}".utf8))
            }
        }
        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
            log.append(path)
            throw PairingError.unavailable
        }
        func resumed() async {
            log.append("resumed")
            try? await Task.sleep(for: waking)
        }
        func close() async {}
    }

    private func credentials(_ id: String) -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: id, deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
    }

    private func wait(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<500 {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out", file: file, line: line)
    }

    /// What came after `mark`.
    private func since(_ mark: String, _ computer: Computer) async -> [String] {
        let log = await computer.log
        return Array(log.drop { $0 != mark }.dropFirst())
    }

    func testReturningProbesTheOpenComputerBeforeItsStreamAsks() async throws {
        let computer = Computer()
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil, makeTransport: { _ in computer })
        let account = try await manager.add(credentials("mac"), name: "Mac")
        let engine = try XCTUnwrap(manager.syncEngine(for: account.id))
        defer { Task { await engine.stop() } }
        // Up before the background: its transport holds the tunnels.
        try await wait { await computer.log.contains { $0 != "resumed" } }

        await manager.setForeground(false)
        await computer.mark("background")
        await manager.setForeground(true)
        try await wait { await self.since("background", computer).count >= 2 }
        let after = await since("background", computer)
        XCTAssertEqual(after.first, "resumed", "the engine asked before its tunnels probed: \(after)")
        XCTAssertEqual(after.filter { $0 == "resumed" }.count, 1)

        // Active again without having been in the background (Control
        // Center, a system sheet): nothing kept went stale.
        await computer.mark("active")
        await manager.setForeground(true)
        try await Task.sleep(for: .milliseconds(50))
        let again = await since("active", computer)
        XCTAssertFalse(again.contains("resumed"), "\(again)")
    }

    /// A wake that hangs on its relay holds neither the engine nor the
    /// pairing's check: the header said "connecting…" for as long as the
    /// wake took.
    func testASlowWakeHoldsNeitherTheEngineNorTheCheck() async throws {
        let computer = Computer(waking: .seconds(60))
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil, makeTransport: { _ in computer })
        manager.wakeLimit = .milliseconds(200)
        let account = try await manager.add(credentials("mac"), name: "Mac")
        let engine = try XCTUnwrap(manager.syncEngine(for: account.id))
        defer { Task { await engine.stop() } }
        try await wait { await computer.log.contains { $0 != "resumed" } }

        await manager.setForeground(false)
        XCTAssertEqual(manager.accounts.first?.status, .paused)
        await computer.mark("background")
        let returning = Task { await manager.setForeground(true) }
        defer { returning.cancel() }
        // The engine asks the computer, and the pairing's check answers,
        // while the wake is still on its way.
        try await wait { await self.since("background", computer).count >= 2 }
        try await wait { manager.accounts.first?.status == .connected }
        let after = await since("background", computer)
        XCTAssertEqual(after.first, "resumed", "the tunnels weren't woken first: \(after)")
    }

    func testAComputerKeptThroughTheBackgroundProbesWhenOpenedLater() async throws {
        let first = Computer(), second = Computer()
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil, makeTransport: { $0.deviceID == "first" ? first : second })
        let one = try await manager.add(credentials("first"), name: "First")
        let oneEngine = try XCTUnwrap(manager.syncEngine(for: one.id))
        defer { Task { await oneEngine.stop() } }
        try await wait { await first.log.contains { $0 != "resumed" } }
        let two = try await manager.add(credentials("second"), name: "Second")
        let twoEngine = try XCTUnwrap(manager.syncEngine(for: two.id))
        defer { Task { await twoEngine.stop() } }
        try await wait { await second.log.contains { $0 != "resumed" } }

        await manager.setForeground(false)
        await first.mark("background")
        await manager.setForeground(true)
        try await Task.sleep(for: .milliseconds(50))
        let idle = await since("background", first)
        XCTAssertFalse(idle.contains("resumed"), "a computer not open woke its tunnels: \(idle)")

        try await manager.select(one.id)
        try await wait { await self.since("background", first).count >= 2 }
        let after = await since("background", first)
        XCTAssertEqual(after.first, "resumed", "\(after)")

        // Once is enough until the next background.
        await first.mark("again")
        try await manager.select(two.id)
        try await manager.select(one.id)
        try await Task.sleep(for: .milliseconds(50))
        let again = await since("again", first)
        XCTAssertFalse(again.contains("resumed"), "\(again)")
    }

    func testTheEndpointAndMeteringPassItOn() async throws {
        let computer = Computer()
        let endpoint = AgentEndpoint(credentials("mac")) { _ in }
        let transport = AgentEndpointTransport(endpoint: endpoint, metrics: ConnectionMetrics()) { _ in computer }
        // Nothing picked yet: nothing to tell.
        await transport.resumed()
        _ = try await transport.request(method: "GET", path: "/v0/health", credential: "token", body: nil, headers: [:])
        await transport.resumed()
        let log = await computer.log
        XCTAssertEqual(log, ["resumed"])
        await transport.close()
    }

    func testThePoolHandsBackEveryClientAndLetsNoneGo() async throws {
        final class Client: @unchecked Sendable {
            private let lock = NSLock()
            private var isClosed = false
            var closed: Bool { lock.withLock { isClosed } }
            func close() { lock.withLock { isClosed = true } }
        }
        let clients = TailcatClients<Client>(connect: { _, _ in Client() }, disconnect: { $0.close() })
        XCTAssertTrue(clients.connected().isEmpty)
        let realtime = try await clients.lease(.realtime)
        let query = try await clients.lease(.query)
        let upload = try await clients.lease(.file)
        realtime.release(); query.release()
        // Idle or carrying an upload, each is kept to be woken.
        let all = Set(clients.connected().map(ObjectIdentifier.init))
        XCTAssertEqual(all, Set([realtime.client, query.client, upload.client].map(ObjectIdentifier.init)))
        XCTAssertFalse(realtime.client.closed || query.client.closed || upload.client.closed)
        // The next stream goes over the same client.
        let stream = try await clients.lease(.realtime)
        XCTAssertIdentical(stream.client, realtime.client)
        stream.release(); upload.release()
        await clients.close()
    }
}
