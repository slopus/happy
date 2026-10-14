import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore

/// Uses the existing byte-accurate SecItem fake, with enumeration scoped to
/// secondary items. All shared-item assertions model exactly what RN reads.
final class AccountsKeychain: AccountKeychainBackend, @unchecked Sendable {
    let items = FakeKeychain()
    private let lock = NSLock()
    private var queries: Set<KeychainItemQuery> = []
    var enumerationFailure: Int32?
    var removalFailure: Int32?

    func accounts(service: String) throws -> [String] {
        if let enumerationFailure { throw KeychainStatusError(enumerationFailure) }
        return lock.withLock { queries.filter { $0.service == service }.map { String(decoding: $0.account, as: UTF8.self) } }
    }
    func copyData(_ query: KeychainItemQuery) throws -> Data? { try items.copyData(query) }
    func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult {
        _ = lock.withLock { queries.insert(query) }
        return try items.add(query, data: data, accessibility: accessibility)
    }
    func update(_ query: KeychainItemQuery, data: Data) throws { try items.update(query, data: data) }
    func delete(_ query: KeychainItemQuery) {
        _ = lock.withLock { queries.remove(query) }
        items.delete(query)
    }
    func removeAccount(_ query: KeychainItemQuery) throws {
        if let removalFailure { throw KeychainStatusError(removalFailure) }
        delete(query)
    }
}

/// A decoded picture, for `AttachmentPictures`.
private final class AccountPicture: Sendable {}

@MainActor
final class AccountsTests: XCTestCase {
    private let shared = TokenStorageFixtures.typical
    private let second = Credentials(token: "second", secret: Data(repeating: 7, count: 32))
    private let rn = SecureStoreCredentialStore.item.writeTarget

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(_ keychain: AccountsKeychain, directory: URL? = nil,
                            config: ServerConfig? = nil, connector: FakeConnector = FakeConnector(),
                            settings: ((String) -> KeyValueStore)? = nil) -> AccountController {
        AccountController(serverConfig: config ?? ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: settings,
            transport: FakeHTTP(), connector: connector)
    }

    private func twoAccounts(_ keychain: AccountsKeychain, directory: URL? = nil) async throws -> AccountController {
        keychain.items.seed(rn, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = controller(keychain, directory: directory)
        await account.restore()
        account.beginAddingAccount()
        try await account.signIn(second)
        return account
    }

    // RN rollback matrix: each row pins the shared bytes, not just decoded credentials.
    func testRNAfterAddingSecondAccountStillReadsExactOriginalBytes() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        XCTAssertEqual(account.accounts.count, 2)
        XCTAssertEqual(account.session?.credentials, second)
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        let id = try accountID(second)
        XCTAssertEqual(keychain.items.stored(KeychainAccountCredentialStore.query(id: id))?.accessibility, .whenUnlocked)
        await account.session?.stop()
    }

