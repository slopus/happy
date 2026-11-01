import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

/// A server and a computer that refuse at once while the test sets up,
/// then, from `begin`, never answer, deaf even to cancellation, until the
/// test lets go of them.
private final class Silence: HTTPTransport, AgentTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var held: [CheckedContinuation<Void, Never>] = []
    private var silent = false
    private var sent: [HTTPRequest] = []
    var requests: [HTTPRequest] { lock.withLock { sent } }

    func begin() { lock.withLock { silent = true } }

    func hold() async {
        await withCheckedContinuation { continuation in
            let waits = lock.withLock {
                if silent { held.append(continuation) }
                return silent
            }
            if !waits { continuation.resume() }
        }
    }

    func release() {
        let waiting = lock.withLock {
            silent = false
            defer { held = [] }
            return held
        }
        waiting.forEach { $0.resume() }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { sent.append(request) }
        await hold()
        throw URLError(.notConnectedToInternet)
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        await hold()
        throw URLError(.cannotConnectToHost)
    }

    func close() async {}
}

/// Signing out and disconnecting are final the moment they are asked for,
/// whatever the network does; the rest is written down and finished behind,
/// across a kill if need be (docs/accounts.md, "Signing out").
@MainActor
final class InstantSignOutTests: XCTestCase {
    private let first = Credentials(token: "first", secret: Data(repeating: 11, count: 32))
    private let second = Credentials(token: "second", secret: Data(repeating: 12, count: 32))

    private struct Phone {
        let directory: URL
        let keychain = AccountsKeychain()
        let unregisters = InMemoryPushUnregisterStore()
        let settings = InMemoryKeyValueStore()
        let silence = Silence()
    }

    private func phone() throws -> Phone {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let phone = Phone(directory: url)
        addTeardownBlock {
            phone.silence.release()
            try? FileManager.default.removeItem(at: url)
        }
        return phone
    }

