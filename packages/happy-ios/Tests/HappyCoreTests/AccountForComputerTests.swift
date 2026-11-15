import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

/// Which Happy account a computer's code goes to when it doesn't ask for a
/// new one (`AccountController.accountForComputer`): the one in use, else,
/// with an agent connection shown, the one used last; none, and a new one
/// is made.
@MainActor
final class AccountForComputerTests: XCTestCase {
    func testTheAccountInUseOrTheOneUsedLastTakesAComputer() async throws {
        let backend = AccountsKeychain()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "test", credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: backend), agentConnectionCredentialStore: KeychainAgentConnectionCredentialStore(backend: backend),
            agentTransport: { _ in NamedComputer() }, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector())
        await account.agentConnections.setForeground(false)
        XCTAssertNil(account.accountForComputer, "none here: a computer's code makes one")

        try await account.signIn(Credentials(token: "first", secret: Data(repeating: 4, count: 32)))
        let first = try XCTUnwrap(account.session?.keys.anonID)
        try await account.signIn(Credentials(token: "second", secret: Data(repeating: 5, count: 32)))
        let second = try XCTUnwrap(account.session?.keys.anonID)
        XCTAssertEqual(account.accountForComputer?.id, second, "the one in use")
        try await account.switchAccount(to: first)
        XCTAssertEqual(account.accountForComputer?.id, first, "the one in use")

        // An agent connection shown: the Happy account used last, not the
        // one added last, and it is shown when it takes the computer.
        try await account.addAgentConnection(AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: "device",
            deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32))), name: "Mac")
        XCTAssertNil(account.session)
        XCTAssertNotNil(account.agentConnections.activeID)
        XCTAssertEqual(account.accountForComputer?.id, first)
        XCTAssertFalse(account.accountForComputer?.isAgentConnection ?? true)
        try await account.switchAccount(to: first)
        XCTAssertEqual(account.session?.keys.anonID, first)
        XCTAssertNil(account.agentConnections.activeID)
    }
}

/// A paired computer that answers who it is.
private actor NamedComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        switch path {
        case "/v0/health":
            return HTTP1Response(status: 200, body: Data(#"{"ready":true,"version":{"protocol":27}}"#.utf8))
        case "/v0/config":
            return HTTP1Response(status: 200, body: Data(#"{"config":{"node":{"name":"Mac","avatar":null}}}"#.utf8))
        default:
            throw PairingError.invalidResponse
        }
    }
    func close() {}
}
