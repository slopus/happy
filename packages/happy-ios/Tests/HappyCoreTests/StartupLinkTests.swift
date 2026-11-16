import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A tunnel that records its warms and answers nothing.
private actor Tunnel: AgentTransport {
    var warms: [Int] = []
    var closed = false
    func warm(_ count: Int) { warms.append(count) }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw PairingError.unavailable
    }
    func close() { closed = true }
}

/// Every tunnel a `StartupLink` made, in order.
private final class Made: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Tunnel] = []
    var all: [Tunnel] { lock.withLock { values } }
    func make() -> Tunnel { lock.withLock { let tunnel = Tunnel(); values.append(tunnel); return tunnel } }
}

/// The open pairing connects at launch, before any account is restored, and
/// its engine takes that tunnel rather than making a second (`StartupLink`).
@MainActor
final class StartupLinkTests: XCTestCase {
    private let backend = AccountsKeychain()
    private lazy var store = KeychainAgentConnectionCredentialStore(backend: backend)
    private let made = Made()
    private lazy var link = StartupLink { [made] _ in made.make() }

    private func value(_ id: String = "device") -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: id, deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
    }

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    /// Paired before, on an earlier launch: what this one finds. The last one paired is open.
    private func paired(_ devices: [String] = ["device"], in directory: URL) async throws -> [String] {
        let earlier = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in IdentityTransport() })
        await earlier.setForeground(false)
        var ids: [String] = []
        for device in devices { ids.append(try await earlier.add(value(device), name: "Mac").id) }
        return ids
    }

    /// The launch's restore, with the link handed over.
    private func restored(_ directory: URL) async throws -> AgentConnections {
        let connections = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in IdentityTransport() })
        connections.startup = link
        try await connections.restore()
        return connections
    }

    func testTheTunnelConnectsBeforeAnyAccountIsRestored() async throws {
        let folder = try directory()
        _ = try await paired(in: folder)
        // No AgentConnections, no scene, no engine: the main client is already connecting.
        await link.start(directory: folder, credentials: store).value
        let tunnel = try XCTUnwrap(made.all.first)
        XCTAssertEqual(made.all.count, 1)
        let warms = await tunnel.warms
        XCTAssertEqual(warms, [0], "the main client alone, no flows")
    }

    func testTheEngineTakesTheSameTunnel() async throws {
        let folder = try directory()
        let id = try await paired(in: folder)[0]
        await link.start(directory: folder, credentials: store).value
        let tunnel = try XCTUnwrap(made.all.first)
        let connections = try await restored(folder)
        let engine = try XCTUnwrap(connections.syncEngine(for: id))
        // The engine's warm goes over the tunnel made at launch.
        try await waitFor("the engine on the launch's tunnel") { await tunnel.warms == [0, 2] }
        XCTAssertEqual(made.all.count, 1, "no second tunnel")
        let closed = await tunnel.closed
        XCTAssertFalse(closed)
        XCTAssertNil(link.take(value()), "taken once")
        await engine.stop()
    }

    func testNothingOpenStartsNothing() async throws {
        // No registry at all: a fresh install, whatever the Keychain holds.
        try store.save(value(), id: "direct-left")
        await link.start(directory: try directory(), credentials: store).value
        XCTAssertTrue(made.all.isEmpty)
        // Paired, but nothing open.
        let folder = try directory()
        _ = try await paired(in: folder)
        let earlier = AgentConnections(credentials: store, directory: folder)
        await earlier.setForeground(false)
        try await earlier.restore()
        try await earlier.select(nil)
        await link.start(directory: folder, credentials: store).value
        XCTAssertTrue(made.all.isEmpty)
    }

    func testAnotherAccountOpeningOrARemovalLetsItGo() async throws {
        let folder = try directory()
        let ids = try await paired(["first", "second"], in: folder)
        await link.start(directory: folder, credentials: store).value
        let tunnel = try XCTUnwrap(made.all.first)
        let connections = try await restored(folder)
        XCTAssertEqual(connections.activeID, ids[1])
        let kept = await tunnel.closed
        XCTAssertFalse(kept, "kept while its connection is the one opening")
        connections.open(ids[0])
        try await waitFor("let go when another opens") { await tunnel.closed }

        let second = StartupLink { [made] _ in made.make() }
        await second.start(directory: folder, credentials: store).value
        let next = try XCTUnwrap(made.all.last)
        XCTAssertNotIdentical(next, tunnel)
        let again = AgentConnections(credentials: store, directory: folder, makeTransport: { _ in IdentityTransport() })
        again.startup = second
        try await again.restore()
        try await again.remove(try XCTUnwrap(again.activeID))
        try await waitFor("let go when removed") { await next.closed }
        XCTAssertNil(second.take(value("first")))
    }

    func testTheBackgroundLetsItGo() async throws {
        let folder = try directory()
        _ = try await paired(in: folder)
        await link.start(directory: folder, credentials: store).value
        let tunnel = try XCTUnwrap(made.all.first)
        let connections = try await restored(folder)
        await connections.setForeground(false)
        try await waitFor("let go in the background") { await tunnel.closed }
        XCTAssertNil(link.take(value()))
    }

    func testAnEngineThatAskedFirstMakesItsOwn() async throws {
        let folder = try directory()
        _ = try await paired(in: folder)
        // The engine asked while the launch was still reading: it made its own.
        XCTAssertNil(link.take(value()))
        await link.start(directory: folder, credentials: store).value
        let tunnel = try XCTUnwrap(made.all.first)
        try await waitFor("this one let go") { await tunnel.closed }
        let warms = await tunnel.warms
        XCTAssertEqual(warms, [], "never connected")
    }

    private func waitFor(_ what: String, _ check: @escaping () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !(await check()) {
            guard Date() < deadline else { return XCTFail("timed out: \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
