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

        let quiet = try await push.register(connection: "c1", client: client, ask: false, now: now)
        XCTAssertEqual(quiet, .denied, "coming back never shows the system prompt")
        let asked = try await push.register(connection: "c1", client: client, ask: true, now: now)
        XCTAssertEqual(asked, .registered)
        let body = await server.rawBodies.last
        XCTAssertEqual(body, .object(["token": .string(Self.token), "platform": .string("ios"), "appId": .string("com.slopus.happy.dev")]))

        let soon = try await push.register(connection: "c1", client: client, ask: false, now: now.addingTimeInterval(3600))
        XCTAssertEqual(soon, .current)
        let later = try await push.register(connection: "c1", client: client, ask: false, now: now.addingTimeInterval(CloudPush.renewal + 1))
        XCTAssertEqual(later, .registered)
        XCTAssertEqual(relay.requests.count, 1, "the same APNs token is exchanged once")

        await permission.set(.denied)
        let off = try await push.register(connection: "c1", client: client, ask: true, now: now)
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
        _ = try await push.register(connection: "c1", client: client, ask: true)
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
        let outcome = try await CloudPush(source: source).register(connection: "c1", client: AgentClient(transport: ProvidersServer(), token: "t"), ask: true)
        XCTAssertEqual(outcome, .unsupported)
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
        func request() -> PushPermission {
            if system == .notDetermined { system = .authorized }
            return current()
        }
    }
}
