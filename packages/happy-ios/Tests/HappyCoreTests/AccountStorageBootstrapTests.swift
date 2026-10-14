import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private enum StorageSetupError: Error { case failed }

private final class StoragePreparationProbe: @unchecked Sendable {
    private let condition = NSCondition()
    private let held: Bool
    private let fails: Bool
    private var released = false
    private var count = 0
    private var timedOutValue = false
    var calls: Int { condition.withLock { count } }
    var timedOut: Bool { condition.withLock { timedOutValue } }

    init(held: Bool = false, fails: Bool = false) {
        self.held = held
        self.fails = fails
    }

    func prepare(_ directory: URL?) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        condition.lock()
        count += 1
        let deadline = Date().addingTimeInterval(10)
        while held && !released {
            if !condition.wait(until: deadline) {
                timedOutValue = true
                break
            }
        }
        condition.unlock()
        if fails { throw StorageSetupError.failed }
        try AccountStorageDirectory.prepare(directory)
    }

    func release() {
        condition.withLock {
            released = true
            condition.broadcast()
        }
    }
}

@MainActor
final class AccountStorageBootstrapTests: XCTestCase {
    private let credentials = TokenStorageFixtures.typical

    private func root() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(root: URL, keychain: AccountsKeychain) -> AccountController {
        AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: root,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FakeHTTP(), connector: FakeConnector()
        )
    }

    func testFailedSetupRestoresInMemoryWithoutChangingRegistryOrCredentials() async throws {
        let root = root(), keychain = AccountsKeychain()
        let sharedItem = SecureStoreCredentialStore.item.writeTarget
        let credentialBytes = Data(TokenStorageFixtures.typicalJSON.utf8)
        keychain.items.seed(sharedItem, credentialBytes)
        let id = try accountID(credentials)
        var saved = AccountRegistry()
        saved.entries = [AccountRegistryEntry(id: id, serverURL: ServerConfig.defaultServerURL, location: .shared, addedOrder: 0)]
        saved.activeID = id
        let snapshot = saved
        try await Task.detached { try snapshot.save(directory: root) }.value
        let registryURL = root.appendingPathComponent("accounts.json")
        let registryBytes = try Data(contentsOf: registryURL)
        let account = controller(root: root, keychain: keychain)
        let probe = StoragePreparationProbe(fails: true)
        account.prepareAccountStorage = probe.prepare
        await account.restore()
        let session = try XCTUnwrap(account.session)
        XCTAssertEqual(session.credentials, credentials)
        XCTAssertEqual(account.accounts.map(\.id), [id])
        let effective = await account.prepareStorageDirectory()
        XCTAssertNil(effective)
        XCTAssertEqual(probe.calls, 1)
        // A subsequent save and session creation must keep the frozen fallback.
        account.prepareAccountStorage = { _ in XCTFail("failed setup must not retry against the disk root") }
        try await account.signIn(credentials)
        let memorySession = try XCTUnwrap(account.session)
        try await Task.detached {
            _ = try memorySession.store.applyProfile(AccountProfile(id: "profile", timestamp: 1, firstName: "Memory"))
        }.value
        await eventually { await MainActor.run { account.accounts.first?.name == "Memory" } }
        await account.flushProfilePersistence()
        XCTAssertFalse(FileManager.default.fileExists(atPath: AccountSession.accountDirectory(directory: root, id: id).path))
        XCTAssertEqual(try Data(contentsOf: registryURL), registryBytes)
        XCTAssertEqual(keychain.items.stored(sharedItem)?.data, credentialBytes)
        XCTAssertNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: id)))
        await memorySession.stop()
    }

    func testFileAtRootUsesRealPreparationFailureAndStillRestores() async throws {
        let root = root(), keychain = AccountsKeychain()
        let bytes = Data("existing file".utf8)
        try bytes.write(to: root)
        keychain.items.seed(SecureStoreCredentialStore.item.writeTarget, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = controller(root: root, keychain: keychain)
        await account.restore()
        let session = try XCTUnwrap(account.session)
        XCTAssertEqual(session.credentials, credentials)
        let effective = await account.prepareStorageDirectory()
        XCTAssertNil(effective)
        XCTAssertEqual(try Data(contentsOf: root), bytes)
        await session.stop()
    }

    func testConcurrentBootstrapWaitersShareOneBackgroundDecision() async throws {
        let root = root(), account = controller(root: root, keychain: AccountsKeychain())
        let probe = StoragePreparationProbe(held: true)
        defer { probe.release() }
        account.prepareAccountStorage = probe.prepare
        let first = Task { await account.prepareStorageDirectory() }
        let second = Task { await account.prepareStorageDirectory() }
        let third = Task { await account.restore() }
        await eventually { probe.calls == 1 }
        XCTAssertNil(account.pictures(for: "not-yet-loaded"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        probe.release()
        let firstResult = await first.value
        let secondResult = await second.value
        await third.value
        XCTAssertEqual(firstResult, root)
        XCTAssertEqual(secondResult, root)
        XCTAssertEqual(probe.calls, 1)
        XCTAssertFalse(probe.timedOut)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
    }
}