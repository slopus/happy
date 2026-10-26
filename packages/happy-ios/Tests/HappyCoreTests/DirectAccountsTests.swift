import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

actor IdentityTransport: DirectTransport {
    var name = "Verified Mac"
    var image = Data([1, 2, 3])
    var etag = "\"v1\""
    var revoked = false
    var noAvatar = false
    var requests: [(String, [String: String])] = []
    var closed = false
    var failuresRemaining = 0
    var patches: [Data] = []
    func failNext(_ count: Int) { failuresRemaining = count }
    func configure(name: String? = nil, etag: String? = nil, noAvatar: Bool? = nil, revoked: Bool? = nil) {
        if let name { self.name = name }; if let etag { self.etag = etag }; if let noAvatar { self.noAvatar = noAvatar }; if let revoked { self.revoked = revoked }
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        requests.append((path, headers))
        if method == "PATCH" {
            patches.append(body ?? Data())
            if let patch = try? JSONSerialization.jsonObject(with: body ?? Data()) as? [String: [String: String]], let next = patch["node"]?["name"] { name = next }
        }
        if failuresRemaining > 0 { failuresRemaining -= 1; throw DirectPairingError.unavailable }
        if revoked { return DirectHTTPResponse(status: 401) }
        switch path {
        case "/v0/health": return DirectHTTPResponse(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}}"#.utf8))
        case "/v0/config":
            let avatar: Any = noAvatar ? NSNull() : ["thumbhash": "same-placeholder"]
            return DirectHTTPResponse(status: 200, body: try JSONSerialization.data(withJSONObject: ["config": ["node": ["name": name, "avatar": avatar]]]))
        case "/v0/node/avatar":
            if headers["If-None-Match"] == etag { return DirectHTTPResponse(status: 304) }
            return DirectHTTPResponse(status: 200, headers: ["content-type": "image/png", "etag": etag], body: image)
        default: throw DirectPairingError.invalidResponse
        }
    }
    func close() { closed = true }
    func paths() -> [String] { requests.map(\.0) }
}

private actor CancelledIdentityTransport: DirectTransport {
    var started = false
    var closed = false
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        if path == "/v0/health" {
            started = true
            // Deliver a late successful response after cancellation to prove
            // it cannot recreate a removed account or its cached identity.
            try? await Task.sleep(for: .seconds(30))
            return DirectHTTPResponse(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}}"#.utf8))
        }
        return DirectHTTPResponse(status: 200, body: Data(#"{"config":{"node":{"name":"Late response","avatar":null}}}"#.utf8))
    }
    func close() { closed = true }
}

