import Foundation
import HappyWire
import XCTest
@testable import HappyCore

private actor ComputeTransport: AgentTransport {
    var responses: [HTTP1Response]
    var requests: [(String, String)] = []
    var bodies: [String] = []
    var held: CheckedContinuation<HTTP1Response, Never>?
    var hold = false

    init(_ responses: [HTTP1Response] = []) { self.responses = responses }
    func suspendNext() { hold = true }
    func release(_ response: HTTP1Response) { held?.resume(returning: response); held = nil }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append((method, path))
        bodies.append(body.map { String(decoding: $0, as: UTF8.self) } ?? "")
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
    /// What a member reads of a node (`MEMBER_FIELDS`): no host, capacity or placements.
    private static let member = #"{"id":"node-1","name":null,"hostname":"worker","status":"online","os":"linux","arch":"x86_64","version":"linux.9","lastSeenAt":1730000000000,"since":1729990000000,"mode":"sandbox","description":"GPU box, CUDA 12.4","owner":null,"exclusiveAgent":null}"#
    /// What a manager reads of the same node.
    private static let managed = #"{"id":"node-1","name":null,"hostname":"worker","status":"online","version":"linux.9","lastSeenAt":1730000000000,"mode":"sandbox","description":null,"owner":null,"exclusiveAgent":null,"sandboxCapacity":{"used":3,"total":null},"host":null,"activeSandboxes":[{"sandboxId":"s1","agentId":"a1","agentTitle":null}]}"#
    private static let held = #"{"id":"node-2","name":"build-01","hostname":"build-01.acme","status":"online","mode":"exclusive","description":null,"owner":null,"exclusiveAgent":{"id":"agent-7","title":"Fix login test"}}"#
    private static let mine = #"{"id":"node-3","name":null,"hostname":"kirills-mbp","status":"offline","os":"macos","mode":"private","description":null,"owner":"user-me","exclusiveAgent":null}"#
    private static let approval = #"{"computerId":"node-3","computerName":"kirills-mbp","agentId":"agent-9","agentTitle":null,"createdAt":1730000000000}"#
    private var computers: HTTP1Response { response("{\"computers\":[\(Self.member)]}") }
    private var approvals: HTTP1Response { response(#"{"approvals":[]}"#) }
    private func response(_ json: String, status: Int = 200) -> HTTP1Response { HTTP1Response(status: status, body: Data(json.utf8)) }
    private func node(_ json: String) throws -> Computer { try JSONDecoder().decode(Computer.self, from: Data(json.utf8)) }

    func testAMembersNodeDecodesItsModeAndDescriptionWithoutMonitoringFacts() throws {
        let node = try node(Self.member)
        XCTAssertEqual(node.mode, .sandbox)
        XCTAssertEqual(node.description, "GPU box, CUDA 12.4")
        XCTAssertEqual(node.status, .online)
        XCTAssertEqual(node.displayName, "worker")
        XCTAssertEqual(node.os, "linux")
        XCTAssertEqual(node.arch, "x86_64")
        XCTAssertNil(node.sandboxCapacity)
        XCTAssertNil(node.host)
        XCTAssertNil(node.activeSandboxes)
    }

    func testAManagersNodeKeepsUnknownFactsUnknown() throws {
        let node = try node(Self.managed)
        XCTAssertNil(node.description)
        XCTAssertNil(node.host)
        XCTAssertNil(node.sandboxCapacity?.total)
        XCTAssertEqual(node.sandboxCapacity?.used, 3)
        XCTAssertNil(node.activeSandboxes?[0].agentTitle)
        let reported = try self.node(Self.managed.replacingOccurrences(of: #""host":null"#, with: #""host":{"cpuCores":4,"totalMemoryBytes":8326934528,"totalDiskBytes":null}"#))
        XCTAssertEqual(reported.host?.cpuCores, 4)
        XCTAssertEqual(reported.host?.totalMemoryBytes, 8326934528)
        XCTAssertNil(reported.host?.totalDiskBytes)
    }

    func testTheModeCarriesItsHolderOrOwner() throws {
        XCTAssertEqual(try node(Self.held).mode, .exclusive(holder: ComputeHolder(id: "agent-7", title: "Fix login test")))
        XCTAssertEqual(try node(Self.held.replacingOccurrences(of: #""title":"Fix login test""#, with: #""title":null"#)).mode,
                       .exclusive(holder: ComputeHolder(id: "agent-7", title: nil)))
        XCTAssertEqual(try node(Self.held.replacingOccurrences(of: #"{"id":"agent-7","title":"Fix login test"}"#, with: "null")).mode, .exclusive(holder: nil))
        XCTAssertEqual(try node(Self.mine).mode, .private(owner: "user-me"))
        XCTAssertEqual(try node(Self.mine.replacingOccurrences(of: #""owner":"user-me""#, with: #""owner":null"#)).mode, .private(owner: nil))
        XCTAssertEqual(try node(Self.member.replacingOccurrences(of: #""mode":"sandbox""#, with: #""mode":"shared""#)).mode, .shared)
        XCTAssertThrowsError(try node(Self.member.replacingOccurrences(of: #""mode":"sandbox""#, with: #""mode":"pool""#)))
    }

    func testWhoMayEditAndRelease() throws {
        let held = try node(Self.held), mine = try node(Self.mine), sandbox = try node(Self.member)
        XCTAssertTrue(held.releasable(by: .manage))
        XCTAssertFalse(held.releasable(by: .use))
        XCTAssertFalse(sandbox.releasable(by: .manage))
        XCTAssertTrue(sandbox.editable(by: .manage, userId: nil))
        XCTAssertFalse(sandbox.editable(by: .use, userId: "user-me"))
        XCTAssertTrue(mine.editable(by: .use, userId: "user-me"))
        XCTAssertFalse(mine.editable(by: .use, userId: "someone-else"))
        XCTAssertFalse(mine.editable(by: .use, userId: nil))
    }

    func testAccessFollowsComputeUseThenPoolsManage() {
        XCTAssertEqual(ComputeAccess(.cloud(Permissions(granted: ["compute.use"]))), .use)
        XCTAssertEqual(ComputeAccess(.cloud(Permissions(granted: ["compute.use", "pools.manage"]))), .manage)
        XCTAssertEqual(ComputeAccess(.cloud(Permissions(granted: ["pools.manage"]))), .none)
        XCTAssertEqual(ComputeAccess(.cloud(nil)), .none)
        XCTAssertEqual(ComputeAccess.use.modes, [.private])
        XCTAssertEqual(ComputeAccess.manage.modes, [.sandbox, .shared, .exclusive, .private])
        XCTAssertEqual(ComputeAccess.none.modes, [])
        XCTAssertEqual(SettingsLinkPlace.place(.computes, server: nil), nil)
    }

    func testApprovalAndInstallDecode() throws {
        let approval = try JSONDecoder().decode(ComputeApproval.self, from: Data(Self.approval.utf8))
        XCTAssertEqual(approval.id, "node-3/agent-9")
        XCTAssertEqual(approval.computerName, "kirills-mbp")
        XCTAssertNil(approval.agentTitle)
        XCTAssertEqual(approval.createdAt, 1730000000000)
        let json = #"{"mode":"private","token":"jt","expiresAt":1730003600000,"clusterUrl":"https://acme.happy-clusters.com","commands":{"unix":"curl -fsSL https://get/install.sh | HAPPY_COMPUTE_MODE='private' sh","windows":"irm https://get/install.ps1 | iex"}}"#
        let install = try JSONDecoder().decode(ComputeInstall.self, from: Data(json.utf8))
        XCTAssertEqual(install.mode, .private)
        XCTAssertEqual(install.expiresAt, 1730003600000)
        XCTAssertEqual(install.clusterUrl, "https://acme.happy-clusters.com")
        XCTAssertEqual(install.shown, [
            ComputeInstall.Command(platforms: [.macOS, .linux], text: "curl -fsSL https://get/install.sh | HAPPY_COMPUTE_MODE='private' sh"),
            ComputeInstall.Command(platforms: [.windows], text: "irm https://get/install.ps1 | iex"),
        ])
        let none = try JSONDecoder().decode(ComputeInstall.self, from: Data(#"{"mode":"sandbox","token":"jt","expiresAt":1,"clusterUrl":"https://c","commands":null}"#.utf8))
        XCTAssertNil(none.commands)
        XCTAssertEqual(none.shown, [])
    }

    /// Windows runs only private computers, macOS no sandbox or shared one.
    func testEachModeShowsOnlyTheCommandsItsSystemsRun() throws {
        func shown(_ mode: String) throws -> [[ComputePlatform]] {
            let json = #"{"mode":"\#(mode)","token":"t","expiresAt":1,"clusterUrl":"c","commands":{"unix":"u","windows":"w"}}"#
            return try JSONDecoder().decode(ComputeInstall.self, from: Data(json.utf8)).shown.map(\.platforms)
        }
        XCTAssertEqual(try shown("sandbox"), [[.linux]])
        XCTAssertEqual(try shown("shared"), [[.linux]])
        XCTAssertEqual(try shown("exclusive"), [[.macOS, .linux]])
        XCTAssertEqual(try shown("private"), [[.macOS, .linux], [.windows]])
    }

    func testAddingAComputerStepsThroughModeDescriptionAndInstall() throws {
        XCTAssertNil(ComputerAdd.start(.none))
        var member = try XCTUnwrap(ComputerAdd.start(.use))
        XCTAssertEqual(member, .choosing(ComputerDraft(mode: .private)))
        member.choose(.sandbox, access: .use)
        XCTAssertEqual(member, .choosing(ComputerDraft(mode: .private)), "a member can't pick a team mode")

        var add = try XCTUnwrap(ComputerAdd.start(.manage))
        XCTAssertEqual(add, .choosing(ComputerDraft(mode: .sandbox)))
        add.edit { $0.name = "ignored" }
        XCTAssertEqual(add.draft?.name, "", "no field before the describing step")
        add.choose(.exclusive, access: .manage)
        add.next()
        add.edit { $0.name = "  build-01 "; $0.description = "\n" }
        XCTAssertEqual(add, .describing(ComputerDraft(mode: .exclusive, name: "  build-01 ", description: "\n")))
        let request = try XCTUnwrap(add.create())
        XCTAssertEqual(request, ComputeJoinTokenRequest(ComputerDraft(mode: .exclusive, name: "build-01")))
        XCTAssertEqual(request.json, .object(["mode": .string("exclusive"), "name": .string("build-01")]))
        XCTAssertNil(add.create(), "one request at a time")
        add.finish(.failure(ComputeFailure("This needs the pools.manage permission.")))
        XCTAssertEqual(add, .failed(ComputerDraft(mode: .exclusive, name: "  build-01 ", description: "\n"), message: "This needs the pools.manage permission."))
        add.edit { $0.description = "CUDA" }
        XCTAssertEqual(add, .describing(ComputerDraft(mode: .exclusive, name: "  build-01 ", description: "CUDA")), "an edit takes the refusal back")
        add.back()
        XCTAssertEqual(add, .choosing(ComputerDraft(mode: .exclusive, name: "  build-01 ", description: "CUDA")))
        add.next()
        _ = add.create()
        let install = try JSONDecoder().decode(ComputeInstall.self, from: Data(#"{"mode":"exclusive","token":"t","expiresAt":1,"clusterUrl":"c","commands":null}"#.utf8))
        add.finish(.success(install))
        XCTAssertEqual(add, .shown(install))
        XCTAssertNil(add.draft)
        add.back()
        XCTAssertEqual(add, .shown(install), "a shown install has no way back")
    }

    func testAPatchSendsOnlyWhatChanged() throws {
        let node = try node(Self.member)
        XCTAssertNil(ComputerPatch(node, name: "worker", description: "GPU box, CUDA 12.4"))
        XCTAssertNil(ComputerPatch(node, name: "  ", description: "anything"), "a computer always has a name")
        XCTAssertEqual(ComputerPatch(node, name: "gpu-1 ", description: "GPU box, CUDA 12.4")?.json, .object(["name": .string("gpu-1")]))
        XCTAssertEqual(ComputerPatch(node, name: "worker", description: " ")?.json, .object(["description": .null]))
        XCTAssertEqual(ComputerPatch(node, name: "worker", description: "CUDA 13")?.json, .object(["description": .string("CUDA 13")]))
    }

    func testEndpointsAndEscapedIdentifiers() async throws {
        let revoked = Self.member.replacingOccurrences(of: #""id":"node-1""#, with: #""id":"gone""#).replacingOccurrences(of: #""status":"online""#, with: #""status":"revoked""#)
        let transport = ComputeTransport([
            response("{\"computers\":[\(Self.member),\(revoked),{\"id\":\"broken\"}]}"),
            response("{\"computer\":\(Self.held)}"),
            response("{\"approvals\":[\(Self.approval)]}"),
            response(#"{"mode":"private","token":"t","expiresAt":1,"clusterUrl":"c","commands":null}"#, status: 201),
            response("{\"computer\":\(Self.member)}"),
            response(#"{"previousHolder":"agent-7"}"#),
            response(#"{"approval":{}}"#),
        ])
        let client = AgentClient(transport: transport, token: "test")
        let listed = try await client.computers()
        XCTAssertEqual(listed.map(\.id), ["node-1"], "revoked and unreadable computers are left out")
        let node = try await client.computer("n/?")
        XCTAssertEqual(node.id, "node-2")
        let approvals = try await client.computerApprovals()
        XCTAssertEqual(approvals.map(\.id), ["node-3/agent-9"])
        _ = try await client.createComputerJoinToken(ComputeJoinTokenRequest(ComputerDraft(mode: .private, description: "laptop")))
        try await client.updateComputer("node-1", try XCTUnwrap(ComputerPatch(listed[0], name: "worker", description: "")))
        let holder = try await client.releaseComputerLock("node-2")
        XCTAssertEqual(holder, "agent-7")
        try await client.answerComputerApproval(approvals[0], approve: false)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.0), ["GET", "GET", "GET", "POST", "PATCH", "POST", "POST"])
        XCTAssertEqual(requests.map(\.1), [
            "/v0/computers", "/v0/computers/n%2F%3F", "/v0/computers/approvals", "/v0/computers/join-tokens",
            "/v0/computers/node-1", "/v0/computers/node-2/release-lock", "/v0/computers/approvals/node-3/agent-9",
        ])
        let bodies = await transport.bodies
        XCTAssertEqual(try JSONValue.decode(Data(bodies[3].utf8)), .object(["mode": .string("private"), "description": .string("laptop")]))
        XCTAssertEqual(try JSONValue.decode(Data(bodies[4].utf8)), .object(["description": .null]))
        XCTAssertEqual(try JSONValue.decode(Data(bodies[6].utf8)), .object(["approve": .bool(false)]))
        XCTAssertFalse(requests.contains { $0.1.hasPrefix("/v0/compute/") }, "neither a pool nor an old node route is called")
    }

    func testTheListReadsComputersAndRequestsOnlineFirstAndNamesOwners() async throws {
        let other = Self.mine.replacingOccurrences(of: #""owner":"user-me""#, with: #""owner":"user-alex""#).replacingOccurrences(of: #""node-3""#, with: #""node-4""#)
        let transport = ComputeTransport([
            response("{\"computers\":[\(Self.mine),\(other),\(Self.held),\(Self.member)]}"),
            response("{\"approvals\":[\(Self.approval)]}"),
            response(#"{"users":[{"id":"user-alex","name":"Alex"}]}"#),
        ])
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computers)
        monitor.appear(allowed: true)
        await monitor.reading?.value
        guard case .computers(let list)? = monitor.snapshot else { return XCTFail("no list") }
        XCTAssertEqual(list.computers.map(\.displayName), ["build-01", "worker", "kirills-mbp", "kirills-mbp"])
        XCTAssertEqual(list.approvals.map(\.id), ["node-3/agent-9"])
        XCTAssertEqual(list.owners, ["user-alex": "Alex"])
        let paths = await transport.requests.map(\.1)
        XCTAssertEqual(Set(paths), ["/v0/computers", "/v0/computers/approvals", "/v0/users?ids=user-alex,user-me"])
        XCTAssertEqual(ComputeMonitor.refreshEvents, ["runners.updated", "compute.nodes.updated", "compute.approvals.updated"])
        monitor.disappear()
    }

    func testPermissionLossClearsSnapshotAndStopsRequests() async {
        let transport = ComputeTransport([computers, approvals])
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computers)
        monitor.appear(allowed: true)
        await monitor.reading?.value
        XCTAssertNotNil(monitor.snapshot)
        monitor.authorize(false)
        XCTAssertNil(monitor.snapshot)
        XCTAssertEqual(monitor.failure, .forbidden)
        monitor.refresh()
        let count = await transport.requests.count
        XCTAssertEqual(count, 2)
        monitor.disappear()
    }

    func testTransientFailureRetainsStaleFactsBut403ClearsAndLatches() async {
        let one = response("{\"computer\":\(Self.member)}")
        let transport = ComputeTransport([one, HTTP1Response(status: 500), HTTP1Response(status: 403)])
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computer("node-1"))
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
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computer("node-1"))
        monitor.appear(allowed: true)
        let reading = try XCTUnwrap(monitor.reading)
        let deadline = ContinuousClock.now + .seconds(3)
        while await transport.held == nil, ContinuousClock.now < deadline { await Task.yield() }
        monitor.disappear(clear: true)
        XCTAssertTrue(reading.isCancelled)
        await transport.release(response("{\"computer\":\(Self.member)}"))
        await reading.value
        XCTAssertNil(monitor.snapshot)
        XCTAssertNil(monitor.reading)
    }

    func testCancelledAppearanceCannotClearTheNewRead() async throws {
        let transport = ComputeTransport([response("{\"computer\":\(Self.member)}")])
        await transport.suspendNext()
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computer("node-1"))
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
        let one = response("{\"computer\":\(Self.member)}")
        let transport = ComputeTransport([one])
        await transport.suspendNext()
        let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computer("node-1"))
        monitor.appear(allowed: true)
        let first = try XCTUnwrap(monitor.reading)
        let deadline = ContinuousClock.now + .seconds(3)
        while await transport.held == nil, ContinuousClock.now < deadline { await Task.yield() }
        for _ in 0..<20 { monitor.refresh() }
        await transport.release(one)
        await first.value
        await monitor.reading?.value
        let count = await transport.requests.count
        XCTAssertEqual(count, 2)
        monitor.disappear()
        monitor.refresh()
        XCTAssertNil(monitor.reading)
    }

    func testMissingAndSignedOutResponsesNeverKeepProtectedFacts() async {
        for (status, failure) in [(404, ComputeMonitor.Failure.missing), (401, .signedOut)] {
            let transport = ComputeTransport([response("{\"computer\":\(Self.member)}"), HTTP1Response(status: status)])
            let monitor = ComputeMonitor(client: AgentClient(transport: transport, token: "test"), page: .computer("node-1"))
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
