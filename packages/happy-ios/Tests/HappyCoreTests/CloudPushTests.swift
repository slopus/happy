import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// This phone's push on Happy Cloud servers: the relay's token for its
/// APNs token, then each server's registration, as onboarding's mobileApp
/// gate and a server's quiet renewal ask for them.
final class CloudPushTests: XCTestCase {
    static let token = "HappyPushToken[3MTQ1KZhQAh5CdD4rY7xRX]"
    static let registration = #"{"registration":{"id":"x","version":"7c1d8a5e-2f43-4c1b-9d0e-1f2a3b4c5d6e","expiresAt":1900000000000}}"#

    func testOnlyAWellFormedRelayTokenIsTaken() {
        XCTAssertEqual(HappyPushToken.parse(Self.token)?.value, Self.token)
        for bad in ["HappyPushToken[short]", "ExponentPushToken[3MTQ1KZhQAh5CdD4rY7xRX]", "HappyPushToken[3MTQ1KZhQAh5CdD4rY7xR!]", ""] {
            XCTAssertNil(HappyPushToken.parse(bad), bad)
        }
        XCTAssertFalse(String(describing: HappyPushToken.parse(Self.token)!).contains("3MTQ"), "the capability is never printed")
    }

    func testTheRelayGetsTheAPNsTokenInHexForThisInstall() async throws {
        let relay = Relay(Self.token)
        let device = CloudPushDevice(appId: "com.ex3ndr.happy", development: true, locale: "en-US")
        let token = try await HappyPushRelay.exchange(apns: Data([0x0a, 0xff]), deviceId: "ABC-1", device: device, transport: relay)
        XCTAssertEqual(token.value, Self.token)
        let request = try XCTUnwrap(relay.requests.first)
        XCTAssertEqual(request.url, HappyPushRelay.url)
        XCTAssertEqual(try JSONValue.decode(request.body ?? Data()), .object([
            "deviceId": .string("abc-1"), "appId": .string("com.ex3ndr.happy"), "platform": .string("ios"), "provider": .string("apns"),
            "pushToken": .string("0aff"), "environment": .string("development"), "metadata": .object(["locale": .string("en-US")]),
        ]))

        let refused = Relay(#"{"error":"echo 0aff"}"#, status: 403)
        do {
            _ = try await HappyPushRelay.exchange(apns: Data([0x0a]), deviceId: "d", device: device, transport: refused)
            XCTFail("a refusal was taken")
        } catch let error as CloudPushError {
            XCTAssertEqual(error, CloudPushError(status: 403), "only the status is kept, never the body")
        }
    }

    func testRegisteringAsksOnlyFromATapAndRenewsAtMostEveryFewHours() async throws {
        let server = ProvidersServer()
        await server.answer("PUT /v0/cloud/push/registrations/\(Self.ids.registration(for: "c1"))", 200, Self.registration)
        let client = AgentClient(transport: server, token: "t")
        let relay = Relay(Self.token)
        let permission = Permission(.notDetermined)
        let push = CloudPush(source: Self.source(relay: relay, permission: permission))
        let now = Date(timeIntervalSince1970: 1_000_000)

        let quiet = try await push.register(connection: "c1", client: client, ask: false, cloud: true, now: now)
        XCTAssertEqual(quiet, .denied, "coming back never shows the system prompt")
        let asked = try await push.register(connection: "c1", client: client, ask: true, cloud: true, now: now)
        XCTAssertEqual(asked, .registered)
        let body = await server.rawBodies.last
        XCTAssertEqual(body, .object(["token": .string(Self.token), "platform": .string("ios"), "appId": .string("com.slopus.happy.dev")]))

        let soon = try await push.register(connection: "c1", client: client, ask: false, cloud: true, now: now.addingTimeInterval(3600))
        XCTAssertEqual(soon, .current)
        let later = try await push.register(connection: "c1", client: client, ask: false, cloud: true, now: now.addingTimeInterval(CloudPush.renewal + 1))
        XCTAssertEqual(later, .registered)
        XCTAssertEqual(relay.requests.count, 1, "the same APNs token is exchanged once")

        await permission.set(.denied)
        let off = try await push.register(connection: "c1", client: client, ask: true, cloud: true, now: now)
        XCTAssertEqual(off, .denied, "turned off in Settings, a tap can't ask again")
    }

    func testSigningOutTakesTheRegistrationOffAndTheNextOneIsNew() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        var source = Self.source(relay: Relay(Self.token), permission: Permission(.authorized))
        source.ids = ids
        let push = CloudPush(source: source)
        let server = ProvidersServer()
        let first = ids.registration(for: "c1")
        await server.answer("PUT /v0/cloud/push/registrations/\(first)", 200, Self.registration)
        await server.answer("DELETE /v0/cloud/push/registrations/\(first)", 204, "")
        let client = AgentClient(transport: server, token: "t")
        _ = try await push.register(connection: "c1", client: client, ask: true, cloud: true)
        XCTAssertEqual(ids.version(for: "c1"), "7c1d8a5e-2f43-4c1b-9d0e-1f2a3b4c5d6e")
        try await push.unregister(connection: "c1", client: client)
        XCTAssertNil(ids.version(for: "c1"))
        XCTAssertNotEqual(ids.registration(for: "c1"), first, "a registration taken off is never renewed")
        // Never registered here: nothing to take off, nothing sent.
        try await push.unregister(connection: "c2", client: AgentClient(transport: ProvidersServer(), token: "t"))
    }

