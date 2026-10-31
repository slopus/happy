import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

/// The relay as happy-server answers a computer's code: the query read by
/// fastify's parser, where "+" is a space, and the key decoded strictly, so
/// a key that arrives mangled is a 500 (authRoutes.ts:104).
private final class Relay: @unchecked Sendable {
    let http = FakeHTTP()
    private let lock = NSLock()
    private var answered: [Data: (token: String, response: Data)] = [:]
    private let terminal: Data

    init(terminal: Data) {
        self.terminal = terminal
        http.on("POST /v1/auth") { request in
            let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any]
            let key = try XCTUnwrap(body?["publicKey"] as? String)
            return (200, try JSONSerialization.data(withJSONObject: ["success": true, "token": "token-\(key)"]))
        }
        http.on("GET /v1/auth/request/status") { [unowned self] request in
            guard let key = Self.fastifyQuery(request.url)["publicKey"].flatMap({ Data(base64Encoded: $0) }) else {
                return (500, Data(#"{"message":"Base64Coder: incorrect characters for decoding"}"#.utf8))
            }
            let status = key != self.terminal ? "not_found" : (self.answer(for: key) == nil ? "pending" : "authorized")
            return (200, Data(#"{"status":"\#(status)","supportsV2":true}"#.utf8))
        }
        http.on("POST /v1/auth/response") { [unowned self] request in
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: String])
            let key = try XCTUnwrap(body["publicKey"].flatMap { Data(base64Encoded: $0) })
            let response = try XCTUnwrap(body["response"].flatMap { Data(base64Encoded: $0) })
            let token = try XCTUnwrap(request.headers["Authorization"]?.replacingOccurrences(of: "Bearer ", with: ""))
            lock.withLock { answered[key] = (token, response) }
            return (200, Data(#"{"success":true}"#.utf8))
        }
    }

    func answer(for key: Data) -> (token: String, response: Data)? {
        lock.withLock { answered[key] }
    }

    /// fast-querystring: "+" is a space, then percent-decoding.
    static func fastifyQuery(_ url: URL) -> [String: String] {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
        var values: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "" }
            values[parts[0]] = parts.count > 1 ? parts[1] : ""
        }
        return values
    }
}

/// Add Agent with a computer's `happy://terminal?` code always makes a new
/// Happy account for it, beside whatever is here: none, a Happy account, or
/// an agent connection. Each ends with exactly one account more, the new
/// one active, and the computer holding that account's key.
@MainActor
final class LegacyTerminalCodeTests: XCTestCase {
    /// A computer's key whose base64 has a "+", as about half do: the
    /// ones that used to fail.
    private func terminal() throws -> BoxKeyPair {
        var seed: UInt8 = 0
        while true {
            let pair = try BoxKeyPair(secretKey: Data(repeating: seed, count: 32))
            if pair.publicKey.base64EncodedString().contains("+") { return pair }
            seed += 1
        }
    }

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(_ relay: Relay, backend: AccountsKeychain = AccountsKeychain(), directory: URL? = nil) throws -> AccountController {
        AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: backend), storeDirectory: try directory ?? self.directory(),
            accountCredentialStore: KeychainAccountCredentialStore(backend: backend),
            agentConnectionCredentialStore: KeychainAgentConnectionCredentialStore(backend: backend),
            agentTransport: { _ in IdentityTransport() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: relay.http, connector: FakeConnector())
    }

