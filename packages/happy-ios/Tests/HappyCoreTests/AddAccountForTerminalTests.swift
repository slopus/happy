import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore

/// A computer's code with no account to give it makes one, and keeps it
/// only once the computer has it.
@MainActor
final class AddAccountForTerminalTests: XCTestCase {
    private let existing = Credentials(token: "existing", secret: Data(repeating: 7, count: 32))

    private func controller(_ http: FakeHTTP, keychain: AccountsKeychain = AccountsKeychain()) -> AccountController {
        AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: nil,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: http, connector: FakeConnector())
    }

    private func terminal() throws -> Data { try BoxKeyPair.generate().publicKey }

    func testApprovedTheNewAccountIsKeptAndActive() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/auth", #"{"success":true,"token":"new"}"#)
        http.onRaw("GET /v1/auth/request/status", #"{"status":"pending","supportsV2":true}"#)
        http.onRaw("POST /v1/auth/response", #"{"success":true}"#)
        let account = controller(http)
        await account.restore()
        let outcome = try await account.addAccount(approvingTerminal: try terminal())
        XCTAssertEqual(outcome, .terminalConnected)
        XCTAssertEqual(account.session?.credentials.token, "new")
        XCTAssertEqual(account.accounts.count, 1)
        XCTAssertFalse(account.isAddingAccount)
        // The computer was answered before the account was kept.
        let routes = http.requests.map { "\($0.method) \($0.url.path)" }
        XCTAssertEqual(Array(routes.prefix(3)), ["POST /v1/auth", "GET /v1/auth/request/status", "POST /v1/auth/response"])
    }

    func testAUsedCodeKeepsNothingAndTheActiveAccountStays() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/auth", #"{"success":true,"token":"new"}"#)
        http.onRaw("GET /v1/auth/request/status", #"{"status":"authorized","supportsV2":true}"#)
        let account = controller(http)
        await account.restore()
        account.beginAddingAccount()
        try await account.signIn(existing)
        let outcome = try await account.addAccount(approvingTerminal: try terminal())
        XCTAssertEqual(outcome, .alreadyHandled)
        XCTAssertEqual(account.session?.credentials, existing)
        XCTAssertEqual(account.accounts.count, 1)
        XCTAssertFalse(account.isAddingAccount)
    }

    func testAFailedApprovalKeepsNothing() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/auth", #"{"success":true,"token":"new"}"#)
        http.onRaw("GET /v1/auth/request/status", #"{"status":"pending","supportsV2":true}"#)
        http.onRaw("POST /v1/auth/response", #"{"error":"nope"}"#, status: 500)
        let account = controller(http)
        await account.restore()
        do {
            _ = try await account.addAccount(approvingTerminal: try terminal())
            XCTFail("a failed approval went through")
        } catch {}
        XCTAssertNil(account.session)
        XCTAssertTrue(account.accounts.isEmpty)
        XCTAssertFalse(account.isAddingAccount)
    }
}
