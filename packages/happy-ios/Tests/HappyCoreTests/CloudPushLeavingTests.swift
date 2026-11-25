import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A computer unpaired from the phone holds no registration of it: its
/// registration is taken off before the pairing goes, and when the
/// computer can't be told then, it is told later, across launches, with
/// what the pairing left for that alone.
final class CloudPushLeavingTests: XCTestCase {
    /// A computer that answers each request as scripted: a status, or
    /// nothing, which is not reaching it. It says what it was asked.
    actor Computer: AgentTransport {
        struct Asked: Equatable { var route: String; var bearer: String; var version: String? }
        private var answers: [Int?]
        private(set) var asked: [Asked] = []
        private let arrived: (@Sendable () async -> Void)?
        init(_ answers: [Int?], arrived: (@Sendable () async -> Void)? = nil) { self.answers = answers; self.arrived = arrived }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            asked.append(Asked(route: "\(method) \(path)", bearer: credential, version: headers["If-Match"]))
            await arrived?()
            let answer = answers.count > 1 ? answers.removeFirst() : answers.first ?? nil
            guard let answer else { throw URLError(.cannotConnectToHost) }
            return .init(status: answer, body: Data(answer == 200 ? CloudPushTests.registration.utf8 : "{}".utf8))
        }
        func close() {}
    }

    /// Every computer a later try was made on, in order.
    final class Tries: @unchecked Sendable {
        private let lock = NSLock()
        private var made: [AgentConnectionCredentials] = []
        private let next: @Sendable (Int, AgentConnectionCredentials) -> Computer
        /// `next`: the computer for a try, by its number (from 1) and what it was made with.
        init(_ next: @escaping @Sendable (Int, AgentConnectionCredentials) -> Computer) { self.next = next }
        var credentials: [AgentConnectionCredentials] { lock.withLock { made } }
        func connect(_ credentials: AgentConnectionCredentials) -> any AgentTransport {
            let index = lock.withLock { made.append(credentials); return made.count }
            return next(index, credentials)
        }
    }

    static let pairing = AgentConnectionCredentials(address: "100.64.0.9", port: 4242, deviceID: "device-1", deviceToken: "device-token", publicUrl: "https://mac.example")
    static let given = "7c1d8a5e-2f43-4c1b-9d0e-1f2a3b4c5d6e"

    /// A phone registered with a computer as "paired", and what keeps it.
    private func registered(store: any CloudPushUnregisterStore = InMemoryCloudPushUnregisterStore(), tries: Tries) async throws -> (push: CloudPush, ids: CloudPushIDs, registration: String) {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        var source = CloudPushTests.source(relay: CloudPushTests.Relay(CloudPushTests.token), permission: CloudPushTests.Permission(.authorized))
        source.ids = ids
        source.leaving = store
        source.connect = { tries.connect($0) }
        let push = CloudPush(source: source)
        await push.setBackoff(Backoff(initial: .milliseconds(10), maximum: .milliseconds(20)))
        let server = ProvidersServer()
        let registration = ids.registration(for: "paired")
        await server.answer("GET /v0/health", 200, CloudPushTests.health)
        await server.answer("PUT /v0/cloud/push/registrations/\(registration)", 200, CloudPushTests.registration)
        let outcome = try await push.register(connection: "paired", client: AgentClient(transport: server, token: "device-token"), ask: false, cloud: false)
        XCTAssertEqual(outcome, .registered)
        return (push, ids, registration)
    }

    /// Unpaired while the computer is off or out of reach: the phone
    /// forgets the pairing at once, as the person asked, and keeps only
    /// what taking the registration off needs. The next launch sends it.
    func testAComputerThatCannotBeReachedIsToldAtTheNextLaunch() async throws {
        let store = InMemoryCloudPushUnregisterStore()
        let never = Tries { _, _ in Computer([nil]) }
        let (push, ids, registration) = try await registered(store: store, tries: never)
        await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
        let unreachable = Computer([nil])
        try await push.unregister(connection: "paired", client: AgentClient(transport: unreachable, token: "device-token"), credentials: Self.pairing)
        let kept = try store.all()
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept["paired"]?.registration, registration)
        XCTAssertEqual(kept["paired"]?.version, Self.given)
        XCTAssertEqual(kept["paired"]?.credentials, Self.pairing)
        XCTAssertNil(ids.version(for: "paired"), "the pairing's own record of it goes with the pairing")

        // The next launch: nothing in memory, the computer back.
        let back = Computer([204])
        let later = Tries { _, _ in back }
        var source = CloudPushTests.source(relay: CloudPushTests.Relay(CloudPushTests.token), permission: CloudPushTests.Permission(.authorized))
        source.leaving = store
        source.connect = { later.connect($0) }
        let relaunched = CloudPush(source: source)
        await relaunched.resume()
        await relaunched.waitUntilSettled()
        let asked = await back.asked
        XCTAssertEqual(asked, [.init(route: "DELETE /v0/cloud/push/registrations/\(registration)", bearer: "device-token", version: Self.given)])
        XCTAssertEqual(later.credentials, [Self.pairing])
        XCTAssertTrue(try store.all().isEmpty, "answered: nothing of the pairing is kept any longer")
    }

    /// While the app runs it asks again, each time on a new way to the
    /// computer (the pairing's own is gone), until the computer answers.
    func testItIsAskedAgainUntilTheComputerAnswers() async throws {
        let store = InMemoryCloudPushUnregisterStore()
        let back = Computer([204])
        let tries = Tries { index, _ in index < 3 ? Computer([nil]) : back }
        let (push, _, registration) = try await registered(store: store, tries: tries)
        try await push.unregister(connection: "paired", client: AgentClient(transport: Computer([nil]), token: "device-token"), credentials: Self.pairing)
        await push.waitUntilSettled()
        XCTAssertEqual(tries.credentials.count, 3)
        let asked = await back.asked
        XCTAssertEqual(asked.map(\.route), ["DELETE /v0/cloud/push/registrations/\(registration)"])
        XCTAssertTrue(try store.all().isEmpty)
    }

    /// A computer just unpaired is asked for now, not when the wait for
    /// an older one that still doesn't answer ends.
    func testOneJustLeftIsNotHeldBehindAnOlderOne() async throws {
        let store = InMemoryCloudPushUnregisterStore()
        var asleep = Self.pairing
        asleep.publicUrl = "https://asleep.example"
        try store.save(PendingCloudPushUnregister(credentials: asleep, registration: "r-old", version: Self.given, queuedAt: Date().addingTimeInterval(-3600)), id: "old")
        let back = Computer([204])
        let tries = Tries { _, _ in Computer([nil]) }
        let (push, _, registration) = try await registered(store: store, tries: tries)
        await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
        await push.resume()
        for _ in 0..<200 where tries.credentials.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(tries.credentials, [asleep], "the older one was asked, and now waits a minute")

        let later = Tries { _, credentials in credentials.publicUrl == Self.pairing.publicUrl ? back : Computer([nil]) }
        await push.setConnect { later.connect($0) }
        try await push.unregister(connection: "paired", client: AgentClient(transport: Computer([nil]), token: "device-token"), credentials: Self.pairing)
        for _ in 0..<200 where (try? store.all()["paired"]) != nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(try store.all().keys.sorted(), ["old"])
        let asked = await back.asked
        XCTAssertEqual(asked.map(\.route), ["DELETE /v0/cloud/push/registrations/\(registration)"])
    }

    /// It is kept before the computer is asked: the app killed, or left,
    /// with the request on its way loses nothing.
    func testItIsKeptBeforeTheComputerIsAsked() async throws {
        let store = InMemoryCloudPushUnregisterStore()
        let (push, _, _) = try await registered(store: store, tries: Tries { _, _ in Computer([nil]) })
        final class Seen: @unchecked Sendable { var count = -1 }
        let seen = Seen()
        let computer = Computer([204]) { seen.count = (try? store.all().count) ?? -1 }
        try await push.unregister(connection: "paired", client: AgentClient(transport: computer, token: "device-token"), credentials: Self.pairing)
        XCTAssertEqual(seen.count, 1)
        XCTAssertTrue(try store.all().isEmpty, "answered at once: nothing is kept")
    }

    /// An answer ends it: taken off, already gone, a route the computer
    /// doesn't have, or a phone it no longer knows (revoked on the
    /// computer: nothing this phone can take off). A computer that failed
    /// or asked to wait is asked again.
    func testAnAnswerEndsItAndAFailureDoesNot() async throws {
        for status in [204, 404, 401, 403, 400] {
            let store = InMemoryCloudPushUnregisterStore()
            let tries = Tries { _, _ in Computer([nil]) }
            let (push, _, _) = try await registered(store: store, tries: tries)
            try await push.unregister(connection: "paired", client: AgentClient(transport: Computer([status]), token: "device-token"), credentials: Self.pairing)
            XCTAssertTrue(try store.all().isEmpty, "\(status)")
            XCTAssertTrue(tries.credentials.isEmpty, "\(status)")
        }
        for status in [500, 503, 429, 408] {
            let store = InMemoryCloudPushUnregisterStore()
            let (push, _, _) = try await registered(store: store, tries: Tries { _, _ in Computer([nil]) })
            await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
            try await push.unregister(connection: "paired", client: AgentClient(transport: Computer([status]), token: "device-token"), credentials: Self.pairing)
            XCTAssertEqual(try store.all().count, 1, "\(status)")
        }
    }

    /// A registration lasts thirty days on the computer: one still not
    /// taken off by then is gone there, and what was kept for it goes too,
    /// without a request.
    func testOneKeptThirtyDaysIsDropped() async throws {
        let store = InMemoryCloudPushUnregisterStore()
        try store.save(PendingCloudPushUnregister(credentials: Self.pairing, registration: "r1", version: Self.given, queuedAt: Date().addingTimeInterval(-31 * 24 * 3600)), id: "old")
        let tries = Tries { _, _ in Computer([204]) }
        var source = CloudPushTests.source(relay: CloudPushTests.Relay(CloudPushTests.token), permission: CloudPushTests.Permission(.authorized))
        source.leaving = store
        source.connect = { tries.connect($0) }
        let push = CloudPush(source: source)
        await push.resume()
        await push.waitUntilSettled()
        XCTAssertTrue(try store.all().isEmpty)
        XCTAssertTrue(tries.credentials.isEmpty)
    }

    /// A server signed in to is left with its session ended: nothing of
    /// the sign-in is kept to ask it again.
    func testASignInKeepsNothing() async throws {
        let store = InMemoryCloudPushUnregisterStore()
        let tries = Tries { _, _ in Computer([204]) }
        let (push, _, _) = try await registered(store: store, tries: tries)
        let method = OAuthMethod(id: "jwt", name: "Own", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        let signIn = AgentConnectionCredentials.server(try AgentOrigin("https://happy.acme.example"), signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "r", clientId: "happy"), userId: "u1"))
        do {
            try await push.unregister(connection: "paired", client: AgentClient(transport: Computer([nil]), token: "t"), credentials: signIn)
            XCTFail("a server that could not be told was taken as told")
        } catch {}
        XCTAssertTrue(try store.all().isEmpty)
        XCTAssertTrue(tries.credentials.isEmpty)
    }

    /// Once leaving a connection has begun, nothing registers on it again:
    /// a renewal as the app comes back (while the computer is being told,
    /// or after) would leave a registration the phone no longer knows of.
    func testNothingRegistersOnceLeavingHasBegun() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let gate = CloudPushTests.Gate()
        var source = CloudPushTests.source(relay: CloudPushTests.Relay(CloudPushTests.token), permission: CloudPushTests.Permission(.authorized))
        source.ids = ids
        let push = CloudPush(source: source)
        let server = ProvidersServer()
        let registration = ids.registration(for: "paired")
        await server.answer("GET /v0/health", 200, CloudPushTests.health)
        await server.answer("PUT /v0/cloud/push/registrations/\(registration)", 200, CloudPushTests.registration, then: CloudPushTests.newer)
        await server.answer("DELETE /v0/cloud/push/registrations/\(registration)", 204, "")
        let client = AgentClient(transport: SlowDelete(server, gate), token: "t")
        _ = try await push.register(connection: "paired", client: client, ask: false, cloud: false)
        let leave = Task { try await push.unregister(connection: "paired", client: client, credentials: Self.pairing) }
        try await gate.arrival()
        let during = try await push.register(connection: "paired", client: client, ask: false, cloud: false)
        XCTAssertEqual(during, .leaving)
        await gate.open()
        try await leave.value
        for ask in [false, true] {
            let after = try await push.register(connection: "paired", client: client, ask: ask, cloud: false, now: Date().addingTimeInterval(CloudPush.renewal + 1))
            XCTAssertEqual(after, .leaving)
        }
        let routes = await server.routes
        XCTAssertEqual(routes.filter { $0.hasPrefix("PUT") }.count, 1, "\(routes)")
        XCTAssertEqual(routes.last, "DELETE /v0/cloud/push/registrations/\(registration)")
        XCTAssertNil(ids.version(for: "paired"))
    }

    /// The same routes, with every DELETE held at `gate`.
    actor SlowDelete: AgentTransport {
        let inner: ProvidersServer
        let gate: CloudPushTests.Gate
        init(_ inner: ProvidersServer, _ gate: CloudPushTests.Gate) { self.inner = inner; self.gate = gate }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            if method == "DELETE" { await gate.wait() }
            return try await inner.request(method: method, path: path, credential: credential, body: body, headers: headers)
        }
        func close() {}
    }

    /// In the app what is kept is a Keychain item of its own, one for each
    /// connection left, gone once the computer answers.
    func testWhatIsKeptIsAKeychainItemOfItsOwn() throws {
        let keychain = AccountsKeychain()
        let store = KeychainCloudPushUnregisterStore(backend: keychain)
        let pending = PendingCloudPushUnregister(credentials: Self.pairing, registration: "r1", version: Self.given, queuedAt: Date(timeIntervalSince1970: 1_800_000_000))
        try store.save(pending, id: "direct-1")
        XCTAssertEqual(try KeychainCloudPushUnregisterStore(backend: keychain).all(), ["direct-1": pending])
        XCTAssertEqual(try keychain.accounts(service: "happy-ios:cloud-push-unregister"), ["direct-1"])
        XCTAssertTrue(try KeychainAgentConnectionCredentialStore(backend: keychain).all().isEmpty, "never listed as a pairing")
        try store.remove(id: "direct-1")
        XCTAssertTrue(try store.all().isEmpty)
    }
}
