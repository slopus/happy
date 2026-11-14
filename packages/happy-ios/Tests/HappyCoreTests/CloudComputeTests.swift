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
    /// What a member reads of a computer: no host facts or backend.
    private static let member = #"{"id":"node-1","name":null,"hostname":"worker","status":"online","os":"linux","arch":"x86_64","version":"linux.9","osVersion":"6.8","shell":"/bin/bash","lastSeenAt":1730000000000,"since":1729990000000,"description":"GPU box, CUDA 12.4","access":"shared","owner":null,"concurrency":8,"maxConcurrency":16,"agents":[{"id":"a1","title":"Fix login test"},{"id":"a2","title":null}],"boundary":{"available":true,"reason":null}}"#
    /// What a manager reads of the same computer.
    private static let managed = #"{"id":"node-1","name":null,"hostname":"worker","status":"online","version":"linux.9","shell":null,"lastSeenAt":null,"since":1729990000000,"description":null,"access":"shared","owner":null,"concurrency":2,"maxConcurrency":null,"agents":[{"id":"a1","title":null},{"id":"a2","title":null}],"boundary":{"available":false,"reason":"bubblewrap is not installed"},"backend":"bwrap","host":null,"features":{"webSocketTunnels":true,"mcpStdio":true,"releases":true},"enrolledAt":1}"#
    private static let mine = #"{"id":"node-3","name":null,"hostname":"kirills-mbp","status":"offline","os":"macos","since":1,"description":null,"access":"private","owner":"user-me","concurrency":1,"maxConcurrency":null,"agents":[],"boundary":{"available":true,"reason":null}}"#
    private static let approval = #"{"computerId":"node-3","computerName":"kirills-mbp","agentId":"agent-9","agentTitle":null,"createdAt":1730000000000}"#
    private static let install = #"{"access":"private","concurrency":1,"token":"jt","expiresAt":1730003600000,"clusterUrl":"https://acme.happy-clusters.com","commands":{"unix":"curl -fsSL https://get/install.sh | sh","windows":"irm https://get/install.ps1 | iex"},"platforms":["linux-x86_64","linux-aarch64"],"notice":"macOS and Windows computers are not available yet."}"#
    private var computers: HTTP1Response { response("{\"computers\":[\(Self.member)]}") }
    private var approvals: HTTP1Response { response(#"{"approvals":[]}"#) }
    private func response(_ json: String, status: Int = 200) -> HTTP1Response { HTTP1Response(status: status, body: Data(json.utf8)) }
    private func node(_ json: String) throws -> Computer { try JSONDecoder().decode(Computer.self, from: Data(json.utf8)) }
    private func install(_ json: String) throws -> ComputeInstall { try JSONDecoder().decode(ComputeInstall.self, from: Data(json.utf8)) }

    func testAMembersComputerDecodesAccessConcurrencyAgentsAndBoundary() throws {
        let node = try node(Self.member)
        XCTAssertEqual(node.access, .shared)
        XCTAssertNil(node.owner)
        XCTAssertEqual(node.concurrency, 8)
        XCTAssertEqual(node.maxConcurrency, 16)
        XCTAssertEqual(node.agents, [Computer.Agent(id: "a1", title: "Fix login test"), Computer.Agent(id: "a2", title: nil)])
        XCTAssertEqual(node.boundary, Computer.Boundary(available: true, reason: nil))
        XCTAssertFalse(node.full)
        XCTAssertEqual(node.concurrencyRange, 1...16)
        XCTAssertEqual(node.description, "GPU box, CUDA 12.4")
        XCTAssertEqual(node.status, .online)
        XCTAssertEqual(node.displayName, "worker")
        XCTAssertEqual(node.os, "linux")
        XCTAssertEqual(node.shell, "/bin/bash")
        XCTAssertNil(node.host)
        XCTAssertNil(node.backend)
    }

    func testAManagersComputerKeepsUnknownFactsUnknown() throws {
        let node = try node(Self.managed)
        XCTAssertNil(node.description)
        XCTAssertNil(node.host)
        XCTAssertNil(node.shell)
        XCTAssertEqual(node.backend, "bwrap")
        XCTAssertTrue(node.full, "two agents fill a concurrency of two")
        XCTAssertEqual(node.boundary, Computer.Boundary(available: false, reason: "bubblewrap is not installed"))
        XCTAssertEqual(node.concurrencyRange, 1...64, "no known maximum leaves the server's limit")
        let reported = try self.node(Self.managed.replacingOccurrences(of: #""host":null"#, with: #""host":{"cpuCores":4,"totalMemoryBytes":8326934528,"totalDiskBytes":null}"#))
        XCTAssertEqual(reported.host?.cpuCores, 4)
        XCTAssertEqual(reported.host?.totalMemoryBytes, 8326934528)
        XCTAssertNil(reported.host?.totalDiskBytes)
    }

    /// The old modes are gone: a computer without access, concurrency,
    /// agents or boundary isn't one this app reads.
    func testAComputerNeedsTheNewShape() throws {
        XCTAssertEqual(try node(Self.mine).access, .private)
        XCTAssertEqual(try node(Self.mine).owner, "user-me")
        XCTAssertThrowsError(try node(Self.member.replacingOccurrences(of: #""access":"shared""#, with: #""mode":"shared""#)))
        XCTAssertThrowsError(try node(Self.member.replacingOccurrences(of: #""access":"shared""#, with: #""access":"exclusive""#)))
        XCTAssertThrowsError(try node(Self.member.replacingOccurrences(of: #""concurrency":8,"#, with: "")))
        XCTAssertThrowsError(try node(Self.member.replacingOccurrences(of: #""concurrency":8"#, with: #""concurrency":0"#)))
        XCTAssertThrowsError(try node(Self.member.replacingOccurrences(of: #","boundary":{"available":true,"reason":null}"#, with: "")))
    }

    func testWhoMayManageAComputer() throws {
        let shared = try node(Self.member), mine = try node(Self.mine)
        XCTAssertTrue(shared.manageable(by: .manage, userId: "user-me"))
        XCTAssertFalse(shared.manageable(by: .use, userId: "user-me"))
        XCTAssertTrue(mine.manageable(by: .use, userId: "user-me"), "the owner of a private computer")
        XCTAssertFalse(mine.manageable(by: .use, userId: "user-alex"))
        XCTAssertFalse(mine.manageable(by: .none, userId: "user-me"))
        XCTAssertFalse(mine.manageable(by: .use, userId: nil))
        XCTAssertTrue(mine.ownedBy("user-me"))
        XCTAssertFalse(shared.ownedBy(nil))
    }

    func testRoleFollowsComputeUseThenPoolsManage() {
        XCTAssertEqual(ComputeRole(.cloud(Permissions(granted: ["compute.use"]))), .use)
        XCTAssertEqual(ComputeRole(.cloud(Permissions(granted: ["compute.use", "pools.manage"]))), .manage)
        XCTAssertEqual(ComputeRole(.cloud(Permissions(granted: ["pools.manage"]))), .none)
        XCTAssertEqual(ComputeRole(.cloud(nil)), .none)
        XCTAssertEqual(ComputeRole.use.accesses, [.private])
        XCTAssertEqual(ComputeRole.manage.accesses, [.shared, .private])
        XCTAssertEqual(ComputeRole.none.accesses, [])
        XCTAssertEqual(ComputeAccess.shared.defaultConcurrency, 8)
        XCTAssertEqual(ComputeAccess.private.defaultConcurrency, 1)
        XCTAssertEqual(SettingsLinkPlace.place(.computes, server: nil), nil)
    }

    func testApprovalAndInstallDecode() throws {
        let approval = try JSONDecoder().decode(ComputeApproval.self, from: Data(Self.approval.utf8))
        XCTAssertEqual(approval.id, "node-3/agent-9")
        XCTAssertEqual(approval.computerName, "kirills-mbp")
        XCTAssertNil(approval.agentTitle)
        XCTAssertEqual(approval.createdAt, 1730000000000)
        let install = try install(Self.install)
        XCTAssertEqual(install.access, .private)
        XCTAssertEqual(install.concurrency, 1)
        XCTAssertEqual(install.expiresAt, 1730003600000)
        XCTAssertEqual(install.clusterUrl, "https://acme.happy-clusters.com")
        XCTAssertEqual(install.notice, "macOS and Windows computers are not available yet.")
        XCTAssertEqual(install.shown, [ComputeInstall.Command(platforms: [.linux], text: "curl -fsSL https://get/install.sh | sh")],
                       "only the systems with a published build")
        let none = try self.install(Self.install.replacingOccurrences(of: #""commands":{"unix":"curl -fsSL https://get/install.sh | sh","windows":"irm https://get/install.ps1 | iex"}"#, with: #""commands":null"#)
            .replacingOccurrences(of: #""notice":"macOS and Windows computers are not available yet.""#, with: #""notice":null"#))
        XCTAssertNil(none.commands)
        XCTAssertNil(none.notice)
        XCTAssertEqual(none.shown, [])
        XCTAssertThrowsError(try self.install(Self.install.replacingOccurrences(of: #""access":"private""#, with: #""mode":"private""#)))
    }

    /// The commands follow the published builds: one shell command for macOS
    /// and Linux, PowerShell for Windows.
    func testEachPublishedSystemGetsItsCommand() throws {
        func shown(_ platforms: [String]) throws -> [[ComputePlatform]] {
            let list = platforms.map { "\"\($0)\"" }.joined(separator: ",")
            let json = #"{"access":"shared","concurrency":8,"token":"t","expiresAt":1,"clusterUrl":"c","commands":{"unix":"u","windows":"w"},"platforms":[\#(list)],"notice":null}"#
            return try install(json).shown.map(\.platforms)
        }
        XCTAssertEqual(try shown(["linux-x86_64", "linux-aarch64"]), [[.linux]])
        XCTAssertEqual(try shown(["linux-x86_64", "macos-arm64"]), [[.macOS, .linux]])
        XCTAssertEqual(try shown(["linux-x86_64", "macos-arm64", "windows-x86_64"]), [[.macOS, .linux], [.windows]])
        XCTAssertEqual(try shown(["windows-x86_64", "plan9-mips"]), [[.windows]], "a system this app doesn't know is left out")
        XCTAssertEqual(try shown([]), [])
    }

    func testAddingAComputerStepsThroughAccessConcurrencyAndInstall() throws {
        XCTAssertNil(ComputerAdd.start(.none))
        var member = try XCTUnwrap(ComputerAdd.start(.use))
        XCTAssertEqual(member, .choosing(ComputerDraft(access: .private)))
        member.choose(.shared, role: .use)
        XCTAssertEqual(member, .choosing(ComputerDraft(access: .private)), "a member can't add a shared computer")
        XCTAssertEqual(member.draft?.shownConcurrency, 1)
        XCTAssertEqual(try XCTUnwrap(member.create()).json, .object(["access": .string("private")]), "the default concurrency isn't sent")

        var add = try XCTUnwrap(ComputerAdd.start(.manage))
        XCTAssertEqual(add, .choosing(ComputerDraft(access: .shared)))
        XCTAssertEqual(add.draft?.shownConcurrency, 8)
        add.setConcurrency(0)
        add.setConcurrency(65)
        XCTAssertEqual(add.draft?.concurrency, nil, "outside 1…64 is ignored")
        add.setConcurrency(4)
        add.choose(.private, role: .manage)
        XCTAssertEqual(add, .choosing(ComputerDraft(access: .private, concurrency: 4)), "a chosen concurrency stays")
        add.setConcurrency(nil)
        XCTAssertEqual(add.draft?.shownConcurrency, 1, "back to the default, which follows the access")
        add.choose(.shared, role: .manage)
        add.setConcurrency(12)
        let request = try XCTUnwrap(add.create())
        XCTAssertEqual(request, ComputeJoinTokenRequest(ComputerDraft(access: .shared, concurrency: 12)))
        XCTAssertEqual(request.json, .object(["access": .string("shared"), "concurrency": .number(12)]), "no mode, name or description")
        XCTAssertNil(add.create(), "one request at a time")
        add.choose(.private, role: .manage)
        add.setConcurrency(2)
        XCTAssertEqual(add, .creating(ComputerDraft(access: .shared, concurrency: 12)), "no change while the token is minted")
        add.finish(.failure(ComputeFailure("This needs the pools.manage permission.")))
        XCTAssertEqual(add, .failed(ComputerDraft(access: .shared, concurrency: 12), message: "This needs the pools.manage permission."))
        add.choose(.private, role: .manage)
        XCTAssertEqual(add, .choosing(ComputerDraft(access: .private, concurrency: 12)), "a choice takes the refusal back")
        _ = add.create()
        let install = try install(Self.install)
        add.finish(.success(install))
        XCTAssertEqual(add, .shown(install))
        XCTAssertNil(add.draft)
        add.choose(.shared, role: .manage)
        XCTAssertEqual(add, .shown(install), "a shown install has no way back")
    }

    func testEndpointsAndEscapedIdentifiers() async throws {
        let revoked = Self.member.replacingOccurrences(of: #""id":"node-1""#, with: #""id":"gone""#).replacingOccurrences(of: #""status":"online""#, with: #""status":"revoked""#)
        let old = #"{"id":"old","status":"online","mode":"exclusive","exclusiveAgent":null}"#
        let transport = ComputeTransport([
            response("{\"computers\":[\(Self.member),\(revoked),\(old),{\"id\":\"broken\"}]}"),
            response("{\"computer\":\(Self.mine)}"),
            response("{\"approvals\":[\(Self.approval)]}"),
            response(Self.install, status: 201),
            response("{\"computer\":\(Self.member.replacingOccurrences(of: #""concurrency":8"#, with: #""concurrency":3"#))}"),
            response(#"{"released":"a/1"}"#),
            response(#"{"approval":{}}"#),
        ])
        let client = AgentClient(transport: transport, token: "test")
        let listed = try await client.computers()
        XCTAssertEqual(listed.map(\.id), ["node-1"], "revoked, old-shaped and unreadable computers are left out")
        let node = try await client.computer("n/?")
        XCTAssertEqual(node.id, "node-3")
        let approvals = try await client.computerApprovals()
        XCTAssertEqual(approvals.map(\.id), ["node-3/agent-9"])
        _ = try await client.createComputerJoinToken(ComputeJoinTokenRequest(ComputerDraft(access: .private)))
        let saved = try await client.setComputerConcurrency("node-1", 3)
        XCTAssertEqual(saved.concurrency, 3)
        try await client.removeComputerAgent("node-1", agent: "a/1")
        try await client.answerComputerApproval(approvals[0], approve: false)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.0), ["GET", "GET", "GET", "POST", "PATCH", "DELETE", "POST"])
        XCTAssertEqual(requests.map(\.1), [
            "/v0/computers", "/v0/computers/n%2F%3F", "/v0/computers/approvals", "/v0/computers/join-tokens",
            "/v0/computers/node-1", "/v0/computers/node-1/agents/a%2F1", "/v0/computers/approvals/node-3/agent-9",
        ])
        let bodies = await transport.bodies
        XCTAssertEqual(try JSONValue.decode(Data(bodies[3].utf8)), .object(["access": .string("private")]))
        XCTAssertEqual(try JSONValue.decode(Data(bodies[4].utf8)), .object(["concurrency": .number(3)]))
        XCTAssertEqual(try JSONValue.decode(Data(bodies[6].utf8)), .object(["approve": .bool(false)]))
        XCTAssertFalse(requests.contains { $0.1.hasPrefix("/v0/compute/") || $0.1.hasSuffix("/release-lock") }, "no pool, node or release-lock route is called")
    }

    func testTheListReadsComputersAndRequestsOnlineFirstAndNamesOwners() async throws {
        let other = Self.mine.replacingOccurrences(of: #""owner":"user-me""#, with: #""owner":"user-alex""#).replacingOccurrences(of: #""node-3""#, with: #""node-4""#)
        let build = Self.member.replacingOccurrences(of: #""id":"node-1","name":null"#, with: #""id":"node-2","name":"build-01""#)
        let transport = ComputeTransport([
            response("{\"computers\":[\(Self.mine),\(other),\(build),\(Self.member)]}"),
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
