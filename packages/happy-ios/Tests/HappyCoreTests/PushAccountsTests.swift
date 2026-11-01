import Foundation
import XCTest
import GRDB
@testable import HappyCore
import HappyStore

/// Push across accounts: sign-out removes that account's token from its own
/// server (AuthContext.tsx `logout`), and a tapped notification finds the
/// account whose store holds the session.
@MainActor
final class PushAccountsTests: XCTestCase {
    private let shared = TokenStorageFixtures.typical
    private let second = Credentials(token: "second", secret: Data(repeating: 7, count: 32))
    private let rn = SecureStoreCredentialStore.item.writeTarget

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(_ keychain: AccountsKeychain, directory: URL? = nil, http: FakeHTTP = FakeHTTP(),
                            config: ServerConfig = ServerConfig(storage: InMemoryKeyValueStore()),
                            settings: [String: KeyValueStore] = [:]) -> AccountController {
        AccountController(serverConfig: config, clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: { settings[$0] ?? InMemoryKeyValueStore() },
            transport: http, connector: FakeConnector())
    }

    /// Shared account on the default server, second on a custom one; the
    /// second is active.
    private func twoAccounts(_ keychain: AccountsKeychain, directory: URL? = nil, http: FakeHTTP = FakeHTTP(),
                             settings: [String: KeyValueStore] = [:]) async throws -> AccountController {
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        keychain.items.seed(rn, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = controller(keychain, directory: directory, http: http, config: config, settings: settings)
        await account.restore()
        try config.setCustomServerURL("http://second.test:3000")
        account.beginAddingAccount()
        try await account.signIn(second)
        return account
    }

    private nonisolated static func deletes(_ http: FakeHTTP) -> [HTTPRequest] {
        http.requests.filter { $0.method == "DELETE" && $0.url.path.hasPrefix("/v1/push-tokens/") }
    }

    private func unregisters(_ http: FakeHTTP) -> [HTTPRequest] { Self.deletes(http) }

    func testSigningOutTheActiveAccountUnregistersItsTokenOnItsServer() async throws {
        let http = FakeHTTP()
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[second]", #"{"success":true}"#)
        let secondSettings = InMemoryKeyValueStore()
        let account = try await twoAccounts(AccountsKeychain(), http: http, settings: [try accountID(second): secondSettings])
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        await account.signOut()
        await account.pushUnregisters.waitUntilEmpty()
        let request = try XCTUnwrap(unregisters(http).first)
        XCTAssertEqual(unregisters(http).count, 1)
        XCTAssertEqual(request.url.host, "second.test")
        XCTAssertEqual(request.headers["Authorization"], "Bearer second")
        XCTAssertNil(secondSettings.string(forKey: "registered-push-token-v1"))
        XCTAssertEqual(account.session?.credentials, shared)
        await account.session?.stop()
    }

    /// An inactive account's token goes with that account's credentials,
    /// never the active one's.
    func testSigningOutAnInactiveAccountUsesItsOwnCredentials() async throws {
        let http = FakeHTTP()
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[shared]", #"{"success":true}"#)
        let sharedSettings = InMemoryKeyValueStore()
        sharedSettings.set("ExponentPushToken[shared]", forKey: "registered-push-token-v1")
        let account = try await twoAccounts(AccountsKeychain(), http: http, settings: [try accountID(shared): sharedSettings])
        try await account.signOut(accountID: accountID(shared))
        await account.pushUnregisters.waitUntilEmpty()
        let request = try XCTUnwrap(unregisters(http).first)
        XCTAssertEqual(request.url.host, ServerConfig.defaultServerURL.host)
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(shared.token)")
        XCTAssertEqual(request.url.path, "/v1/push-tokens/ExponentPushToken[shared]")
        XCTAssertEqual(account.session?.credentials, second)
        await account.session?.stop()
    }

    func testNoRegisteredTokenSendsNothing() async throws {
        let http = FakeHTTP()
        let account = try await twoAccounts(AccountsKeychain(), http: http)
        await account.signOut()
        XCTAssertTrue(unregisters(http).isEmpty)
        await account.session?.stop()
    }

    /// happy-app logs and carries on; the account still signs out, at
    /// once, and the token's removal waits and is tried again until the
    /// server answers.
    func testAFailedUnregisterStillSignsOutAndIsTriedAgain() async throws {
        let http = FakeHTTP()
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[second]", "down", status: 503)
        let account = try await twoAccounts(AccountsKeychain(), http: http)
        await account.pushUnregisters.setBackoff(Backoff(initial: .milliseconds(20), maximum: .milliseconds(20)))
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        await account.signOut()
        XCTAssertEqual(account.accounts.map(\.id), [try accountID(shared)])
        XCTAssertNil(account.localSettings.registeredPushToken)
        await eventually { Self.deletes(http).count >= 2 }
        let waiting = await account.pushUnregisters.waiting
        XCTAssertEqual(waiting[try accountID(second)]?.pushToken, "ExponentPushToken[second]")
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[second]", #"{"success":true}"#)
        await account.pushUnregisters.waitUntilEmpty()
        let left = await account.pushUnregisters.waiting
        XCTAssertTrue(left.isEmpty)
        await account.session?.stop()
    }

    /// Signed out offline: the removal is kept (its own Keychain item in the
    /// app) and sent by the next launch once the server answers.
    func testAnUnregisterLeftOfflineIsSentByTheNextLaunch() async throws {
        let offline = FakeHTTP()
        offline.on("DELETE /v1/push-tokens/ExponentPushToken[second]") { _ in throw URLError(.notConnectedToInternet) }
        let keychain = AccountsKeychain()
        let store = KeychainPushUnregisterStore(backend: keychain)
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        keychain.items.seed(rn, Data(TokenStorageFixtures.typicalJSON.utf8))
        func launch(_ http: FakeHTTP) -> AccountController {
            AccountController(serverConfig: config, clientID: "ios/test",
                credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: nil,
                accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
                rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
                transport: http, connector: FakeConnector(), pushUnregisterStore: store)
        }
        let account = launch(offline)
        await account.restore()
        try config.setCustomServerURL("http://second.test:3000")
        account.beginAddingAccount()
        try await account.signIn(second)
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        await account.signOut()
        await eventually { Self.deletes(offline).count >= 1 }
        let kept = try XCTUnwrap(try store.all()[try accountID(second)])
        XCTAssertEqual(kept.serverURL.host, "second.test")
        XCTAssertEqual(kept.token, "second")
        XCTAssertNil(try KeychainAccountCredentialStore(backend: keychain).ownAccounts()[try accountID(second)], "the account's own item is gone")
        await account.session?.stop()

        let online = FakeHTTP()
        online.onRaw("DELETE /v1/push-tokens/ExponentPushToken[second]", #"{"success":true}"#)
        let relaunched = launch(online)
        await relaunched.restore()
        await eventually { Self.deletes(online).count == 1 }
        await relaunched.pushUnregisters.waitUntilEmpty()
        XCTAssertEqual(unregisters(online).first?.headers["Authorization"], "Bearer second")
        XCTAssertTrue(try store.all().isEmpty)
        await relaunched.session?.stop()
    }

    /// No token reaches a server the user hasn't confirmed.
    func testUnconfirmedServerIsNeverContacted() async throws {
        let http = FakeHTTP()
        let keychain = AccountsKeychain()
        keychain.items.seed(rn, Data(TokenStorageFixtures.typicalJSON.utf8))
        let sharedSettings = InMemoryKeyValueStore()
        sharedSettings.set("ExponentPushToken[shared]", forKey: "registered-push-token-v1")
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: nil,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .needsConfirmation },
            localSettingsFactory: { _ in sharedSettings }, transport: http, connector: FakeConnector())
        await account.restore()
        XCTAssertNotNil(account.pendingServerConfirmation)
        try await account.signOut(accountID: accountID(shared))
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testSessionLookupPrefersTheActiveStoreThenOthersOnDisk() async throws {
        let directory = try directory()
        let account = try await twoAccounts(AccountsKeychain(), directory: directory)
        let sharedID = try accountID(shared), secondID = try accountID(second)
        try account.session?.store.upsertSessions([ChatRecords.storeSession("in-second"), ChatRecords.storeSession("in-both")])
        try await account.switchAccount(to: sharedID)
        try account.session?.store.upsertSessions([ChatRecords.storeSession("in-shared"), ChatRecords.storeSession("in-both")])
        let inShared = try await account.accountHoldingSession("in-shared")
        let inBoth = try await account.accountHoldingSession("in-both")
        let inSecond = try await account.accountHoldingSession("in-second")
        let nowhere = try await account.accountHoldingSession("nowhere")
        XCTAssertEqual(inShared, sharedID)
        XCTAssertEqual(inBoth, sharedID)
        XCTAssertEqual(inSecond, secondID)
        XCTAssertNil(nowhere)
        await account.session?.stop()
    }

    func testSessionLookupInMemoryStores() async throws {
        let account = try await twoAccounts(AccountsKeychain())
        try account.session?.store.upsertSessions([ChatRecords.storeSession("in-second")])
        try await account.switchAccount(to: accountID(shared))
        let owner = try await account.accountHoldingSession("in-second")
        XCTAssertEqual(owner, try accountID(second))
        await account.session?.stop()
    }

    func testSessionLookupWhileSignedOutFindsNothing() async throws {
        let account = controller(AccountsKeychain())
        await account.restore()
        let owner = try await account.accountHoldingSession("any")
        XCTAssertNil(owner)
    }

    func testLookupReadFailureIsReportedInsteadOfMissingSession() async throws {
        let directory = try directory()
        let account = try await twoAccounts(AccountsKeychain(), directory: directory)
        let broken = try XCTUnwrap(account.session?.store)
        try await broken.writer.write { db in try db.execute(sql: "DROP TABLE session") }
        try await account.switchAccount(to: accountID(shared))
        do {
            _ = try await account.accountHoldingSession("absent")
            XCTFail("a failed inactive-store read must remain observable")
        } catch let error as DatabaseError {
            XCTAssertEqual(error.resultCode, .SQLITE_ERROR)
        }
        await account.session?.stop()
    }
}