    /// Scans `terminal` as Add Agent does and checks the end state against
    /// the accounts there were before.
    private func scan(_ terminal: BoxKeyPair, into account: AccountController, relay: Relay, file: StaticString = #filePath, line: UInt = #line) async throws {
        let before = account.accounts
        let code = HappyCode(LegacyPairingLink.terminal(publicKey: terminal.publicKey).urlString)
        let route = ScanRoute.route(code, intent: .addAccount, hasAccount: account.session != nil)
        XCTAssertEqual(route, .newAccountForComputer(publicKey: terminal.publicKey), file: file, line: line)

        let outcome = try await account.addAccount(approvingTerminal: terminal.publicKey)
        XCTAssertEqual(outcome, .terminalConnected, file: file, line: line)

        // Exactly one account more, the new one, active; the others as they were.
        let session = try XCTUnwrap(account.session, file: file, line: line)
        let added = account.accounts.filter { account in !before.contains { $0.id == account.id } }
        XCTAssertEqual(added.map(\.id), [session.keys.anonID], file: file, line: line)
        XCTAssertEqual(account.accounts.count, before.count + 1, file: file, line: line)
        XCTAssertEqual(account.accounts.filter(\.isActive).map(\.id), [session.keys.anonID], file: file, line: line)
        XCTAssertEqual(Set(account.accounts.map(\.id)).subtracting([session.keys.anonID]), Set(before.map(\.id)), file: file, line: line)
        XCTAssertNil(account.agentConnections.activeID, file: file, line: line)
        XCTAssertFalse(account.isAddingAccount, file: file, line: line)

        // The computer got the new account's content key, sent with its token.
        let answer = try XCTUnwrap(relay.answer(for: terminal.publicKey), "the computer was never answered", file: file, line: line)
        XCTAssertEqual(answer.token, session.credentials.token, file: file, line: line)
        let opened = try XCTUnwrap(Box.openAnonymous(answer.response, recipientSecretKey: terminal.secretKey), file: file, line: line)
        XCTAssertEqual(opened.first, 0, file: file, line: line)
        XCTAssertEqual(Data(opened.dropFirst()), session.keys.contentKeyPair.publicKey, file: file, line: line)
    }

    /// The bug Steve hit: the key went out with a bare "+", the server read
    /// a space, and the scan ended in "Failed to connect terminal".
    func testTheKeyGoesOutWithItsPlusEscaped() throws {
        let key = try terminal().publicKey
        let request = try HappyAPI(serverURL: ServerConfig.defaultServerURL, clientID: "ios/test", transport: FakeHTTP())
            .makeRequest("GET", "/v1/auth/request/status", query: [URLQueryItem(name: "publicKey", value: key.base64EncodedString())], authenticated: false)
        let query = try XCTUnwrap(request.url.query(percentEncoded: true))
        XCTAssertFalse(query.contains("+"), query)
        XCTAssertEqual(Relay.fastifyQuery(request.url)["publicKey"], key.base64EncodedString())
    }

    func testWithNothingHere() async throws {
        let computer = try terminal()
        let relay = Relay(terminal: computer.publicKey)
        let account = try controller(relay)
        await account.restore()
        try await scan(computer, into: account, relay: relay)
        XCTAssertEqual(account.accounts.count, 1)
    }

    func testBesideAHappyAccount() async throws {
        let computer = try terminal()
        let relay = Relay(terminal: computer.publicKey)
        let account = try controller(relay)
        await account.restore()
        let existing = Credentials(token: "existing", secret: Data(repeating: 7, count: 32))
        try await account.signIn(existing)
        try await scan(computer, into: account, relay: relay)
        XCTAssertEqual(account.accounts.count, 2)
        // The old account is still signed in and opens as it was.
        let existingID = try AccountKeys(secret: XCTUnwrap(existing.secretData)).anonID
        try await account.switchAccount(to: existingID)
        XCTAssertEqual(account.session?.credentials, existing)
    }

