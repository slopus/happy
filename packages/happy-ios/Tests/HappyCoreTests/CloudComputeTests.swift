import Foundation
import XCTest
@testable import HappyCore

private actor ComputeTransport: AgentTransport {
    var responses: [HTTP1Response]
    var requests: [(String, String)] = []
    var held: CheckedContinuation<HTTP1Response, Never>?
    var hold = false

    init(_ responses: [HTTP1Response] = []) { self.responses = responses }
    func suspendNext() { hold = true }
    func release(_ response: HTTP1Response) { held?.resume(returning: response); held = nil }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append((method, path))
        if hold {
            hold = false
            return await withCheckedContinuation { held = $0 }
        }
        return responses.isEmpty ? HTTP1Response(status: 500) : responses.removeFirst()
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

@MainActor
final class CloudComputeTests: XCTestCase {
    private static let pool = #"{"id":"default","name":"Default","kind":"shared","default":true,"nodeCounts":{"total":2,"online":1,"offline":0,"draining":0,"enrolling":0,"revoked":1},"sandboxCapacity":{"used":3,"total":null}}"#
    private static let node = #"{"id":"node-1","pool":"default","name":null,"hostname":"worker","status":"online","version":"linux.9","lastSeenAt":1730000000000,"sandboxCapacity":{"used":3,"total":null},"activeSandboxes":[{"sandboxId":"s1","agentId":"a1","agentTitle":null}]}"#
    private var pools: HTTP1Response { response("{\"pools\":[\(Self.pool)]}") }
    private func response(_ json: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(json.utf8)) }

    func testUnknownCapacityAndHostStayUnknownAcrossBAndC() throws {
        let b = try JSONDecoder().decode(ComputeNode.self, from: Data(Self.node.utf8))
        XCTAssertNil(b.host)
        XCTAssertNil(b.sandboxCapacity.total)
        XCTAssertEqual(b.sandboxCapacity.used, 3)
        XCTAssertEqual(b.displayName, "worker")
        XCTAssertNil(b.activeSandboxes[0].agentTitle)
        let c = Self.node.dropLast() + #", "host":{"cpuCores":4,"totalMemoryBytes":8326934528,"totalDiskBytes":null}}"#
        let reported = try JSONDecoder().decode(ComputeNode.self, from: Data(c.utf8))
        XCTAssertEqual(reported.host?.cpuCores, 4)
        XCTAssertEqual(reported.host?.totalMemoryBytes, 8326934528)
        XCTAssertNil(reported.host?.totalDiskBytes)
        let old = Self.node.dropLast() + #", "host":null}"#
        XCTAssertNil(try JSONDecoder().decode(ComputeNode.self, from: Data(old.utf8)).host)
    }

    func testCapacityRejectsMalformedFactsInsteadOfInventingZero() throws {
        for json in [#"{"used":-1,"total":null}"#, #"{"used":1,"total":-1}"#, #"{"used":1}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(ComputeCapacity.self, from: Data(json.utf8)))
        }
        let empty = try JSONDecoder().decode(ComputeCapacity.self, from: Data(#"{"used":0,"total":0}"#.utf8))
        XCTAssertEqual(empty.total, 0)
    }

    func testReadOnlyEndpointsAndEscapedIdentifiers() async throws {
        let transport = ComputeTransport([pools, response("{\"pool\":\(Self.pool),\"nodes\":[\(Self.node)]}"), response("{\"node\":\(Self.node)}")])
        let client = AgentClient(transport: transport, token: "test")
        let listed = try await client.computePools()
        let detail = try await client.computePool("a/b")
        let node = try await client.computeNode("n/?")
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(detail.nodes.count, 1)
        XCTAssertEqual(node.id, "node-1")
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.0), ["GET", "GET", "GET"])
        XCTAssertEqual(requests.map(\.1), ["/v0/compute/pools", "/v0/compute/pools/a%2Fb", "/v0/compute/nodes/n%2F%3F"])
    }

    func testMonitoringRequiresPoolsManageNotComputeUse() {
        XCTAssertFalse(RoleGate.cloud(Permissions(granted: ["compute.use"])).allows(.poolsManage))
        XCTAssertTrue(RoleGate.cloud(Permissions(granted: ["pools.manage"])).allows(.poolsManage))
        XCTAssertFalse(RoleGate.cloud(nil).allows(.poolsManage))
        XCTAssertEqual(SettingsLinkPlace.place(.computes, server: nil), nil)
        XCTAssertEqual(Permissions.refreshEvents, ["role.", "member.updated", "member.removed"])
    }

    func testPermissionLossClearsSnapshotAndStopsRequests() async {
        let transport = ComputeTransport([pools])
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .pools)
        monitor.appear(allowed: true)
        await monitor.reading?.value
        XCTAssertNotNil(monitor.snapshot)
        monitor.authorize(false)
        XCTAssertNil(monitor.snapshot)
        XCTAssertEqual(monitor.failure, .forbidden)
        monitor.refresh()
        let count = await transport.requests.count
        XCTAssertEqual(count, 1)
        monitor.disappear()
    }

    func testTransientFailureRetainsStaleFactsBut403ClearsAndLatches() async {
        let transport = ComputeTransport([pools, HTTP1Response(status: 500), HTTP1Response(status: 403)])
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .pools)
        monitor.appear(allowed: true)
        await monitor.reading?.value
        monitor.refresh()
        await monitor.reading?.value
        XCTAssertNotNil(monitor.snapshot)
        XCTAssertEqual(monitor.failure, .unavailable)
        monitor.refresh()
        await monitor.reading?.value
        XCTAssertNil(monitor.snapshot)
        XCTAssertEqual(monitor.failure, .forbidden)
        monitor.refresh()
        let count = await transport.requests.count
        XCTAssertEqual(count, 3)
        monitor.disappear()
    }

    func testLateResponseCannotRepopulateHiddenPage() async throws {
        let transport = ComputeTransport()
        await transport.suspendNext()
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .pools)
        monitor.appear(allowed: true)
        let reading = try XCTUnwrap(monitor.reading)
        let deadline = ContinuousClock.now + .seconds(3)
        while await transport.held == nil, ContinuousClock.now < deadline { await Task.yield() }
        monitor.disappear(clear: true)
        XCTAssertTrue(reading.isCancelled)
        await transport.release(pools)
        await reading.value
        XCTAssertNil(monitor.snapshot)
        XCTAssertNil(monitor.reading)
    }

    func testCancelledAppearanceCannotClearTheNewRead() async throws {
        let transport = ComputeTransport([pools])
        await transport.suspendNext()
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .pools)
        monitor.appear(allowed: true)
        let old = try XCTUnwrap(monitor.reading)
        let deadline = ContinuousClock.now + .seconds(3)
        while await transport.held == nil, ContinuousClock.now < deadline { await Task.yield() }
        monitor.disappear()
        monitor.appear(allowed: true)
        let current = try XCTUnwrap(monitor.reading)
        await current.value
        let snapshot = monitor.snapshot
        await transport.release(HTTP1Response(status: 403))
        await old.value
        XCTAssertEqual(monitor.snapshot, snapshot)
        XCTAssertNil(monitor.failure, "the old appearance's refusal cannot replace new facts")
        monitor.disappear()
    }

    func testRepeatedEventsCoalesceAndHiddenRefreshDoesNothing() async throws {
        let transport = ComputeTransport([pools])
        await transport.suspendNext()
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .pools)
        monitor.appear(allowed: true)
        let first = try XCTUnwrap(monitor.reading)
        let deadline = ContinuousClock.now + .seconds(3)
        while await transport.held == nil, ContinuousClock.now < deadline { await Task.yield() }
        for _ in 0..<20 { monitor.refresh() }
        await transport.release(pools)
        await first.value
        await monitor.reading?.value
        let count = await transport.requests.count
        XCTAssertEqual(count, 2)
        monitor.disappear()
        monitor.refresh()
        XCTAssertNil(monitor.reading)
        XCTAssertEqual(ComputeMonitor.refreshEvents, ["compute.nodes.updated", "compute.pools.updated"])
    }

    func testMissingAndSignedOutResponsesNeverKeepProtectedFacts() async {
        for (status, failure) in [(404, ComputeMonitor.Failure.missing), (401, .signedOut)] {
            let transport = ComputeTransport([pools, HTTP1Response(status: status)])
            let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .pools)
            monitor.appear(allowed: true)
            await monitor.reading?.value
            monitor.refresh()
            await monitor.reading?.value
            XCTAssertNil(monitor.snapshot)
            XCTAssertEqual(monitor.failure, failure)
            monitor.disappear()
        }
    }
}