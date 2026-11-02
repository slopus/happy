import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

actor IdentityTransport: AgentTransport {
    var name = "Verified Mac"
    var image = Data([1, 2, 3])
    var etag = "\"v1\""
    var revoked = false
    var noAvatar = false
    var requests: [(String, [String: String])] = []
    var closed = false
    var failuresRemaining = 0
    var patches: [Data] = []
    /// The health `instanceId`, raw: nil leaves it out, as older daemons do.
    var instanceId: String?
    func report(instanceId: String?) { self.instanceId = instanceId }
    func failNext(_ count: Int) { failuresRemaining = count }
    func configure(name: String? = nil, etag: String? = nil, noAvatar: Bool? = nil, revoked: Bool? = nil) {
        if let name { self.name = name }; if let etag { self.etag = etag }; if let noAvatar { self.noAvatar = noAvatar }; if let revoked { self.revoked = revoked }
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append((path, headers))
        if method == "PATCH" {
            patches.append(body ?? Data())
            if let patch = try? JSONSerialization.jsonObject(with: body ?? Data()) as? [String: [String: String]], let next = patch["node"]?["name"] { name = next }
        }
        if failuresRemaining > 0 { failuresRemaining -= 1; throw PairingError.unavailable }
        if revoked { return HTTP1Response(status: 401) }
        switch path {
        case "/v0/health":
            let instance = instanceId.map { #","instanceId":"\#($0)""# } ?? ""
            return HTTP1Response(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}\#(instance)}"#.utf8))
        case "/v0/config":
            let avatar: Any = noAvatar ? NSNull() : ["thumbhash": "same-placeholder"]
            return HTTP1Response(status: 200, body: try JSONSerialization.data(withJSONObject: ["config": ["node": ["name": name, "avatar": avatar]]]))
        case "/v0/node/avatar":
            if headers["If-None-Match"] == etag { return HTTP1Response(status: 304) }
            return HTTP1Response(status: 200, headers: ["content-type": "image/png", "etag": etag], body: image)
        default: throw PairingError.invalidResponse
        }
    }
    func close() { closed = true }
    func paths() -> [String] { requests.map(\.0) }
}

private actor CancelledIdentityTransport: AgentTransport {
    var started = false
    var closed = false
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if path == "/v0/health" {
            started = true
            // Deliver a late successful response after cancellation to prove
            // it cannot recreate a removed account or its cached identity.
            try? await Task.sleep(for: .seconds(30))
            return HTTP1Response(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}}"#.utf8))
        }
        return HTTP1Response(status: 200, body: Data(#"{"config":{"node":{"name":"Late response","avatar":null}}}"#.utf8))
    }
    func close() { closed = true }
}

@MainActor
final class AgentConnectionsTests: XCTestCase {
    func testRepeatedPairingAndFailedPersistenceLeaveExistingClientUsable() async throws {
        let store = FailingAgentCredentialStore()
        let identity = IdentityTransport()
        let manager = AgentConnections(credentials: store, directory: nil, makeTransport: { _ in identity })
        await manager.setForeground(false)
        var original = value()
        original.publicUrl = "https://agent.example"
        let account = try await manager.add(original, name: "Mac")
        let client = manager.transport(original, for: account.id)
        _ = try await client.request("/v0/health", credential: original.deviceToken)
        let repeated = try await manager.add(value(), name: "Mac")
        XCTAssertEqual(repeated.id, account.id)
        XCTAssertEqual(manager.credential(for: account.id)?.publicUrl, original.publicUrl)
        _ = try await client.request("/v0/health", credential: original.deviceToken)

        store.setFailing(true)
        do { _ = try await manager.add(value(), name: "Mac"); XCTFail("failed save accepted") } catch { }
        store.setFailing(false)
        _ = try await client.request("/v0/health", credential: original.deviceToken)
        await identity.configure(revoked: true)
        do { _ = try await manager.add(value(), name: "Mac"); XCTFail("revoked pairing accepted") }
        catch { XCTAssertEqual(error as? PairingError, .revoked) }
        await identity.configure(revoked: false)
        _ = try await client.request("/v0/health", credential: original.deviceToken)
        XCTAssertEqual(manager.credential(for: account.id), original)
        await client.close()
    }
    private func value(_ id: String = "device") -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: id, deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }; return url
    }
    func testSeparateKeychainRecoverySelectionAndRemoval() async throws {
        let backend = AccountsKeychain()
        let store = KeychainAgentConnectionCredentialStore(backend: backend)
        let directory = try directory()
        let manager = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in IdentityTransport() })
        await manager.setForeground(false)
        let first = try await manager.add(value(), name: "Untrusted QR name")
        XCTAssertEqual(first.name, "Verified Mac")
        XCTAssertNil(try backend.copyData(SecureStoreCredentialStore.item.writeTarget))
        XCTAssertEqual(try backend.accounts(service: KeychainAgentConnectionCredentialStore.service), [first.id])
        XCTAssertEqual(try store.all()[first.id], value())
        let registry = try Data(contentsOf: directory.appendingPathComponent("direct-accounts.json"))
        XCTAssertFalse(String(decoding: registry, as: UTF8.self).contains(value().deviceToken))
        XCTAssertFalse(String(decoding: registry, as: UTF8.self).contains(value().address))
        let restored = AgentConnections(credentials: store, directory: directory)
        await restored.setForeground(false); try await restored.restore()
        XCTAssertEqual(restored.activeID, first.id); XCTAssertEqual(restored.accounts.first?.name, "Verified Mac")
        try await restored.remove(first.id)
        XCTAssertTrue(try store.all().isEmpty); XCTAssertNil(restored.activeID); XCTAssertTrue(restored.accounts.isEmpty)
    }
    /// The app deleted and installed again: its Keychain item stays, its
    /// registry doesn't. The computer is not brought back, and its
    /// credential goes.
    func testAReinstallForgetsTheComputersLeftInTheKeychain() async throws {
        let backend = AccountsKeychain()
        let store = KeychainAgentConnectionCredentialStore(backend: backend)
        let installed = try directory()
        let manager = AgentConnections(credentials: store, directory: installed, makeTransport: { _ in IdentityTransport() })
        await manager.setForeground(false)
        let first = try await manager.add(value(), name: "Gone Mac")
        XCTAssertEqual(try store.all().keys.sorted(), [first.id])
        // Same install, launched again: still paired.
        let relaunched = AgentConnections(credentials: store, directory: installed)
        await relaunched.setForeground(false); try await relaunched.restore()
        XCTAssertEqual(relaunched.activeID, first.id)
        // A fresh container beside the same Keychain.
        let reinstalled = AgentConnections(credentials: store, directory: try directory())
        await reinstalled.setForeground(false); try await reinstalled.restore()
        XCTAssertTrue(reinstalled.accounts.isEmpty)
        XCTAssertNil(reinstalled.active)
        XCTAssertTrue(try store.all().isEmpty)
    }

    func testIdentityETagRefreshRenameAndAvatarRemoval() async throws {
        let transport = IdentityTransport()
        let original = AgentConnection(id: "direct-one", name: "QR name")
        let first = try await AgentIdentity.refresh(original, transport: transport, token: "token")
        XCTAssertEqual(first.name, "Verified Mac"); XCTAssertEqual(first.avatar, Data([1, 2, 3]))
        await transport.configure(name: "Renamed Mac")
        let second = try await AgentIdentity.refresh(first, transport: transport, token: "token")
        XCTAssertEqual(second.name, "Renamed Mac"); XCTAssertEqual(second.avatar, first.avatar)
        await transport.configure(etag: "\"v2\"")
        let third = try await AgentIdentity.refresh(second, transport: transport, token: "token")
        XCTAssertEqual(third.avatarETag, "\"v2\"")
        await transport.configure(noAvatar: true)
        let last = try await AgentIdentity.refresh(third, transport: transport, token: "token")
        XCTAssertNil(last.avatar); XCTAssertNil(last.avatarETag)
    }
    /// The health `instanceId` instance links are matched against, kept
    /// only when it is one, and dropped when a daemon stops reporting it.
    func testIdentityKeepsTheHealthInstanceID() async throws {
        let transport = IdentityTransport()
        let original = AgentConnection(id: "direct-one", name: "QR name")
        let none = try await AgentIdentity.refresh(original, transport: transport, token: "token")
        XCTAssertNil(none.instanceId)
        await transport.report(instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2")
        let read = try await AgentIdentity.refresh(none, transport: transport, token: "token")
        XCTAssertEqual(read.instanceId, "k3x9q2m7p0a4b8c1d5e6f7g2")
        XCTAssertEqual(try JSONDecoder().decode(AgentConnection.self, from: JSONEncoder().encode(read)).instanceId, read.instanceId)
        await transport.report(instanceId: "Not-An-Instance")
        let bad = try await AgentIdentity.refresh(read, transport: transport, token: "token")
        XCTAssertNil(bad.instanceId)
    }

    func testInstanceLinksOpenOnlyOnTheirInstallation() {
        let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
        var mine = AgentConnection(id: "mine", name: "Mine"); mine.instanceId = instance
        var again = AgentConnection(id: "again", name: "Same server, signed in again"); again.instanceId = instance
        var other = AgentConnection(id: "other", name: "Other"); other.instanceId = "zzzzzzzzzzzzzzzzzzzzzzzz"
        let older = AgentConnection(id: "older", name: "Older daemon")
        let all = [older, other, mine, again]
        let link = "happy://\(instance)/artifacts/q3report?version=2"
        guard case .open(let id, let opened) = InstanceLinkRoute.route(link, connections: all, active: nil) else { return XCTFail("not opened") }
        XCTAssertEqual(id, "mine")
        XCTAssertEqual(opened.target, .reference(.init(kind: .artifact, id: "q3report", version: 2)))
        guard case .open(let active, _) = InstanceLinkRoute.route(link, connections: all, active: "again") else { return XCTFail("not opened") }
        XCTAssertEqual(active, "again", "the one in use wins")
        XCTAssertEqual(InstanceLinkRoute.route("happy://yyyyyyyyyyyyyyyyyyyyyyyy/artifacts/q3report", connections: all, active: "mine"), .unknownInstance)
        XCTAssertEqual(InstanceLinkRoute.route("happy://artifacts/q3report", connections: all, active: "mine"), .notOpened, "no installation named")
        XCTAssertEqual(InstanceLinkRoute.route("happy://\(instance)/nonsense", connections: all, active: "mine"), .notOpened)
        XCTAssertEqual(InstanceLinkRoute.route("happy-file://agents/a1/Foo.tsx", connections: all, active: "mine"), .notOpened)
        XCTAssertEqual(InstanceLinkRoute.route("happy://session/abc", connections: all, active: "mine"), .notALink)
        XCTAssertEqual(InstanceLinkRoute.route("happy://oauth/callback?code=c", connections: all, active: "mine"), .notALink)
        XCTAssertEqual(InstanceLinkRoute.route("https://example.com", connections: all, active: "mine"), .notALink)
        // A scanned server code for an installation here shows that one.
        XCTAssertEqual(InstanceLinkRoute.connection(for: instance, in: all, active: "again"), "again")
        XCTAssertEqual(InstanceLinkRoute.connection(for: instance, in: all, active: "other"), "mine")
        XCTAssertNil(InstanceLinkRoute.connection(for: "yyyyyyyyyyyyyyyyyyyyyyyy", in: all, active: "mine"))
        // It isn't a Happy link, so it opens nothing as one.
        XCTAssertEqual(InstanceLinkRoute.route("happy://\(instance)/server?url=https%3A%2F%2Fhappy.acme.example%2F", connections: all, active: "mine"), .notOpened)
    }

    func testRenameSendsTheNodeNameAndShowsItAtOnce() async throws {
        let transport = IdentityTransport()
        let manager = AgentConnections(credentials: KeychainAgentConnectionCredentialStore(backend: AccountsKeychain()), directory: try directory(), makeTransport: { _ in transport })
        await manager.setForeground(false)
        let account = try await manager.add(value(), name: "QR name")
        var changes = 0
        manager.onChange = { changes += 1 }
        try await manager.rename(account.id, to: "Studio Mac")
        XCTAssertEqual(manager.accounts.first?.name, "Studio Mac")
        XCTAssertGreaterThan(changes, 0)
        let sent = await transport.patches
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent[0]) as? [String: [String: String]], ["node": ["name": "Studio Mac"]])
    }

    func testRevocationStopsRetryAndBackgroundPauses() async throws {
        let transport = IdentityTransport()
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil, makeTransport: { _ in transport })
        manager.refreshInterval = .milliseconds(5)
        await manager.setForeground(false)
        let account = try await manager.add(value(), name: "Mac")
        await transport.configure(revoked: true)
        await manager.setForeground(true)
        for _ in 0..<100 where manager.accounts.first?.status != .revoked { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(manager.accounts.first?.status, .revoked)
        let count = await transport.paths().count
        try await Task.sleep(for: .milliseconds(30))
        let afterWait = await transport.paths().count
        XCTAssertEqual(afterWait, count)
        await manager.setForeground(false); await manager.setForeground(true)
        let afterForeground = await transport.paths().count
        XCTAssertEqual(afterForeground, count)
        try await manager.remove(account.id)
        XCTAssertTrue(manager.accounts.isEmpty)
        XCTAssertEqual(AgentConnections.retryDelay(0), 1); XCTAssertEqual(AgentConnections.retryDelay(100), 30)
    }
    func testMixedRelayAndAgentSelectionRestoreAndInactiveRemoval() async throws {
        let backend = AccountsKeychain(); let connectionStore = KeychainAgentConnectionCredentialStore(backend: backend)
        let directory = try directory()
        func controller() -> AccountController {
            AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
                accountCredentialStore: KeychainAccountCredentialStore(backend: backend), agentConnectionCredentialStore: connectionStore,
                agentTransport: { _ in IdentityTransport() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
        }
        let account = controller()
        await account.agentConnections.setForeground(false)
        let legacy = Credentials(token: "token", secret: Data(repeating: 4, count: 32))
        try await account.signIn(legacy)
        let legacyID = try XCTUnwrap(account.session?.keys.anonID)
        try await account.addAgentConnection(value(), name: "Mac")
        let agentConnectionID = try XCTUnwrap(account.agentConnections.activeID)
        XCTAssertNil(account.session); XCTAssertEqual(account.accounts.count, 2)
        XCTAssertEqual(account.accounts.filter(\.isActive).map(\.id), [agentConnectionID])
        let restored = controller(); await restored.agentConnections.setForeground(false); await restored.restore()
        XCTAssertNil(restored.session); XCTAssertEqual(restored.agentConnections.activeID, agentConnectionID)
        try await restored.switchAccount(to: legacyID)
        XCTAssertEqual(restored.session?.keys.anonID, legacyID); XCTAssertNil(restored.agentConnections.activeID)
        try await restored.switchAccount(to: agentConnectionID)
        XCTAssertNil(restored.session)
        // The old registry's active legacy ID must not make this inactive
        // removal replace the current direct home.
        try await restored.signOut(accountID: legacyID)
        XCTAssertEqual(restored.agentConnections.activeID, agentConnectionID); XCTAssertNil(restored.session)
        try await restored.signOut(accountID: agentConnectionID)
        XCTAssertTrue(restored.accounts.isEmpty); XCTAssertNil(restored.agentConnections.activeID)
    }
    /// Where a computer is a home of its own: the last choice opens at
    /// launch; with none, a paired computer, never Welcome; and signing the
    /// last Happy account out opens the computer.
    func testFallsBackToAComputer() async throws {
        let backend = AccountsKeychain(); let connectionStore = KeychainAgentConnectionCredentialStore(backend: backend)
        let directory = try directory()
        func controller(fallsBack: Bool = true) -> AccountController {
            let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
                accountCredentialStore: KeychainAccountCredentialStore(backend: backend), agentConnectionCredentialStore: connectionStore,
                agentTransport: { _ in IdentityTransport() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
            account.fallsBackToAgentConnection = fallsBack
            return account
        }
        let account = controller()
        await account.agentConnections.setForeground(false)
        let agentConnectionID = try await { () async throws -> String in
            try await account.addAgentConnection(value(), name: "Mac")
            return try XCTUnwrap(account.agentConnections.activeID)
        }()
        try await account.signIn(Credentials(token: "token", secret: Data(repeating: 4, count: 32)))
        let legacyID = try XCTUnwrap(account.session?.keys.anonID)

        // The Happy account was chosen last: it opens.
        var restored = controller(); await restored.agentConnections.setForeground(false); await restored.restore()
        XCTAssertEqual(restored.session?.keys.anonID, legacyID)
        try await restored.switchAccount(to: agentConnectionID)
        restored = controller(); await restored.agentConnections.setForeground(false); await restored.restore()
        XCTAssertEqual(restored.agentConnections.activeID, agentConnectionID, "the computer chosen last didn't open")

        // Signing the only Happy account out from it opens the computer.
        try await restored.switchAccount(to: legacyID)
        try await restored.signOut(accountID: legacyID)
        XCTAssertEqual(restored.agentConnections.activeID, agentConnectionID)
        if case .agentConnection = restored.state {} else { XCTFail("Welcome instead of the computer") }

        // Nothing chosen at all: the computer, not Welcome; without the
        // fallback, as before.
        try await restored.agentConnections.select(nil)
        let plain = controller(fallsBack: false); await plain.agentConnections.setForeground(false); await plain.restore()
        XCTAssertNil(plain.agentConnections.activeID)
        if case .signedOut = plain.state {} else { XCTFail("opened something without the fallback") }
        let falling = controller(); await falling.agentConnections.setForeground(false); await falling.restore()
        XCTAssertEqual(falling.agentConnections.activeID, agentConnectionID)

        // The old filter's choice: the computer, over a Happy account.
        try await falling.signIn(Credentials(token: "token2", secret: Data(repeating: 5, count: 32)))
        XCTAssertNotNil(falling.session)
        let carried = controller(); await carried.agentConnections.setForeground(false); await carried.restore(openingAgentConnection: true, preferred: "nope")
        XCTAssertEqual(carried.agentConnections.activeID, agentConnectionID)
        XCTAssertNil(carried.session)
        try await carried.signOut(accountID: agentConnectionID)
    }

    /// The Direct connection experiment off: paired computers stay stored
    /// but aren't listed, opened at launch or switched to; hiding the one
    /// open opens the Happy account; showing them again brings them back.
    func testHiddenComputersStayPairedButNeverOpen() async throws {
        let backend = AccountsKeychain(); let connectionStore = KeychainAgentConnectionCredentialStore(backend: backend)
        let directory = try directory()
        func controller(shows: Bool) -> AccountController {
            let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
                accountCredentialStore: KeychainAccountCredentialStore(backend: backend), agentConnectionCredentialStore: connectionStore,
                agentTransport: { _ in IdentityTransport() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
            account.fallsBackToAgentConnection = true
            account.showsAgentConnections = shows
            return account
        }
        let account = controller(shows: true)
        await account.agentConnections.setForeground(false)
        try await account.signIn(Credentials(token: "token", secret: Data(repeating: 4, count: 32)))
        let legacyID = try XCTUnwrap(account.session?.keys.anonID)
        try await account.addAgentConnection(value(), name: "Mac")
        let agentConnectionID = try XCTUnwrap(account.agentConnections.activeID)

        // Hidden while open: the Happy account opens, the computer stays paired.
        await account.setShowsAgentConnections(false)
        XCTAssertEqual(account.session?.keys.anonID, legacyID)
        XCTAssertEqual(account.accounts.map(\.id), [legacyID])
        XCTAssertEqual(account.agentConnections.accounts.map(\.id), [agentConnectionID])
        do {
            try await account.switchAccount(to: agentConnectionID)
            XCTFail("switched to a hidden computer")
        } catch {}

        // At launch, hidden, the computer neither opens nor stands in.
        try await account.signOut(accountID: legacyID)
        if case .signedOut = account.state {} else { XCTFail("a hidden computer stood in for Welcome: \(account.state)") }
        let launched = controller(shows: false); await launched.agentConnections.setForeground(false); await launched.restore()
        if case .signedOut = launched.state {} else { XCTFail("a hidden computer opened at launch") }
        XCTAssertTrue(launched.accounts.isEmpty)

        // Shown again with nothing open: listed, and it opens, as at launch.
        await launched.setShowsAgentConnections(true)
        XCTAssertEqual(launched.accounts.map(\.id), [agentConnectionID])
        XCTAssertEqual(launched.agentConnections.activeID, agentConnectionID)
        if case .agentConnection = launched.state {} else { XCTFail("a shown computer didn't open over Welcome: \(launched.state)") }
        try await launched.signOut(accountID: agentConnectionID)
    }

    func testRemovalAwaitsCancellationAndDiscardsLateIdentity() async throws {
        let store = InMemoryAgentConnectionCredentialStore()
        try store.save(value(), id: "direct-cancel")
        let transport = CancelledIdentityTransport()
        let manager = AgentConnections(credentials: store, directory: nil, makeTransport: { _ in transport })
        try await manager.restore()
        for _ in 0..<100 {
            if await transport.started { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        try await manager.remove("direct-cancel")
        XCTAssertTrue(manager.accounts.isEmpty); XCTAssertTrue(try store.all().isEmpty)
        let closed = await transport.closed
        XCTAssertTrue(closed)
        await manager.setForeground(false); await manager.setForeground(true)
        XCTAssertTrue(manager.accounts.isEmpty)
    }
    func testFailedInstanceRetriesWithoutAffectingAnother() async throws {
        let failing = IdentityTransport(); let healthy = IdentityTransport()
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil, makeTransport: { $0.deviceID == "failing" ? failing : healthy })
        await manager.setForeground(false)
        await failing.failNext(2)
        let first = try await manager.add(value("failing"), name: "First")
        let second = try await manager.add(value("healthy"), name: "Second")
        await manager.setForeground(true)
        for _ in 0..<300 {
            if manager.accounts.allSatisfy({ $0.status == .connected }) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(manager.accounts.first { $0.id == first.id }?.status, .connected)
        XCTAssertEqual(manager.accounts.first { $0.id == second.id }?.status, .connected)
        let attempts = await failing.paths().filter { $0 == "/v0/health" }.count
        XCTAssertGreaterThanOrEqual(attempts, 3)
        await manager.setForeground(false)
        XCTAssertTrue(manager.accounts.allSatisfy { $0.status == .paused })
    }
    func testPeriodicIdentityRefreshStopsInBackgroundAndAfterRemoval() async throws {
        let transport = IdentityTransport()
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil, makeTransport: { _ in transport })
        manager.refreshInterval = .milliseconds(20)
        let account = try await manager.add(value("periodic"), name: "Mac")
        for _ in 0..<100 {
            if await transport.paths().filter({ $0 == "/v0/config" }).count >= 3 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await manager.setForeground(false)
        let count = await transport.paths().count
        try await Task.sleep(for: .milliseconds(60))
        let background = await transport.paths().count
        XCTAssertEqual(background, count)
        try await manager.remove(account.id)
        await manager.setForeground(true)
        try await Task.sleep(for: .milliseconds(60))
        let removed = await transport.paths().count
        XCTAssertEqual(removed, count)
    }
}

private final class FailingAgentCredentialStore: AgentConnectionCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private let base = InMemoryAgentConnectionCredentialStore()
    private var failing = false
    func setFailing(_ value: Bool) { lock.withLock { failing = value } }
    func all() throws -> [String: AgentConnectionCredentials] { try base.all() }
    func save(_ credentials: AgentConnectionCredentials, id: String) throws {
        if lock.withLock({ failing }) { throw PairingError.unavailable }
        try base.save(credentials, id: id)
    }
    func remove(id: String) throws { try base.remove(id: id) }
}