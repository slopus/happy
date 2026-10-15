import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

@MainActor
private final class AccountSnapshots {
    var values: [[AccountSummary]] = []
}

@MainActor
final class AccountsReviewTests: XCTestCase {
    private let shared = TokenStorageFixtures.typical
    private let second = Credentials(token: "secondary", secret: Data(repeating: 7, count: 32))
    private let rn = SecureStoreCredentialStore.item.writeTarget

    private func controller(_ keychain: AccountsKeychain, directory: URL? = nil) -> AccountController {
        AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
    }

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testMultipleObserversSeeInventorySwitchAndProfilesWithoutReplacingRootCallback() async throws {
        let keychain = AccountsKeychain()
        let account = controller(keychain)
        let first = AccountSnapshots(), secondLog = AccountSnapshots()
        let observer = account.observeAccounts { first.values.append($0) }
        var releasedObserver: AccountsObservation? = account.observeAccounts { secondLog.values.append($0) }
        XCTAssertEqual(first.values, [[]])
        XCTAssertEqual(secondLog.values, [[]])
        var rootCallbacks = 0
        account.onChange = { _ in rootCallbacks += 1 }
        try await account.signIn(shared)
        let profile = AccountProfile(id: "profile", timestamp: 10, firstName: "Ada", lastName: "Lovelace",
            avatar: ImageRef(width: 10, height: 10, thumbhash: "thumb", path: "image", url: "https://image.test/ada"),
            github: GitHubProfile(id: 1, login: "ada"))
        try account.session?.store.applyProfile(profile)
        await eventually { await MainActor.run { first.values.last?.first?.name == "Ada Lovelace" } }
        XCTAssertEqual(first.values.last?.first?.username, "ada")
        XCTAssertEqual(first.values.last?.first?.avatarURL?.absoluteString, "https://image.test/ada")
        XCTAssertEqual(first.values.last?.first?.avatarThumbhash, "thumb")
        XCTAssertEqual(first.values.last, secondLog.values.last)
        try await account.signIn(second)
        try await account.switchAccount(to: accountID(shared))
        XCTAssertTrue(first.values.last?.first { $0.id == (try? accountID(shared)) }?.isActive == true)
        let rootsBeforeRemoval = rootCallbacks
        try await account.signOut(accountID: accountID(second))
        XCTAssertEqual(first.values.last?.count, 1)
        XCTAssertEqual(rootCallbacks, rootsBeforeRemoval, "inactive removal must only update list observers")
        observer.cancel()
        let firstCount = first.values.count, secondCount = secondLog.values.count
        releasedObserver = nil
        XCTAssertNil(releasedObserver)
        await account.signOut()
        XCTAssertEqual(first.values.count, firstCount)
        XCTAssertEqual(secondLog.values.count, secondCount)
    }

    func testInactiveProfileFieldsRecoverReadOnlyWhenRegistryIsCorrupt() async throws {
        let directory = try directory()
        let keychain = AccountsKeychain()
        let account = controller(keychain, directory: directory)
        try await account.signIn(shared)
        try account.session?.store.applyProfile(AccountProfile(id: "A", timestamp: 1, firstName: "Alice",
            github: GitHubProfile(id: 1, login: "alice", avatarURL: "https://image.test/alice")))
        let oldStore = try XCTUnwrap(account.session?.store)
        try await account.signIn(second)
        try account.session?.store.applyProfile(AccountProfile(id: "B", timestamp: 1, firstName: "Bob",
            avatar: ImageRef(width: 1, height: 1, thumbhash: "bobThumb", path: "bob", url: "https://image.test/bob")))
        await account.session?.stop()
        try Data("corrupt".utf8).write(to: directory.appendingPathComponent("accounts.json"))
        // This read must not call LocalStore.init's stale-live-state reset.
        try oldStore.setCursor(.sessionsChangedSince, 55)
        let restored = controller(keychain, directory: directory)
        await restored.restore()
        let alice = try XCTUnwrap(restored.accounts.first { $0.id == (try? accountID(shared)) })
        let bob = try XCTUnwrap(restored.accounts.first { $0.id == (try? accountID(second)) })
        XCTAssertEqual(alice.name, "Alice")
        XCTAssertEqual(alice.username, "alice")
        XCTAssertEqual(alice.avatarURL?.absoluteString, "https://image.test/alice")
        XCTAssertEqual(bob.name, "Bob")
        XCTAssertEqual(bob.avatarThumbhash, "bobThumb")
        XCTAssertEqual(try oldStore.cursor(.sessionsChangedSince), 55)
        await restored.session?.stop()
    }