@MainActor
final class DirectAccountsTests: XCTestCase {
    private func value(_ id: String = "device") -> DirectDeviceCredentials {
        DirectDeviceCredentials(address: "tcAddress", port: 24781, deviceID: id, deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }; return url
    }
    func testSeparateKeychainRecoverySelectionAndRemoval() async throws {
        let backend = AccountsKeychain()
        let store = KeychainDirectCredentialStore(backend: backend)
        let directory = try directory()
        let manager = DirectAccounts(credentials: store, directory: directory, makeTransport: { _ in IdentityTransport() })
        await manager.setForeground(false)
        let first = try await manager.add(value(), name: "Untrusted QR name")
        XCTAssertEqual(first.name, "Verified Mac")
        XCTAssertNil(try backend.copyData(SecureStoreCredentialStore.item.writeTarget))
        XCTAssertEqual(try backend.accounts(service: KeychainDirectCredentialStore.service), [first.id])
        XCTAssertEqual(try store.all()[first.id], value())
        let registry = try Data(contentsOf: directory.appendingPathComponent("direct-accounts.json"))
        XCTAssertFalse(String(decoding: registry, as: UTF8.self).contains(value().deviceToken))
        XCTAssertFalse(String(decoding: registry, as: UTF8.self).contains(value().address))
        let restored = DirectAccounts(credentials: store, directory: directory)
        await restored.setForeground(false); try await restored.restore()
        XCTAssertEqual(restored.activeID, first.id); XCTAssertEqual(restored.accounts.first?.name, "Verified Mac")
        try await restored.remove(first.id)
        XCTAssertTrue(try store.all().isEmpty); XCTAssertNil(restored.activeID); XCTAssertTrue(restored.accounts.isEmpty)
    }
    func testIdentityETagRefreshRenameAndAvatarRemoval() async throws {
        let transport = IdentityTransport()
        let original = DirectAccount(id: "direct-one", name: "QR name")
        let first = try await DirectIdentity.refresh(original, transport: transport, token: "token")
        XCTAssertEqual(first.name, "Verified Mac"); XCTAssertEqual(first.avatar, Data([1, 2, 3]))
        await transport.configure(name: "Renamed Mac")
        let second = try await DirectIdentity.refresh(first, transport: transport, token: "token")
        XCTAssertEqual(second.name, "Renamed Mac"); XCTAssertEqual(second.avatar, first.avatar)
        await transport.configure(etag: "\"v2\"")
        let third = try await DirectIdentity.refresh(second, transport: transport, token: "token")
        XCTAssertEqual(third.avatarETag, "\"v2\"")
        await transport.configure(noAvatar: true)
        let last = try await DirectIdentity.refresh(third, transport: transport, token: "token")
        XCTAssertNil(last.avatar); XCTAssertNil(last.avatarETag)
    }
    func testRenameSendsTheNodeNameAndShowsItAtOnce() async throws {
        let transport = IdentityTransport()
        let manager = DirectAccounts(credentials: KeychainDirectCredentialStore(backend: AccountsKeychain()), directory: try directory(), makeTransport: { _ in transport })
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
        let manager = DirectAccounts(credentials: InMemoryDirectCredentialStore(), directory: nil, makeTransport: { _ in transport })
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
        XCTAssertEqual(DirectAccounts.retryDelay(0), 1); XCTAssertEqual(DirectAccounts.retryDelay(100), 30)
    }
    func testMixedLegacyDirectSelectionRestoreAndInactiveRemoval() async throws {
        let backend = AccountsKeychain(); let directStore = KeychainDirectCredentialStore(backend: backend)
        let directory = try directory()
        func controller() -> AccountController {
            AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
                accountCredentialStore: KeychainAccountCredentialStore(backend: backend), directCredentialStore: directStore,
                directTransport: { _ in IdentityTransport() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
        }
        let account = controller()
        await account.direct.setForeground(false)
        let legacy = Credentials(token: "token", secret: Data(repeating: 4, count: 32))
        try await account.signIn(legacy)
        let legacyID = try XCTUnwrap(account.session?.keys.anonID)
        try await account.addDirect(value(), name: "Mac")
        let directID = try XCTUnwrap(account.direct.activeID)
        XCTAssertNil(account.session); XCTAssertEqual(account.accounts.count, 2)
        XCTAssertEqual(account.accounts.filter(\.isActive).map(\.id), [directID])
        let restored = controller(); await restored.direct.setForeground(false); await restored.restore()
        XCTAssertNil(restored.session); XCTAssertEqual(restored.direct.activeID, directID)
        try await restored.switchAccount(to: legacyID)
        XCTAssertEqual(restored.session?.keys.anonID, legacyID); XCTAssertNil(restored.direct.activeID)
        try await restored.switchAccount(to: directID)
        XCTAssertNil(restored.session)
        // The old registry's active legacy ID must not make this inactive
        // removal replace the current direct home.
        try await restored.signOut(accountID: legacyID)
        XCTAssertEqual(restored.direct.activeID, directID); XCTAssertNil(restored.session)
        try await restored.signOut(accountID: directID)
        XCTAssertTrue(restored.accounts.isEmpty); XCTAssertNil(restored.direct.activeID)
    }
    /// Where a computer is a home of its own: the last choice opens at
    /// launch; with none, a paired computer, never Welcome; and signing the
    /// last Happy account out opens the computer.
    func testFallsBackToAComputer() async throws {
        let backend = AccountsKeychain(); let directStore = KeychainDirectCredentialStore(backend: backend)
        let directory = try directory()
        func controller(fallsBack: Bool = true) -> AccountController {
            let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
                accountCredentialStore: KeychainAccountCredentialStore(backend: backend), directCredentialStore: directStore,
                directTransport: { _ in IdentityTransport() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
            account.fallsBackToComputer = fallsBack
            return account
        }
        let account = controller()
        await account.direct.setForeground(false)
        let directID = try await { () async throws -> String in
            try await account.addDirect(value(), name: "Mac")
            return try XCTUnwrap(account.direct.activeID)
        }()
        try await account.signIn(Credentials(token: "token", secret: Data(repeating: 4, count: 32)))
        let legacyID = try XCTUnwrap(account.session?.keys.anonID)

        // The Happy account was chosen last: it opens.
        var restored = controller(); await restored.direct.setForeground(false); await restored.restore()
        XCTAssertEqual(restored.session?.keys.anonID, legacyID)
        try await restored.switchAccount(to: directID)
        restored = controller(); await restored.direct.setForeground(false); await restored.restore()
        XCTAssertEqual(restored.direct.activeID, directID, "the computer chosen last didn't open")

        // Signing the only Happy account out from it opens the computer.
        try await restored.switchAccount(to: legacyID)
        try await restored.signOut(accountID: legacyID)
        XCTAssertEqual(restored.direct.activeID, directID)
        if case .direct = restored.state {} else { XCTFail("Welcome instead of the computer") }

        // Nothing chosen at all: the computer, not Welcome; without the
        // fallback, as before.
        try await restored.direct.select(nil)
        let plain = controller(fallsBack: false); await plain.direct.setForeground(false); await plain.restore()
        XCTAssertNil(plain.direct.activeID)
        if case .signedOut = plain.state {} else { XCTFail("opened something without the fallback") }
        let falling = controller(); await falling.direct.setForeground(false); await falling.restore()
        XCTAssertEqual(falling.direct.activeID, directID)

        // The old filter's choice: the computer, over a Happy account.
        try await falling.signIn(Credentials(token: "token2", secret: Data(repeating: 5, count: 32)))
        XCTAssertNotNil(falling.session)
        let carried = controller(); await carried.direct.setForeground(false); await carried.restore(openingComputer: true, preferred: "nope")
        XCTAssertEqual(carried.direct.activeID, directID)
        XCTAssertNil(carried.session)
        try await carried.signOut(accountID: directID)
    }

    /// The Direct connection experiment off: paired computers stay stored
    /// but aren't listed, opened at launch or switched to; hiding the one
    /// open opens the Happy account; showing them again brings them back.
    func testHiddenComputersStayPairedButNeverOpen() async throws {
        let backend = AccountsKeychain(); let directStore = KeychainDirectCredentialStore(backend: backend)
        let directory = try directory()
        func controller(shows: Bool) -> AccountController {
            let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
                accountCredentialStore: KeychainAccountCredentialStore(backend: backend), directCredentialStore: directStore,
                directTransport: { _ in IdentityTransport() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
            account.fallsBackToComputer = true
            account.showsComputers = shows
            return account
        }
        let account = controller(shows: true)
        await account.direct.setForeground(false)
        try await account.signIn(Credentials(token: "token", secret: Data(repeating: 4, count: 32)))
        let legacyID = try XCTUnwrap(account.session?.keys.anonID)
        try await account.addDirect(value(), name: "Mac")
        let directID = try XCTUnwrap(account.direct.activeID)

        // Hidden while open: the Happy account opens, the computer stays paired.
        await account.setShowsComputers(false)
        XCTAssertEqual(account.session?.keys.anonID, legacyID)
        XCTAssertEqual(account.accounts.map(\.id), [legacyID])
        XCTAssertEqual(account.direct.accounts.map(\.id), [directID])
        do {
            try await account.switchAccount(to: directID)
            XCTFail("switched to a hidden computer")
        } catch {}

        // At launch, hidden, the computer neither opens nor stands in.
        try await account.signOut(accountID: legacyID)
        if case .signedOut = account.state {} else { XCTFail("a hidden computer stood in for Welcome: \(account.state)") }
        let launched = controller(shows: false); await launched.direct.setForeground(false); await launched.restore()
        if case .signedOut = launched.state {} else { XCTFail("a hidden computer opened at launch") }
        XCTAssertTrue(launched.accounts.isEmpty)

        // Shown again with nothing open: listed, and it opens, as at launch.
        await launched.setShowsComputers(true)
        XCTAssertEqual(launched.accounts.map(\.id), [directID])
        XCTAssertEqual(launched.direct.activeID, directID)
        if case .direct = launched.state {} else { XCTFail("a shown computer didn't open over Welcome: \(launched.state)") }
        try await launched.signOut(accountID: directID)
    }

    func testRemovalAwaitsCancellationAndDiscardsLateIdentity() async throws {
        let store = InMemoryDirectCredentialStore()
        try store.save(value(), id: "direct-cancel")
        let transport = CancelledIdentityTransport()
        let manager = DirectAccounts(credentials: store, directory: nil, makeTransport: { _ in transport })
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
        let manager = DirectAccounts(credentials: InMemoryDirectCredentialStore(), directory: nil, makeTransport: { $0.deviceID == "failing" ? failing : healthy })
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
}