    func testRNAfterSwitchReadsExactOriginalBytesAndSessionIsRebuilt() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        let previous = try XCTUnwrap(account.session)
        try await account.switchAccount(to: accountID(shared))
        XCTAssertFalse(account.session === previous)
        XCTAssertEqual(account.session?.credentials, shared)
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        await account.session?.stop()
    }

    func testAttachmentPicturesStayWithTheirAccount() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        let key = AttachmentPictures.Key(sessionId: "s1", ref: "same-ref")
        let previous = try XCTUnwrap(account.session)
        _ = await previous.attachmentPictures.picture(key) { (picture: AccountPicture(), cost: 1) }
        try await account.switchAccount(to: accountID(shared))
        let current = try XCTUnwrap(account.session)
        XCTAssertFalse(current.attachmentPictures === previous.attachmentPictures)
        XCTAssertNil(current.attachmentPictures.cached(key), "the same ref in another account is not its picture")
        await account.session?.stop()
    }

    func testRNAfterSigningOutSharedIsSignedOutWhileSecondarySurvives() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        try await account.signOut(accountID: accountID(shared))
        XCTAssertNil(keychain.items.stored(rn)?.data)
        XCTAssertEqual(account.session?.credentials, second)
        XCTAssertEqual(account.accounts.map(\.id), [try accountID(second)])
        XCTAssertNotNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: try accountID(second))))
        await account.session?.stop()
    }

    func testRNAfterSigningOutSecondaryReadsExactOriginalBytesAndSharedActivates() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        await account.signOut()
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        XCTAssertEqual(account.session?.credentials, shared)
        XCTAssertNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: try accountID(second))))
        await account.signOut()
        XCTAssertNil(account.session)
        XCTAssertTrue(account.accounts.isEmpty)
        XCTAssertNil(keychain.items.stored(rn))
    }

    func testReauthenticationUpdatesOnlyExistingItemAndNeverPromotesSecondary() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        var refreshed = second
        refreshed.token = "refreshed"
        try await account.signIn(refreshed)
        XCTAssertEqual(account.accounts.count, 2)
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        try await account.signOut(accountID: accountID(shared))
        refreshed.token = "refreshed-again"
        try await account.signIn(refreshed)
        XCTAssertNil(keychain.items.stored(rn))
        XCTAssertFalse(try XCTUnwrap(account.accounts.first).usesSharedItem)
        await account.session?.stop()
    }

    func testSharedReauthenticationWritesRNLayoutToSharedOnly() async throws {
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain)
        var refreshed = shared
        refreshed.token = "new/token"
        try await account.signIn(refreshed)
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(CredentialsJSON.encode(refreshed).utf8))
        XCTAssertNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: try accountID(shared))))
        await account.session?.stop()
    }

    func testCachesSettingsServersAndActiveAccountSurviveRelaunchSeparately() async throws {
        let directory = try directory()
        let keychain = AccountsKeychain()
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        let firstID = try accountID(shared), secondID = try accountID(second)
        let settings: [String: KeyValueStore] = [firstID: InMemoryKeyValueStore(), secondID: InMemoryKeyValueStore()]
        let sockets = FakeConnector()
        let account = controller(keychain, directory: directory, config: config, connector: sockets, settings: { settings[$0]! })
        try await account.signIn(shared)
        account.localSettings.themePreference = .dark
        try account.session?.store.setCursor(.sessionsChangedSince, 123)
        await eventually { sockets.latest != nil }
        let oldSocket = try XCTUnwrap(sockets.latest)
        try config.setCustomServerURL("http://custom.test:3000")
        account.beginAddingAccount()
        try await account.signIn(second)
        XCTAssertEqual(account.session?.api.serverURL.absoluteString, "http://custom.test:3000")
        XCTAssertEqual(account.localSettings.themePreference, .adaptive)
        XCTAssertNil(try account.session?.store.cursor(.sessionsChangedSince))
        do { try await oldSocket.send("frame"); XCTFail("old socket should be closed") } catch {}
        account.localSettings.themePreference = .light
        try await account.switchAccount(to: firstID)
        XCTAssertEqual(account.session?.api.serverURL, ServerConfig.defaultServerURL)
        XCTAssertEqual(account.localSettings.themePreference, .dark)
        XCTAssertEqual(try account.session?.store.cursor(.sessionsChangedSince), 123)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(account.session).filesDirectory.path))
        await account.session?.stop()
        let restored = controller(keychain, directory: directory, config: config, settings: { settings[$0]! })
        await restored.restore()
        XCTAssertEqual(restored.session?.keys.anonID, firstID)
        try await restored.signOut(accountID: firstID)
        XCTAssertEqual(restored.localSettings.themePreference, .light)
        XCTAssertNil(settings[firstID]?.string(forKey: "themePreference"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: AccountSession.accountDirectory(directory: directory, id: firstID).path))
        await restored.session?.stop()
    }

    func testCorruptRegistryRebuildsBothItemsAndPreservesSecondaryServer() async throws {
        let directory = try directory()
        let keychain = AccountsKeychain()
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        let account = controller(keychain, directory: directory, config: config)
        try await account.signIn(shared)
        try config.setCustomServerURL("http://secondary.test:3000")
        account.beginAddingAccount()
        try await account.signIn(second)
        await account.session?.stop()
        try Data("{broken".utf8).write(to: directory.appendingPathComponent("accounts.json"))
        let restored = controller(keychain, directory: directory)
        await restored.restore()
        XCTAssertEqual(Set(restored.accounts.map(\.id)), Set([try accountID(shared), try accountID(second)]))
        XCTAssertEqual(restored.accounts.first { $0.id == (try? accountID(second)) }?.serverURL.absoluteString, "http://secondary.test:3000")
        try await restored.switchAccount(to: accountID(second))
        XCTAssertEqual(restored.session?.api.serverURL.absoluteString, "http://secondary.test:3000")
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        let persisted = try Data(contentsOf: directory.appendingPathComponent("accounts.json"))
        XCTAssertFalse(String(decoding: persisted, as: UTF8.self).contains(shared.secret))
        XCTAssertFalse(String(decoding: persisted, as: UTF8.self).contains(second.secret))
        await restored.session?.stop()
    }

    func testRegistryDropsGoneCredentialsAndImportsUnknownSharedWithoutCopying() async throws {
        let directory = try directory()
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain, directory: directory)
        await account.session?.stop()
        keychain.delete(KeychainAccountCredentialStore.query(id: try accountID(second)))
        let third = Credentials(token: "RN replacement", secret: Data(repeating: 9, count: 32))
        let bytes = Data(CredentialsJSON.encode(third).utf8)
        keychain.items.seed(rn, bytes)
        let restored = controller(keychain, directory: directory)
        await restored.restore()
        XCTAssertEqual(restored.accounts.map(\.id), [try accountID(third)])
        XCTAssertEqual(keychain.items.stored(rn)?.data, bytes)
        XCTAssertNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: try accountID(third))))
        await restored.session?.stop()
    }

    func testLockedKeychainDoesNotDropRegistryOrOverwriteShared() async throws {
        let directory = try directory()
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain, directory: directory)
        await account.session?.stop()
        let bytes = try Data(contentsOf: directory.appendingPathComponent("accounts.json"))
        keychain.items.copyFailures["app:no-auth"] = -25308
        let restored = controller(keychain, directory: directory)
        await restored.restore()
        XCTAssertNil(restored.session)
        do { try await restored.signIn(second); XCTFail("locked item must throw") } catch {}
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("accounts.json")), bytes)
        XCTAssertEqual(keychain.items.stored(rn)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
    }

    func testMigrationMovesExistingDatabaseAndIsIdempotent() async throws {
        let directory = try directory()
        let id = try accountID(shared)
        let old = directory.appendingPathComponent("happy-\(id).sqlite")
        do {
            let store = try LocalStore.open(at: old)
            try store.setCursor(.sessionsChangedSince, 42)
        }
        let keychain = AccountsKeychain()
        keychain.items.seed(rn, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = controller(keychain, directory: directory)
        await account.restore()
        XCTAssertEqual(try account.session?.store.cursor(.sessionsChangedSince), 42)
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        try await Task.detached { try AccountSession.prepareDirectory(directory: directory, id: id) }.value
        XCTAssertEqual(try account.session?.store.cursor(.sessionsChangedSince), 42)
        await account.session?.stop()
    }

    func testMigrationResumesAfterSidecarMovedBeforeDatabase() async throws {
        let directory = try directory()
        let id = try accountID(shared)
        let old = directory.appendingPathComponent("happy-\(id).sqlite")
        let new = AccountSession.accountDirectory(directory: directory, id: id).appendingPathComponent("store.sqlite")
        try FileManager.default.createDirectory(at: new.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("database".utf8).write(to: old)
        // A previous launch was interrupted after moving WAL but before SHM/database.
        try Data("wal".utf8).write(to: URL(fileURLWithPath: new.path + "-wal"))
        try Data("shm".utf8).write(to: URL(fileURLWithPath: old.path + "-shm"))
        try await Task.detached { try AccountSession.prepareDirectory(directory: directory, id: id) }.value
        XCTAssertEqual(try Data(contentsOf: new), Data("database".utf8))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: new.path + "-wal")), Data("wal".utf8))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: new.path + "-shm")), Data("shm".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
    }

    func testAddCancellationKeepsActiveSessionAndUnknownSwitchThrows() async throws {
        let keychain = AccountsKeychain()
        let account = controller(keychain)
        try await account.signIn(shared)
        let session = account.session
        account.beginAddingAccount()
        XCTAssertTrue(account.isAddingAccount)
        account.cancelAddingAccount()
        XCTAssertTrue(session === account.session)
        do { try await account.switchAccount(to: "missing"); XCTFail("unknown account") }
        catch { XCTAssertEqual(error as? AccountSwitchError, .unknownAccount) }
        await account.session?.stop()
    }

    func testMalformedOccupiedSharedIsNeverOverwrittenByNewAccount() async throws {
        let keychain = AccountsKeychain()
        let bytes = Data("invalid RN json".utf8)
        keychain.items.seed(rn, bytes)
        let account = controller(keychain)
        try await account.signIn(second)
        XCTAssertEqual(keychain.items.stored(rn)?.data, bytes)
        XCTAssertFalse(try XCTUnwrap(account.accounts.first).usesSharedItem)
        await account.session?.stop()
    }

    func testFailedSecondaryRemovalKeepsSessionRegistryAndCredentials() async throws {
        let directory = try directory()
        let keychain = AccountsKeychain()
        let account = try await twoAccounts(keychain, directory: directory)
        keychain.removalFailure = -25308
        let old = account.session
        do { try await account.signOut(accountID: accountID(second)); XCTFail("delete failed") } catch {}
        XCTAssertTrue(old === account.session)
        XCTAssertEqual(account.accounts.count, 2)
        XCTAssertEqual(try AccountRegistry.load(directory: directory).entries.count, 2)
        await account.session?.stop()
    }
}