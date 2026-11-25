import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A registration the computer took whose answer never reached the phone
/// (a timeout, an app killed with the request on its way). The computer
/// holds a version the phone was never given, and takes off only the
/// latest: what the phone would send takes nothing off. So leaving first
/// registers once more, which says the version the computer holds now,
/// and takes that off.
final class CloudPushLostAnswerTests: XCTestCase {
    /// A computer's registrations as Happy Agent keeps them: each `PUT`
    /// it takes gets a new version, and a `DELETE` takes off only the
    /// version it names (any other is answered 204 all the same).
    actor Daemon: AgentTransport {
        enum Way: Sendable {
            /// Taken and answered.
            case up
            /// Taken, and the answer lost on its way back.
            case lost
            /// Never reached.
            case down
            /// Refused with this status, not taken.
            case status(Int)
        }
        var put = Way.up
        var delete = Way.up
        /// The registrations it holds: id to version.
        private(set) var rows: [String: String] = [:]
        /// `PUT`, or `DELETE <If-Match>`, in order.
        private(set) var asked: [String] = []
        private(set) var bearers: Set<String> = []
        /// The token of every `PUT` it was sent.
        private(set) var tokens: [String] = []
        private var made = 0

        func set(put: Way? = nil, delete: Way? = nil) {
            if let put { self.put = put }
            if let delete { self.delete = delete }
        }
        func forgetAsked() { asked = [] }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            if path == "/v0/health" { return .init(status: 200, body: Data(CloudPushTests.health.utf8)) }
            let prefix = "/v0/cloud/push/registrations/"
            guard path.hasPrefix(prefix) else { return .init(status: 404, body: Data("{}".utf8)) }
            let id = String(path.dropFirst(prefix.count))
            bearers.insert(credential)
            let way = method == "PUT" ? put : delete
            asked.append(method == "PUT" ? "PUT" : "DELETE \(headers["If-Match"] ?? "-")")
            if case .down = way { throw URLError(.cannotConnectToHost) }
            if case .status(let status) = way { return .init(status: status, body: Data("{}".utf8)) }
            var answer = HTTP1Response(status: 204, body: Data())
            if method == "PUT" {
                made += 1
                rows[id] = "v\(made)"
                if let body, let token = (try? JSONValue.decode(body))?["token"]?.stringValue { tokens.append(token) }
                answer = .init(status: 200, body: Data(#"{"registration":{"id":"\#(id)","version":"v\#(made)","expiresAt":1900000000000}}"#.utf8))
            } else if rows[id] == headers["If-Match"] {
                rows[id] = nil
            }
            if case .lost = way { throw URLError(.timedOut) }
            return answer
        }
        func close() {}
    }

    static let pairing = CloudPushLeavingTests.pairing

    /// A phone and the computer it is paired with; `ids` and `store` are
    /// what a launch leaves the next.
    private func phone(_ daemon: Daemon, ids: CloudPushIDs, store: any CloudPushUnregisterStore = InMemoryCloudPushUnregisterStore(),
                       permission: PushPermission.SystemStatus = .authorized) async -> CloudPush {
        var source = CloudPushTests.source(relay: CloudPushTests.Relay(CloudPushTests.token), permission: CloudPushTests.Permission(permission))
        source.ids = ids
        source.leaving = store
        source.connect = { _ in daemon }
        let push = CloudPush(source: source)
        await push.setBackoff(Backoff(initial: .milliseconds(10), maximum: .milliseconds(20)))
        return push
    }

    private func client(_ daemon: Daemon) -> AgentClient { AgentClient(transport: daemon, token: "device-token") }

    /// Registered, then registered again with the answer lost: the
    /// computer holds v2, the phone was only ever given v1.
    private func lostAnswer(_ daemon: Daemon, ids: CloudPushIDs, store: any CloudPushUnregisterStore = InMemoryCloudPushUnregisterStore()) async throws -> CloudPush {
        let push = await phone(daemon, ids: ids, store: store)
        let first = try await push.register(connection: "paired", client: client(daemon), ask: false, cloud: false)
        XCTAssertEqual(first, .registered)
        await daemon.set(put: .lost)
        do { _ = try await push.register(connection: "paired", client: client(daemon), ask: true, cloud: false); XCTFail("an answer that never came was taken as one") } catch {}
        await daemon.set(put: .up)
        let rows = await daemon.rows
        XCTAssertEqual(rows.values.sorted(), ["v2"])
        XCTAssertEqual(ids.version(for: "paired"), "v1")
        await daemon.forgetAsked()
        return push
    }

    /// The whole of it: unpaired after an answer was lost, the computer
    /// holds nothing of this phone.
    func testARegistrationWhoseAnswerWasLostIsStillTakenOff() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore()), store = InMemoryCloudPushUnregisterStore()
        let push = try await lostAnswer(daemon, ids: ids, store: store)
        try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        await push.waitUntilSettled()
        let rows = await daemon.rows, asked = await daemon.asked, tokens = await daemon.tokens
        XCTAssertTrue(rows.isEmpty, "the computer still holds \(rows.values.sorted())")
        XCTAssertEqual(asked, ["PUT", "DELETE v3"], "registered once more for the version, then that taken off")
        XCTAssertEqual(Set(tokens), [CloudPushTests.token], "the same token as any registration")
        XCTAssertTrue(try store.all().isEmpty)
        XCTAssertFalse(ids.unsure("paired"))
    }

    /// The first registration there ever was, lost: the phone has no
    /// version at all, and the computer has a registration.
    func testAFirstRegistrationWhoseAnswerWasLostIsTakenOff() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let push = await phone(daemon, ids: ids)
        await daemon.set(put: .lost)
        do { _ = try await push.register(connection: "paired", client: client(daemon), ask: false, cloud: false); XCTFail() } catch {}
        await daemon.set(put: .up)
        XCTAssertNil(ids.version(for: "paired"))
        try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        await push.waitUntilSettled()
        let rows = await daemon.rows
        XCTAssertTrue(rows.isEmpty, "the computer still holds \(rows.values.sorted())")
    }

    /// What marks it, and what settles it: a registration sent is unsure
    /// until an answer says it was taken (2xx) or refused (a 4xx other
    /// than 408 and 429). No answer, 408, 429 and a 5xx leave it unsure.
    func testAnAnswerThatSettlesItClearsTheMark() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let push = await phone(daemon, ids: ids)
        func register(_ way: Daemon.Way) async {
            await daemon.set(put: way)
            _ = try? await push.register(connection: "paired", client: client(daemon), ask: true, cloud: false)
        }
        XCTAssertFalse(ids.unsure("paired"))
        await register(.up)
        XCTAssertFalse(ids.unsure("paired"))
        for way in [Daemon.Way.lost, .down, .status(500), .status(503), .status(408), .status(429)] {
            await register(.up)
            await register(way)
            XCTAssertTrue(ids.unsure("paired"), "\(way)")
        }
        for way in [Daemon.Way.up, .status(400), .status(401), .status(403), .status(404), .status(413)] {
            await register(.lost)
            await register(way)
            XCTAssertFalse(ids.unsure("paired"), "\(way)")
        }
    }

    /// A registration that was answered leaves as it always did: its
    /// version taken off, and nothing registered on the way out.
    func testAnAnsweredRegistrationIsOnlyTakenOff() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let push = await phone(daemon, ids: ids)
        _ = try await push.register(connection: "paired", client: client(daemon), ask: false, cloud: false)
        await daemon.forgetAsked()
        try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        let rows = await daemon.rows, asked = await daemon.asked
        XCTAssertEqual(asked, ["DELETE v1"])
        XCTAssertTrue(rows.isEmpty)
    }

    /// The computer off at unpair: what is kept says to register first,
    /// with the relay's token taken then, and the next launch does both
    /// with the pairing's own token.
    func testWithTheComputerOffItIsDoneAtTheNextLaunch() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore()), store = InMemoryCloudPushUnregisterStore()
        let push = try await lostAnswer(daemon, ids: ids, store: store)
        await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
        await daemon.set(put: .down, delete: .down)
        try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        let kept = try XCTUnwrap(try store.all()["paired"])
        XCTAssertEqual(kept.registerWith, CloudPushTests.token)
        XCTAssertEqual(kept.version, "v1")
        XCTAssertFalse(ids.unsure("paired"), "the pairing's own record of it goes with the pairing")
        // The try at unpair and the one right after it, then a minute's wait.
        for _ in 0..<200 where await daemon.asked.count < 2 { try await Task.sleep(for: .milliseconds(10)) }

        await daemon.set(put: .up, delete: .up)
        await daemon.forgetAsked()
        let relaunched = await phone(daemon, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: store, permission: .denied)
        await relaunched.resume()
        await relaunched.waitUntilSettled()
        let rows = await daemon.rows, asked = await daemon.asked, bearers = await daemon.bearers
        XCTAssertTrue(rows.isEmpty, "the computer still holds \(rows.values.sorted())")
        XCTAssertEqual(asked, ["PUT", "DELETE v3"])
        XCTAssertEqual(bearers, ["device-token"])
        XCTAssertTrue(try store.all().isEmpty)
    }

    /// Once the computer has said its version, that is what is kept: the
    /// relay's token goes, the thirty days start again (the registration
    /// was just renewed there), and later tries only take it off.
    func testOnceTheComputerHasSaidItsVersionItIsOnlyTakenOff() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore()), store = InMemoryCloudPushUnregisterStore()
        let push = try await lostAnswer(daemon, ids: ids, store: store)
        await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
        await daemon.set(delete: .down)
        let before = Date()
        try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        for _ in 0..<200 where (try? store.all()["paired"]?.registerWith) != nil { try await Task.sleep(for: .milliseconds(10)) }
        let kept = try XCTUnwrap(try store.all()["paired"])
        XCTAssertNil(kept.registerWith)
        XCTAssertEqual(kept.version, "v3")
        XCTAssertGreaterThanOrEqual(kept.queuedAt, before)
        // The try at unpair and the one right after it, then a minute's wait.
        for _ in 0..<200 where await daemon.asked.count < 3 { try await Task.sleep(for: .milliseconds(10)) }

        await daemon.set(delete: .up)
        await daemon.forgetAsked()
        let relaunched = await phone(daemon, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: store)
        await relaunched.resume()
        await relaunched.waitUntilSettled()
        let rows = await daemon.rows, asked = await daemon.asked
        XCTAssertEqual(asked, ["DELETE v3"])
        XCTAssertTrue(rows.isEmpty)
    }

    /// Registering once more renews the registration on the computer, so
    /// what is kept for it is kept thirty days from then, not from unpair.
    func testTheThirtyDaysStartAgainOnceItIsRegistered() async throws {
        let daemon = Daemon(), store = InMemoryCloudPushUnregisterStore()
        try store.save(PendingCloudPushUnregister(credentials: Self.pairing, registration: "r1", version: nil, registerWith: CloudPushTests.token,
                                                  queuedAt: Date().addingTimeInterval(-29 * 24 * 3600)), id: "paired")
        await daemon.set(delete: .down)
        let push = await phone(daemon, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: store)
        await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
        await push.resume()
        for _ in 0..<200 where (try? store.all()["paired"]?.version) == nil { try await Task.sleep(for: .milliseconds(10)) }
        let kept = try XCTUnwrap(try store.all()["paired"])
        XCTAssertEqual(kept.version, "v1")
        XCTAssertNil(kept.registerWith)
        XCTAssertGreaterThan(kept.queuedAt.timeIntervalSinceNow, -60)
    }

    /// The computer refusing that registration ends it: a phone it no
    /// longer knows, or a route it doesn't have, has nothing to take off.
    /// One that failed or asked to wait is registered with again later.
    func testARefusalOfThatRegistrationEndsIt() async throws {
        for status in [401, 403, 404, 400] {
            let daemon = Daemon(), store = InMemoryCloudPushUnregisterStore()
            let push = try await lostAnswer(daemon, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: store)
            await daemon.set(put: .status(status))
            try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
            let asked = await daemon.asked
            XCTAssertEqual(asked, ["PUT"], "\(status)")
            XCTAssertTrue(try store.all().isEmpty, "\(status)")
        }
        for way in [Daemon.Way.status(500), .status(429), .status(408), .down, .lost] {
            let daemon = Daemon(), store = InMemoryCloudPushUnregisterStore()
            let push = try await lostAnswer(daemon, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: store)
            await push.setBackoff(Backoff(initial: .seconds(60), maximum: .seconds(60)))
            await daemon.set(put: way)
            try await push.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
            let asked = await daemon.asked
            XCTAssertEqual(asked.first, "PUT", "\(way)")
            XCTAssertFalse(asked.contains { $0.hasPrefix("DELETE") }, "\(way): \(asked)")
            XCTAssertEqual(try store.all()["paired"]?.registerWith, CloudPushTests.token, "\(way)")
        }
    }

    /// A launch later, with the mark kept and no token in hand yet: one
    /// is asked of the relay for it, as a registration would.
    func testTheMarkOutlivesTheAppAndATokenIsFetchedForIt() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore())
        _ = try await lostAnswer(daemon, ids: ids)
        XCTAssertTrue(ids.unsure("paired"))
        let relaunched = await phone(daemon, ids: ids)
        try await relaunched.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        await relaunched.waitUntilSettled()
        let rows = await daemon.rows, asked = await daemon.asked
        XCTAssertEqual(asked, ["PUT", "DELETE v3"])
        XCTAssertTrue(rows.isEmpty)
    }

    /// With no token to be had (notifications since turned off) nothing
    /// can be registered: the version the phone has is taken off, as
    /// before, which may take nothing off.
    func testWithNoTokenToBeHadTheVersionInHandIsTakenOff() async throws {
        let daemon = Daemon(), ids = CloudPushIDs(store: InMemoryKeyValueStore()), store = InMemoryCloudPushUnregisterStore()
        _ = try await lostAnswer(daemon, ids: ids)
        let relaunched = await phone(daemon, ids: ids, store: store, permission: .denied)
        try await relaunched.unregister(connection: "paired", client: client(daemon), credentials: Self.pairing)
        await relaunched.waitUntilSettled()
        let asked = await daemon.asked
        XCTAssertEqual(asked, ["DELETE v1"])
        XCTAssertTrue(try store.all().isEmpty)
        XCTAssertNil(ids.version(for: "paired"))
    }

    /// A server signed in to gets the same in its one try: registered
    /// with once more, then that taken off. One that can't be told throws,
    /// as before, and nothing of the sign-in is kept.
    func testASignInIsRegisteredWithAgainFirstToo() async throws {
        let method = OAuthMethod(id: "jwt", name: "Own", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        let signIn = AgentConnectionCredentials.server(try AgentOrigin("https://happy.acme.example"), signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "r", clientId: "happy"), userId: "u1"))
        let daemon = Daemon(), store = InMemoryCloudPushUnregisterStore()
        let push = try await lostAnswer(daemon, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: store)
        try await push.unregister(connection: "paired", client: client(daemon), credentials: signIn)
        let rows = await daemon.rows, asked = await daemon.asked
        XCTAssertEqual(asked, ["PUT", "DELETE v3"])
        XCTAssertTrue(rows.isEmpty)
        XCTAssertTrue(try store.all().isEmpty)

        let off = Daemon(), kept = InMemoryCloudPushUnregisterStore()
        let other = try await lostAnswer(off, ids: CloudPushIDs(store: InMemoryKeyValueStore()), store: kept)
        await off.set(put: .down, delete: .down)
        do {
            try await other.unregister(connection: "paired", client: client(off), credentials: signIn)
            XCTFail("a server that could not be told was taken as told")
        } catch {}
        XCTAssertTrue(try kept.all().isEmpty)
    }

    /// A tap that registers, waiting behind a quiet renewal when leaving
    /// begins, registers nothing once the renewal has landed.
    func testATapWaitingBehindARenewalRegistersNothingOnceLeavingBegins() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let gate = CloudPushTests.Gate()
        var source = CloudPushTests.source(relay: CloudPushTests.Relay(CloudPushTests.token), permission: CloudPushTests.Permission(.authorized))
        source.ids = ids
        let push = CloudPush(source: source)
        let daemon = Daemon()
        let held = HeldPut(daemon, gate)
        let slow = AgentClient(transport: held, token: "device-token")
        let renewal = Task { try await push.register(connection: "paired", client: slow, ask: false, cloud: false) }
        try await gate.arrival()
        let tap = Task { try await push.register(connection: "paired", client: slow, ask: true, cloud: false) }
        try await Task.sleep(for: .milliseconds(50))
        let leave = Task { try await push.unregister(connection: "paired", client: slow, credentials: Self.pairing) }
        try await Task.sleep(for: .milliseconds(50))
        await gate.open()
        _ = try await renewal.value
        let tapped = try await tap.value
        try await leave.value
        await push.waitUntilSettled()
        XCTAssertEqual(tapped, .leaving)
        let rows = await daemon.rows, asked = await daemon.asked
        XCTAssertEqual(asked, ["PUT", "DELETE v1"])
        XCTAssertTrue(rows.isEmpty)
    }

    /// The same computer, with its first `PUT` held at `gate`.
    actor HeldPut: AgentTransport {
        let inner: Daemon
        let gate: CloudPushTests.Gate
        private var held = false
        init(_ inner: Daemon, _ gate: CloudPushTests.Gate) { self.inner = inner; self.gate = gate }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            if method == "PUT", !held { held = true; await gate.wait() }
            return try await inner.request(method: method, path: path, credential: credential, body: body, headers: headers)
        }
        func close() {}
    }
}