    func testABuildTheRelayRefusesNeverRegisters() async throws {
        var source = Self.source(relay: Relay(Self.token), permission: Permission(.authorized))
        source.device.appId = "com.slopus.happy.chat-harness"
        let outcome = try await CloudPush(source: source).register(connection: "c1", client: AgentClient(transport: ProvidersServer(), token: "t"), ask: true, cloud: true)
        XCTAssertEqual(outcome, .unsupported)
    }

    // MARK: A server of one's own

    private static let health = #"{"ready":true,"capabilities":{"userEnvironment":true,"pushRegistrations":true}}"#

    /// A Happy Agent daemon that serves the routes says so in its health
    /// (`capabilities.pushRegistrations`), and is registered with as a
    /// Happy Cloud server is: the same relay token, the same request.
    func testAServerThatSaysItTakesRegistrationsIsRegisteredWith() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let relay = Relay(Self.token)
        var source = Self.source(relay: relay, permission: Permission(.authorized))
        source.ids = ids
        let push = CloudPush(source: source)
        let server = ProvidersServer()
        await server.answer("GET /v0/health", 200, Self.health)
        await server.answer("PUT /v0/cloud/push/registrations/\(ids.registration(for: "paired"))", 200, Self.registration)
        await server.answer("DELETE /v0/cloud/push/registrations/\(ids.registration(for: "paired"))", 204, "")
        let client = AgentClient(transport: server, token: "t")
        let now = Date(timeIntervalSince1970: 1_000_000)

        let outcome = try await push.register(connection: "paired", client: client, ask: false, cloud: false, now: now)
        XCTAssertEqual(outcome, .registered)
        let body = await server.rawBodies.last
        XCTAssertEqual(body, .object(["token": .string(Self.token), "platform": .string("ios"), "appId": .string("com.slopus.happy.dev")]))
        XCTAssertEqual(ids.version(for: "paired"), "7c1d8a5e-2f43-4c1b-9d0e-1f2a3b4c5d6e")
        let soon = try await push.register(connection: "paired", client: client, ask: false, cloud: false, now: now.addingTimeInterval(3600))
        XCTAssertEqual(soon, .current)
        let later = try await push.register(connection: "paired", client: client, ask: false, cloud: false, now: now.addingTimeInterval(CloudPush.renewal + 1))
        XCTAssertEqual(later, .registered)
        XCTAssertEqual(relay.requests.count, 1)

