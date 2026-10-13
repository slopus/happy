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

    private func unregisters(_ http: FakeHTTP) -> [HTTPRequest] {
        http.requests.filter { $0.method == "DELETE" && $0.url.path.hasPrefix("/v1/push-tokens/") }
    }

    func testSigningOutTheActiveAccountUnregistersItsTokenOnItsServer() async throws {
        let http = FakeHTTP()
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[second]", #"{"success":true}"#)
        let secondSettings = InMemoryKeyValueStore()
        let account = try await twoAccounts(AccountsKeychain(), http: http, settings: [try accountID(second): secondSettings])
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        await account.signOut()
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

    /// happy-app logs and carries on; the account still signs out.
    func testAFailedUnregisterStillSignsOut() async throws {
        let http = FakeHTTP()
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[second]", "down", status: 503)
        let account = try await twoAccounts(AccountsKeychain(), http: http)
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        await account.signOut()
        XCTAssertEqual(unregisters(http).count, 1)
        XCTAssertEqual(account.accounts.map(\.id), [try accountID(shared)])
        XCTAssertNil(account.localSettings.registeredPushToken)
        await account.session?.stop()
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
