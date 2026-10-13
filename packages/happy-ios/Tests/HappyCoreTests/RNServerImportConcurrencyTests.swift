import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private final class RNImportGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var enteredValue = false
    private var released = false
    private var timedOutValue = false
    var entered: Bool { condition.withLock { enteredValue } }
    var timedOut: Bool { condition.withLock { timedOutValue } }

    func block() {
        dispatchPrecondition(condition: .notOnQueue(.main))
        condition.lock()
        enteredValue = true
        let deadline = Date().addingTimeInterval(10)
        while !released {
            if !condition.wait(until: deadline) {
                timedOutValue = true
                break
            }
        }
        condition.unlock()
    }

    func release() {
        condition.withLock { released = true; condition.broadcast() }
    }
}

@MainActor
final class RNServerImportConcurrencyTests: XCTestCase {
    private let first = TokenStorageFixtures.typical
    private let second = Credentials(token: "secondary", secret: Data(repeating: 7, count: 32))
    private let replacement = Credentials(token: "RN replacement", secret: Data(repeating: 9, count: 32))
    private let item = SecureStoreCredentialStore.item.writeTarget

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(_ keychain: AccountsKeychain, directory: URL, rn: URL, gate: RNImportGate,
                            config: ServerConfig, http: FakeHTTP) -> AccountController {
        AccountController(
            serverConfig: config, clientID: "ios/test", credentialStore: SecureStoreCredentialStore(backend: keychain),
            storeDirectory: directory, accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: {
                gate.block()
                return RNServerConfigImporter.read(directory: rn)
            }, transport: http, connector: FakeConnector()
        )
    }

    func testImportKeepsAccountOperationsSerializedAndUsesTheVerifiedRNHost() async throws {
        let directory = try directory(), rn = directory.appendingPathComponent("mmkv")
        let fixture = MMKVFixtures.file(MMKVFixtures.region([("custom-server-url", "https://imported.test/")]))
        try MMKVFixtures.write(fixture, directory: rn)
        let keychain = AccountsKeychain(), http = FakeHTTP(), gate = RNImportGate()
        defer { gate.release(); XCTAssertFalse(gate.timedOut, "RN import gate timed out") }
        keychain.items.seed(item, Data(TokenStorageFixtures.typicalJSON.utf8))
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        let account = controller(keychain, directory: directory, rn: rn, gate: gate, config: config, http: http)
        let restoring = Task { await account.restore() }
        await eventually { gate.entered }
        XCTAssertTrue(http.requests.isEmpty, "no bearer request may precede verified server import")
        try config.setCustomServerURL("https://changed-candidate.test")
        do {
            try await account.signIn(second)
            XCTFail("the import holds the account transition guard")
        } catch { XCTAssertEqual(error as? AccountSwitchError, .operationInProgress) }
        gate.release()
        await restoring.value
        XCTAssertEqual(account.session?.api.serverURL.absoluteString, "https://imported.test")
        await eventually { !http.requests.isEmpty }
        XCTAssertTrue(http.requests.allSatisfy { $0.url.host == "imported.test" })
        XCTAssertEqual(keychain.items.stored(item)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        XCTAssertEqual(try Data(contentsOf: rn.appendingPathComponent("server-config")), fixture.0)
        XCTAssertEqual(try Data(contentsOf: rn.appendingPathComponent("server-config.crc")), fixture.1)
        await account.session?.stop()
    }

    func testProfileDeliveredWhileImportingAnUnknownSharedAccountSurvivesReconcile() async throws {
        let directory = try directory(), rn = directory.appendingPathComponent("mmkv")
        try MMKVFixtures.write(MMKVFixtures.file(MMKVFixtures.region([("custom-server-url", "https://replacement.test")])), directory: rn)
        let keychain = AccountsKeychain(), http = FakeHTTP(), gate = RNImportGate()
        defer { gate.release(); XCTAssertFalse(gate.timedOut, "RN import gate timed out") }
        let account = controller(keychain, directory: directory, rn: rn, gate: gate,
                                 config: ServerConfig(storage: InMemoryKeyValueStore()), http: http)
        try await account.signIn(first)
        try await account.signIn(second)
        let store = try XCTUnwrap(account.session?.store)
        try await Task.detached { _ = try store.applyProfile(AccountProfile(id: "profile", timestamp: 1, firstName: "Before")) }.value
        await eventually { await MainActor.run { account.accounts.first(where: \.isActive)?.name == "Before" } }
        await account.flushProfilePersistence()
        keychain.items.seed(item, Data(CredentialsJSON.encode(replacement).utf8))
        let activeID = try accountID(second), replacementID = try accountID(replacement)
        let reconciling = Task { try await account.switchAccount(to: activeID) }
        await eventually { gate.entered }
        try await Task.detached { _ = try store.applyProfile(AccountProfile(id: "profile", timestamp: 2, firstName: "Newest")) }.value
        await eventually { await MainActor.run { account.accounts.first(where: \.isActive)?.name == "Newest" } }
        gate.release()
        try await reconciling.value
        await account.flushProfilePersistence()
        XCTAssertEqual(account.session?.keys.anonID, activeID)
        XCTAssertEqual(Set(account.accounts.map(\.id)), Set([activeID, replacementID]))
        XCTAssertEqual(account.accounts.first(where: \.isActive)?.name, "Newest")
        let registry = try await Task.detached { try AccountRegistry.load(directory: directory) }.value
        XCTAssertEqual(registry.activeID, activeID)
        XCTAssertEqual(registry.entries.first { $0.id == activeID }?.display?.name, "Newest")
        XCTAssertEqual(registry.entries.first { $0.id == replacementID }?.serverURL.absoluteString, "https://replacement.test")
        XCTAssertTrue(registry.entries.first { $0.id == replacementID }?.serverConfirmed == true)
        XCTAssertEqual(keychain.items.stored(item)?.data, Data(CredentialsJSON.encode(replacement).utf8))
        await account.session?.stop()
    }
}