        // Unpaired from the phone: the registration goes, as on signing out.
        try await push.unregister(connection: "paired", client: client)
        let routes = await server.routes
        XCTAssertEqual(routes.filter { $0.hasPrefix("DELETE ") }.count, 1)
        XCTAssertNil(ids.version(for: "paired"))
    }

    /// An older daemon answers these routes 404 and says nothing of them
    /// in its health: it is asked for nothing, the relay neither, and iOS
    /// is never made to show its prompt for it.
    func testAServerThatDoesNotSayItIsNeverAsked() async throws {
        for health in [#"{"ready":true}"#, #"{"ready":true,"capabilities":{"userEnvironment":true}}"#, #"{"ready":true,"capabilities":{"pushRegistrations":false}}"#,
                       #"{"ready":true,"capabilities":{"pushRegistrations":"yes"}}"#] {
            let relay = Relay(Self.token)
            let permission = Permission(.notDetermined)
            let push = CloudPush(source: Self.source(relay: relay, permission: permission))
            let server = ProvidersServer()
            await server.answer("GET /v0/health", 200, health)
            let client = AgentClient(transport: server, token: "t")
            for ask in [false, true] {
                let outcome = try await push.register(connection: "paired", client: client, ask: ask, cloud: false)
                XCTAssertEqual(outcome, .unserved, health)
            }
            let routes = await server.routes
            XCTAssertEqual(Set(routes), ["GET /v0/health"], health)
            XCTAssertTrue(relay.requests.isEmpty, health)
            let asked = await permission.asked
            XCTAssertEqual(asked, 0, health)
        }
    }

    /// A Happy Cloud server registers whatever its health says: it does
    /// not advertise the routes it has always had.
    func testAHappyCloudServerIsNotAskedWhatItServes() async throws {
        let server = ProvidersServer()
        await server.answer("PUT /v0/cloud/push/registrations/\(Self.ids.registration(for: "cloud"))", 200, Self.registration)
        let push = CloudPush(source: Self.source(relay: Relay(Self.token), permission: Permission(.authorized)))
        let outcome = try await push.register(connection: "cloud", client: AgentClient(transport: server, token: "t"), ask: false, cloud: true)
        XCTAssertEqual(outcome, .registered)
        let routes = await server.routes
        XCTAssertEqual(routes, ["PUT /v0/cloud/push/registrations/\(Self.ids.registration(for: "cloud"))"])
    }

    /// A computer has no onboarding to ask from, so reaching it the first
    /// time shows iOS's prompt, which iOS shows once. A Happy Cloud server
    /// asks from its onboarding step only.
    func testAServerOfOnesOwnAsksTheFirstTimeItIsReached() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let permission = Permission(.notDetermined)
        var source = Self.source(relay: Relay(Self.token), permission: permission)
        source.ids = ids
        let push = CloudPush(source: source)
        let server = ProvidersServer()
        await server.answer("GET /v0/health", 200, Self.health)
        await server.answer("PUT /v0/cloud/push/registrations/\(ids.registration(for: "paired"))", 200, Self.registration)
        await server.answer("PUT /v0/cloud/push/registrations/\(ids.registration(for: "cloud"))", 200, Self.registration)
        let client = AgentClient(transport: server, token: "t")

        let cloud = try await push.register(connection: "cloud", client: client, ask: false, cloud: true)
        XCTAssertEqual(cloud, .denied)
        var asked = await permission.asked
        XCTAssertEqual(asked, 0, "a Happy Cloud server showed the prompt without a tap")

        let first = try await push.register(connection: "paired", client: client, ask: false, cloud: false)
        XCTAssertEqual(first, .registered)
        asked = await permission.asked
        XCTAssertEqual(asked, 1)

        await permission.set(.denied)
        let refused = try await push.register(connection: "paired", client: client, ask: false, cloud: false, now: Date().addingTimeInterval(CloudPush.renewal + 1))
        XCTAssertEqual(refused, .denied)
        asked = await permission.asked
        XCTAssertEqual(asked, 1, "turned off in Settings, it is never asked again")
    }

    // MARK: One registration at a time

    private static let newer = #"{"registration":{"id":"x","version":"9e2b7c40-5a61-4d3f-8b1a-6c7d8e9f0a1b","expiresAt":1900000000000}}"#

    /// A connection that comes up says so more than once at the same
    /// moment (`Session.reconnected`). Each registration the server takes
    /// has a new version, and only the latest can take it off again: two
    /// sent at once could leave the phone holding the older, and the
    /// registration on the server for good. One is sent.
    func testTwoRenewalsAtOnceRegisterOnce() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let gate = Gate()
        var source = Self.source(relay: Relay(Self.token), permission: Permission(.authorized))
        source.ids = ids
        source.apnsToken = { await gate.wait(); return Data([1, 2, 3]) }
        let push = CloudPush(source: source)
        let server = ProvidersServer()
        let route = "PUT /v0/cloud/push/registrations/\(ids.registration(for: "paired"))"
        await server.answer("GET /v0/health", 200, Self.health)
        await server.answer(route, 200, Self.registration, then: Self.newer)
        let client = AgentClient(transport: server, token: "t")

        let first = Task { try await push.register(connection: "paired", client: client, ask: false, cloud: false) }
        try await gate.arrival()
        let second = Task { try await push.register(connection: "paired", client: client, ask: false, cloud: false) }
        try await Task.sleep(for: .milliseconds(100))
        await gate.open()
        let outcomes = [try await first.value, try await second.value]
        XCTAssertEqual(outcomes, [.registered, .registered])
        let routes = await server.routes
        XCTAssertEqual(routes.filter { $0 == route }.count, 1)
        XCTAssertEqual(ids.version(for: "paired"), "7c1d8a5e-2f43-4c1b-9d0e-1f2a3b4c5d6e")
    }

    /// Unpaired while a registration is on its way: that one lands first,
    /// and it is the one taken off. Nothing of the phone stays behind.
    func testLeavingWhileRegisteringTakesThatRegistrationOff() async throws {
        let ids = CloudPushIDs(store: InMemoryKeyValueStore())
        let gate = Gate()
        var source = Self.source(relay: Relay(Self.token), permission: Permission(.authorized))
        source.ids = ids
        source.apnsToken = { await gate.wait(); return Data([1, 2, 3]) }
        let push = CloudPush(source: source)
        let server = ProvidersServer()
        let registration = ids.registration(for: "paired")
        await server.answer("GET /v0/health", 200, Self.health)
        await server.answer("PUT /v0/cloud/push/registrations/\(registration)", 200, Self.registration)
        await server.answer("DELETE /v0/cloud/push/registrations/\(registration)", 204, "")
        let client = AgentClient(transport: server, token: "t")

        let registering = Task { try await push.register(connection: "paired", client: client, ask: false, cloud: false) }
        try await gate.arrival()
        let leaving = Task { try await push.unregister(connection: "paired", client: client) }
        try await Task.sleep(for: .milliseconds(100))
        await gate.open()
        _ = try await registering.value
        try await leaving.value
        let routes = await server.routes
        XCTAssertEqual(routes.filter { $0 != "GET /v0/health" }, ["PUT /v0/cloud/push/registrations/\(registration)", "DELETE /v0/cloud/push/registrations/\(registration)"])
        XCTAssertNil(ids.version(for: "paired"))
    }

    /// Holds whoever waits at it until it is opened.
    actor Gate {
        private var waiting: [CheckedContinuation<Void, Never>] = []
        func wait() async { await withCheckedContinuation { waiting.append($0) } }
        func open() {
            let held = waiting
            waiting = []
            for continuation in held { continuation.resume() }
        }
        /// Once someone waits at it.
        func arrival() async throws {
            for _ in 0..<200 where waiting.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        }
    }

    func testIdsAreMadeOnceAndKept() {
        let store = InMemoryKeyValueStore()
        let ids = CloudPushIDs(store: store)
        XCTAssertEqual(ids.device, ids.device)
        XCTAssertEqual(ids.registration(for: "a"), CloudPushIDs(store: store).registration(for: "a"))
        XCTAssertNotEqual(ids.registration(for: "a"), ids.registration(for: "b"))
        XCTAssertEqual(ids.registration(for: "a"), ids.registration(for: "a").lowercased(), "the server takes lowercase UUIDs only")
    }

    static let ids = CloudPushIDs(store: InMemoryKeyValueStore())

    static func source(relay: Relay, permission: Permission) -> CloudPush.Source {
        CloudPush.Source(device: CloudPushDevice(appId: "com.slopus.happy.dev", development: false), ids: ids, transport: relay,
                         permission: { await permission.current() }, requestPermission: { await permission.request() },
                         apnsToken: { Data([1, 2, 3]) })
    }

    final class Relay: HTTPTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var sent: [HTTPRequest] = []
        private let body: String
        private let status: Int

        init(_ tokenOrBody: String, status: Int = 200) {
            body = status == 200 ? #"{"token":"\#(tokenOrBody)"}"# : tokenOrBody
            self.status = status
        }

        var requests: [HTTPRequest] { lock.withLock { sent } }

        func send(_ request: HTTPRequest) async throws -> HTTPResponse {
            lock.withLock { sent.append(request) }
            return HTTPResponse(status: status, body: Data(body.utf8))
        }
    }

    actor Permission {
        private var system: PushPermission.SystemStatus
        init(_ system: PushPermission.SystemStatus) { self.system = system }
        func set(_ system: PushPermission.SystemStatus) { self.system = system }
        func current() -> PushPermission { PushPermission(system: system) }
        /// How many times the system prompt was asked for.
        private(set) var asked = 0
        func request() -> PushPermission {
            asked += 1
            if system == .notDetermined { system = .authorized }
            return current()
        }
    }
}