    /// `killed`: every removal stops straight after it is written down.
    private func launch(_ phone: Phone, killed: Bool = false) -> AccountController {
        let silence = phone.silence
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: phone.keychain), storeDirectory: phone.directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: phone.keychain),
            agentConnectionCredentialStore: KeychainAgentConnectionCredentialStore(backend: phone.keychain),
            agentTransport: { _ in silence },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: { [settings = phone.settings] id in PrefixedStore(base: settings, prefix: id) },
            transport: silence, connector: FakeConnector(), pushUnregisterStore: phone.unregisters)
        if killed { account.holdRemoval = { await silence.hold() } }
        account.teardownLimit = .milliseconds(300)
        return account
    }

    private func agent(_ id: String) -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "silent", port: 1, deviceID: id, deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
    }

    func testTheOpenHappyAccountIsGoneAtOnceAndTheNextOpensWithoutTheNetwork() async throws {
        let phone = try phone()
        let account = launch(phone)
        await account.restore()
        try await account.signIn(first)
        try await account.signIn(second)
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        let firstID = try accountID(first), secondID = try accountID(second)
        phone.silence.begin()

        let cleanup = try account.beginSignOut(accountID: secondID)
        XCTAssertEqual(account.accounts.map(\.id), [firstID], "listed after the confirm")
        await eventually { await MainActor.run { account.session?.keys.anonID == firstID } }
        // Everything else finishes too, though nothing ever answers: the
        // push token's removal waits in its queue.
        try await cleanup.value
        XCTAssertNil(try KeychainAccountCredentialStore(backend: phone.keychain).ownAccounts()[secondID])
        XCTAssertFalse(FileManager.default.fileExists(atPath: AccountSession.accountDirectory(directory: phone.directory, id: secondID).path))
        XCTAssertEqual(try phone.unregisters.all()[secondID]?.pushToken, "ExponentPushToken[second]")
        phone.silence.release()
        await account.session?.stop()
    }

    func testTheOpenAgentIsReplacedInTheSameCall() async throws {
        let phone = try phone()
        let account = launch(phone)
        await account.restore()
        try await account.addAgentConnection(agent("one"), name: "One")
        let one = try XCTUnwrap(account.agentConnections.activeID)
        try await account.addAgentConnection(agent("two"), name: "Two")
        let two = try XCTUnwrap(account.agentConnections.activeID)
        phone.silence.begin()

        let cleanup = try account.beginSignOut(accountID: two)
        XCTAssertEqual(account.agentConnections.activeID, one)
        guard case .agentConnection(let open) = account.state else { return XCTFail("no agent open: \(account.state)") }
        XCTAssertEqual(open.id, one)
        XCTAssertEqual(account.accounts.map(\.id), [one])
        // Its identity loop is stuck on the computer; the credentials go
        // regardless, and the folder once the wait for it runs out.
        await eventually { (try? KeychainAgentConnectionCredentialStore(backend: phone.keychain).all()[two]) == nil }
        phone.silence.release()
        try await cleanup.value
    }

    /// Killed straight after each confirm: the next launch lists neither,
    /// though their Keychain items and folders are all still there, and
    /// finishes forgetting them, the push token's removal included.
    func testAKillAfterTheConfirmIsFinishedByTheNextLaunch() async throws {
        let phone = try phone()
        let account = launch(phone, killed: true)
        await account.restore()
        try await account.signIn(first)
        try await account.signIn(second)
        account.localSettings.registeredPushToken = "ExponentPushToken[second]"
        try await account.addAgentConnection(agent("one"), name: "One")
        let agentID = try XCTUnwrap(account.agentConnections.activeID)
        try await account.switchAccount(to: try accountID(second))
        let firstID = try accountID(first), secondID = try accountID(second)
        phone.silence.begin()
        try account.beginSignOut(accountID: secondID)
        try account.beginSignOut(accountID: agentID)
        XCTAssertEqual(account.accounts.map(\.id), [firstID])
        await eventually { await MainActor.run { account.session?.keys.anonID == firstID } }
        XCTAssertNotNil(try KeychainAccountCredentialStore(backend: phone.keychain).ownAccounts()[secondID], "the cleanup wasn't held")
        XCTAssertNotNil(try KeychainAgentConnectionCredentialStore(backend: phone.keychain).all()[agentID], "the cleanup wasn't held")

        let relaunched = launch(phone)
        await relaunched.restore()
        XCTAssertEqual(relaunched.accounts.map(\.id), [firstID], "an account came back")
        XCTAssertEqual(relaunched.session?.keys.anonID, firstID)
        await eventually {
            (try? KeychainAccountCredentialStore(backend: phone.keychain).ownAccounts()[secondID]) == nil
                && (try? KeychainAgentConnectionCredentialStore(backend: phone.keychain).all()[agentID]) == nil
                && !FileManager.default.fileExists(atPath: AccountSession.accountDirectory(directory: phone.directory, id: secondID).path)
        }
        XCTAssertEqual(try phone.unregisters.all()[secondID]?.token, "second")
        await eventually { phone.silence.requests.contains { $0.url.path == "/v1/push-tokens/ExponentPushToken[second]" } }

        // Once finished, it is struck off: a third launch has nothing to do.
        let removals = phone.directory.appendingPathComponent("removals.json")
        await eventually { (try? JSONDecoder().decode([AccountRemoval].self, from: Data(contentsOf: removals)))?.isEmpty == true }
        phone.silence.release()
        await relaunched.session?.stop()
    }

    /// Signed in again while its sign-out is still being cleaned up: the
    /// cleanup ends first, and the account is back for good.
    func testSigningInAgainDuringTheCleanupKeepsTheNewSignIn() async throws {
        let phone = try phone()
        let account = launch(phone)
        await account.restore()
        try await account.signIn(first)
        try await account.signIn(second)
        let secondID = try accountID(second)
        try account.beginSignOut(accountID: secondID)
        try await account.signIn(second)
        XCTAssertEqual(account.session?.keys.anonID, secondID)
        XCTAssertNotNil(try KeychainAccountCredentialStore(backend: phone.keychain).ownAccounts()[secondID])
        await account.session?.stop()

        let relaunched = launch(phone)
        await relaunched.restore()
        XCTAssertEqual(Set(relaunched.accounts.map(\.id)), Set([try accountID(first), secondID]))
        await relaunched.session?.stop()
    }
}

/// One device-settings suite per account over a single store.
private struct PrefixedStore: KeyValueStore {
    let base: InMemoryKeyValueStore
    let prefix: String
    func string(forKey key: String) -> String? { base.string(forKey: "\(prefix).\(key)") }
    func set(_ value: String?, forKey key: String) { base.set(value, forKey: "\(prefix).\(key)") }
}