    func testLogoutPublishesNewRootBeforeEraseThenRetainedStoreIsEmptyAndFilesAreGone() async throws {
        let directory = try directory(), keychain = AccountsKeychain()
        let account = controller(keychain, directory: directory)
        try await account.signIn(shared)
        let oldSession = try XCTUnwrap(account.session)
        try oldSession.store.applyProfile(AccountProfile(id: "A", timestamp: 1, firstName: "Private Name"))
        try oldSession.store.setCursor(.sessionsChangedSince, 9)
        let files = oldSession.filesDirectory
        try Data("attachment".utf8).write(to: files.appendingPathComponent("cached.txt"))
        var rootChanged = false
        account.onChange = { state in
            if case .signedOut = state {
                rootChanged = true
                XCTAssertTrue(FileManager.default.fileExists(atPath: files.path), "root changes before files are deleted")
                XCTAssertFalse(oldSession.store.isClosed, "root changes before the store closes")
            }
        }
        try await account.signOut(accountID: accountID(shared))
        XCTAssertTrue(rootChanged)
        // Erased, closed, then removed: a UI retaining the old store reads
        // a closed store, not the account's data and not an unlinked file
        // (Darwin's SQLITE_IOERR_VNODE).
        XCTAssertTrue(oldSession.store.isClosed)
        XCTAssertThrowsError(try oldSession.store.profile(), "a UI retaining the old store") {
            XCTAssertEqual($0 as? LocalStoreError, .closed)
        }
        XCTAssertThrowsError(try oldSession.store.cursor(.sessionsChangedSince)) {
            XCTAssertEqual($0 as? LocalStoreError, .closed)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.path))
    }

    func testDuplicateOwnItemIsRemovedOnlyAfterSuccessfulSharedRead() async throws {
        let keychain = AccountsKeychain()
        let id = try accountID(shared)
        let ownStore = KeychainAccountCredentialStore(backend: keychain)
        try ownStore.save(StoredAccountCredentials(credentials: shared, serverURL: ServerConfig.defaultServerURL), id: id, location: .own)
        let bytes = Data(TokenStorageFixtures.typicalJSON.utf8)
        keychain.items.seed(rn, bytes)
        keychain.items.copyFailures["app:no-auth"] = -25308
        let account = controller(keychain)
        await account.restore()
        XCTAssertNotNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: id)))
        keychain.items.copyFailures = [:]
        await account.restore()
        XCTAssertNil(keychain.items.stored(KeychainAccountCredentialStore.query(id: id)))
        XCTAssertEqual(keychain.items.stored(rn)?.data, bytes)
        XCTAssertEqual(account.accounts.count, 1)
        await account.session?.stop()
    }

    func testSignedOutLogoutPreservesUnknownRNLayoutExactBytes() async {
        let keychain = AccountsKeychain()
        let bytes = Data(#"{"future_credentials":{"opaque":"value"}}"#.utf8)
        keychain.items.seed(rn, bytes)
        let account = controller(keychain)
        await account.restore()
        await account.signOut()
        XCTAssertEqual(keychain.items.stored(rn)?.data, bytes)
        XCTAssertFalse(keychain.items.calls.contains(.delete("app:no-auth")))
    }

    func testSingleItemCompatibilityInjectionDoesNotOverwriteUnknownSharedBytes() async throws {
        let keychain = AccountsKeychain()
        let bytes = Data("unrecognized RN credentials".utf8)
        keychain.items.seed(rn, bytes)
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: nil,
            transport: FakeHTTP(), connector: FakeConnector()
        )
        try await account.signIn(second)
        XCTAssertEqual(keychain.items.stored(rn)?.data, bytes)
        XCTAssertFalse(try XCTUnwrap(account.accounts.first).usesSharedItem)
        await account.session?.stop()
    }
}