    func testBesideAnAgentConnection() async throws {
        let computer = try terminal()
        let relay = Relay(terminal: computer.publicKey)
        let account = try controller(relay)
        await account.agentConnections.setForeground(false)
        await account.restore()
        try await account.addAgentConnection(AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: "device", deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32))), name: "Mac")
        let connection = try XCTUnwrap(account.agentConnections.activeID)
        try await scan(computer, into: account, relay: relay)
        XCTAssertEqual(account.accounts.count, 2)
        XCTAssertTrue(account.accounts.contains { $0.id == connection && $0.isAgentConnection })
        try await account.switchAccount(to: connection)
        XCTAssertEqual(account.agentConnections.activeID, connection)
    }

    private func machine(_ id: String, created: Int64, name: String?, host: String = "host.local", rig: Bool = false) -> MachineRecord {
        var metadata: [String: JSONValue] = ["host": .string(host)]
        if let name { metadata["displayName"] = .string(name) }
        if rig { metadata["machineKind"] = "rig" }
        return MachineRecord(id: id, seq: 0, createdAt: created, updatedAt: created, active: true, activeAt: 1_000 - created,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }

    /// The account made for a computer is no legacy account: it goes by the
    /// first computer paired with it, keeps that across launches, and only
    /// the legacy one beside it may show or hand on its key.
    func testTheNewAccountGoesByTheFirstComputer() async throws {
        let computer = try terminal()
        let relay = Relay(terminal: computer.publicKey)
        let backend = AccountsKeychain()
        let directory = try directory()
        let account = try controller(relay, backend: backend, directory: directory)
        await account.restore()
        let existing = Credentials(token: "existing", secret: Data(repeating: 7, count: 32))
        try await account.signIn(existing)
        XCTAssertTrue(account.sessionIsLegacy)
        try await scan(computer, into: account, relay: relay)
        XCTAssertFalse(account.sessionIsLegacy)
        let session = try XCTUnwrap(account.session)
        let newID = session.keys.anonID
        func summary(_ id: String) -> AccountSummary? { account.accounts.first { $0.id == id } }
        let existingID = try AccountKeys(secret: XCTUnwrap(existing.secretData)).anonID
        XCTAssertEqual(summary(newID)?.origin, .madeForComputer)
        XCTAssertEqual(summary(existingID)?.isLegacy, true)
        XCTAssertNil(summary(newID)?.resolvedName, "nothing names it before its computer arrives")

        // The first paired, not the most recently active, and a later one
        // doesn't rename it.
        try session.store.upsertMachine(machine("later", created: 20, name: "Studio"))
        try session.store.upsertMachine(machine("first", created: 10, name: "Steve’s MacBook"))
        try await until { summary(newID)?.resolvedName == "Steve’s MacBook" }
        XCTAssertEqual(summary(newID)?.resolvedName, "Steve’s MacBook")
        // Happy Agent's display name only tells it from its sibling: the host.
        try session.store.upsertMachine(machine("agent", created: 5, name: "Mac (Happy Agent)", host: "macbook.local", rig: true))
        try await until { summary(newID)?.resolvedName == "macbook.local" }
        XCTAssertEqual(summary(newID)?.resolvedName, "macbook.local")

        // A legacy account never goes by a computer.
        try await account.switchAccount(to: existingID)
        try XCTUnwrap(account.session).store.upsertMachine(machine("m", created: 1, name: "Old Mac"))
        try await until { summary(existingID)?.computerName == "Old Mac" }
        XCTAssertNil(summary(existingID)?.resolvedName)

        // Both kept across a launch, from the registry and the stores.
        await account.flushProfilePersistence()
        let relaunched = try controller(relay, backend: backend, directory: directory)
        await relaunched.restore()
        XCTAssertEqual(relaunched.accounts.first { $0.id == newID }?.origin, .madeForComputer)
        XCTAssertEqual(relaunched.accounts.first { $0.id == newID }?.resolvedName, "macbook.local")
        XCTAssertEqual(relaunched.accounts.first { $0.id == existingID }?.isLegacy, true)
    }

    /// Entries from before the origin existed are legacy.
    func testAnOldRegistryEntryIsLegacy() throws {
        let json = #"{"id":"0123456789abcdef","serverURL":"https://api.cluster-fluster.com","location":"shared","addedOrder":0}"#
        let entry = try JSONDecoder().decode(AccountRegistryEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.origin, .legacy)
        let made = AccountRegistryEntry(id: "0123456789abcdef", serverURL: ServerConfig.defaultServerURL, location: .own, addedOrder: 1, origin: .madeForComputer)
        XCTAssertEqual(try JSONDecoder().decode(AccountRegistryEntry.self, from: JSONEncoder().encode(made)).origin, .madeForComputer)
    }

    /// A code already answered keeps nothing and changes nothing: the alert
    /// says so (`alreadyHandled`), and no stray account is left behind.
    func testAUsedCodeAddsNothing() async throws {
        let computer = try terminal()
        let relay = Relay(terminal: computer.publicKey)
        let account = try controller(relay)
        await account.restore()
        try await scan(computer, into: account, relay: relay)
        let before = account.accounts
        let outcome = try await account.addAccount(approvingTerminal: computer.publicKey)
        XCTAssertEqual(outcome, .alreadyHandled)
        XCTAssertEqual(account.accounts, before)
    }
}
