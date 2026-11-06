import Foundation
import XCTest
@testable import HappyAnalytics
@testable import HappyCore
import HappyStore
import HappyWire

/// What leaves the phone and when: the envelope, the queue's bounds and
/// retries, the error throttle, the failure dedupe, the install id, and
/// opting out.
final class AnalyticsEngineTests: XCTestCase {
    private let common: [String: JSONValue] = [
        "client": .string("ios"), "app_version": .string("2.0.0"), "flavor": .string("standard"), "os": .string("ios"),
        "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .null, "agent_os": .null,
        "happy_agent_version": .null,
    ]
    private let start = Date(timeIntervalSince1970: 1_762_344_000) // 2025-11-05 12:00 UTC

    private func engine(_ http: HTTPTransport, storage: KeyValueStore = InMemoryKeyValueStore()) -> AnalyticsEngine {
        AnalyticsEngine(destination: .init(apiKey: "phc_test"), transport: http, storage: storage)
    }

    private func http(_ status: Int = 200) -> FakeHTTP {
        let http = FakeHTTP()
        http.on("POST /batch") { _ in (status, Data("{}".utf8)) }
        return http
    }

    /// Every batch posted, decoded.
    private func batches(_ http: FakeHTTP) throws -> [JSONValue] {
        try http.requests("POST /batch").map { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap($0.body)) }
    }

    private func events(_ http: FakeHTTP) throws -> [JSONValue] {
        try batches(http).flatMap { $0["batch"]?.arrayValue ?? [] }
    }

    func testABatchCarriesExactlyTheCatalogsPropertiesAndPostHogsPrivacyFields() async throws {
        let http = http()
        let engine = engine(http)
        // Recorded with a fraction of a second: sent in whole seconds.
        await engine.record(.chatFailureShown(kind: .usageLimit, providerKind: .claude, isPool: false, target: .session, sessionClient: .happyAgent),
                            common: common, at: start.addingTimeInterval(0.734))
        await engine.flush(now: start)

        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://us.i.posthog.com/batch/")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        let body = try XCTUnwrap(batches(http).first)
        XCTAssertEqual(body["api_key"], .string("phc_test"))
        let event = try XCTUnwrap(body["batch"]?.arrayValue?.first)
        XCTAssertEqual(event["event"], .string("chat_failure_shown"))
        XCTAssertEqual(event["timestamp"], .string("2025-11-05T12:00:00Z"))
        var properties = try XCTUnwrap(event["properties"]?.objectValue)
        let distinct = try XCTUnwrap(properties.removeValue(forKey: "distinct_id")?.stringValue)
        let insert = try XCTUnwrap(properties.removeValue(forKey: "$insert_id")?.stringValue)
        XCTAssertNotNil(UUID(uuidString: distinct))
        XCTAssertNotNil(UUID(uuidString: insert))
        XCTAssertNotEqual(distinct, insert)
        XCTAssertEqual(properties, common.merging([
            "kind": .string("usage_limit"), "provider_kind": .string("claude"), "is_pool": .bool(false),
            "target": .string("session"), "session_client": .string("happy_agent"),
            "$lib": .string("happy-ios"), "$process_person_profile": .bool(false), "$ip": .null, "$geoip_disable": .bool(true),
        ]) { _, new in new })
    }

    /// The install id is the same on every event, and the one thing stored.
    func testTheInstallIdIsTheSameOnEveryEventAndTheOnlyThingStored() async throws {
        let http = http()
        let storage = InMemoryKeyValueStore()
        let engine = engine(http, storage: storage)
        await engine.record(.teamServerSignedIn, common: common, at: start)
        await engine.record(.paywallPresented(product: .pro), common: common, at: start)
        await engine.flush(now: start)
        let ids = try events(http).map { $0["properties"]?["distinct_id"] }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1])
        XCTAssertEqual(ids[0], storage.string(forKey: AnalyticsEngine.installKey).map(JSONValue.string))
        let next = await self.engine(http, storage: storage).installID
        XCTAssertEqual(next.map(JSONValue.string), ids[0], "the same install after a relaunch")
    }

    /// Only a random UUID is the install: anything else stored is replaced.
    func testAStoredInstallIDThatIsNotAUUIDIsReplaced() async {
        let storage = InMemoryKeyValueStore()
        storage.set("anon-account-id", forKey: AnalyticsEngine.installKey)
        let id = await engine(http(), storage: storage).installID
        XCTAssertNotNil(id.flatMap(UUID.init(uuidString:)))
        XCTAssertEqual(storage.string(forKey: AnalyticsEngine.installKey), id)
    }

    func testAnUnknownPropertyIsDroppedAndAValueOutsideTheCatalogDropsTheEvent() {
        XCTAssertEqual(AnalyticsSchema.admit("paywall_presented", ["product": .string("pro"), "path": .string("/Users/kirill")], common: common)?["path"], nil)
        XCTAssertNil(AnalyticsSchema.admit("paywall_presented", ["product": .string("Kirill's Mac")], common: common))
        XCTAssertNil(AnalyticsSchema.admit("onboarding_completed", [:], common: common), "desktop's alone now")
        XCTAssertNil(AnalyticsSchema.admit("account_created", [:], common: common), "dropped in v5")
        XCTAssertNil(AnalyticsSchema.admit("team_server_signed_in", [:], common: common.merging(["os_version": .string("26.1.2")]) { _, new in new }), "major.minor only")
        XCTAssertNil(AnalyticsSchema.admit("team_server_signed_in", [:], common: common.merging(["app_version": .string("2.0.0-beta")]) { _, new in new }), "numbers only")
        XCTAssertNil(AnalyticsSchema.admit("app_opened", ["is_cold_start": .bool(true), "launch_count": .number(3)], common: common)?["launch_count"], "dropped in v5")
        XCTAssertNil(AnalyticsSchema.admit("message_sent", ["source": .string("chat"), "has_attachment": .bool(false), "is_steering": .bool(false),
                                                            "model_family": .string("anthropic/opus-5-5")], common: common), "a family, never an id")
        XCTAssertNil(AnalyticsSchema.admit("team_server_signed_in", [:], common: common.merging(["arch": .string("arm64")]) { _, new in new })?["arch"], "desktop's alone")
    }

    func testTheQueueKeepsTheNewest500AndNothingOlderThanAWeek() async throws {
        let http = http()
        let engine = engine(http)
        await engine.record(.teamServerSignedIn, common: common, at: start.addingTimeInterval(-8 * 86_400))
        for index in 0..<501 {
            await engine.record(.appOpened(isColdStart: index % 2 == 0, config: .init()), common: common, at: start)
        }
        await engine.flush(now: start)
        let sent = try events(http)
        XCTAssertEqual(sent.count, 500)
        XCTAssertEqual(sent.first?["properties"]?["is_cold_start"], .bool(false), "the first one went")
        XCTAssertFalse(sent.contains { $0["event"] == .string("team_server_signed_in") })
    }

    func testAFailedBatchIsSentAgainAsTheSameEvents() async throws {
        let http = FakeHTTP()
        http.on("POST /batch") { _ in throw URLError(.notConnectedToInternet) }
        let engine = engine(http)
        await engine.record(.teamServerSignedIn, common: common, at: start)
        await engine.flush(now: start)
        http.on("POST /batch") { _ in (503, Data()) }
        await engine.flush(now: start)
        http.on("POST /batch") { _ in (200, Data()) }
        await engine.flush(now: start)
        await engine.flush(now: start)
        let attempts = http.requests("POST /batch")
        XCTAssertEqual(attempts.count, 3, "the empty queue sends nothing")
        let ids = try attempts.map { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap($0.body))["batch"]?.arrayValue?.first?["properties"]?["$insert_id"] }
        XCTAssertEqual(Set(ids.compactMap { $0 }).count, 1)
    }

    func testARefusedBatchIsDroppedNotRetriedForever() async throws {
        let http = http(400)
        let engine = engine(http)
        await engine.record(.teamServerSignedIn, common: common, at: start)
        await engine.flush(now: start)
        await engine.flush(now: start)
        XCTAssertEqual(http.requests.count, 1)
    }

    func testErrorsAreThrottledPerAreaAndCodeAndRepeatsDropped() async throws {
        let http = http()
        let engine = engine(http)
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start)
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(60))
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(300))
        await engine.recordError(area: .messageSend, code: .timeout, common: common, at: start.addingTimeInterval(301))
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(601))
        await engine.flush(now: start.addingTimeInterval(601))
        let sent = try events(http).map { $0["properties"]?["code"] }
        XCTAssertEqual(sent, [.string("offline"), .string("timeout"), .string("offline")])
        XCTAssertNil(try events(http).first?["properties"]?["repeat_count"])
    }

    /// One failed conversation load seen twice in the same moment (when it
    /// opens and on the resync after) is one `error_shown`, with the most
    /// specific code either saw; a later failure is its own.
    func testOneFailureSeenTwiceAtOnceIsOneErrorWithItsMostSpecificCode() async throws {
        let http = http()
        let engine = engine(http)
        await engine.recordError(area: .conversationLoad, code: .offline, common: common, at: start)
        await engine.recordError(area: .conversationLoad, code: .unknown, common: common, at: start.addingTimeInterval(0.4))
        await engine.recordError(area: .messageSend, code: .unknown, common: common, at: start.addingTimeInterval(1))
        await engine.recordError(area: .messageSend, code: .timeout, common: common, at: start.addingTimeInterval(2))
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(3))
        await engine.recordError(area: .conversationLoad, code: .unknown, common: common, at: start.addingTimeInterval(20))
        await engine.flush(now: start.addingTimeInterval(20))
        let sent = try events(http).map { [$0["properties"]?["area"], $0["properties"]?["code"]] }
        XCTAssertEqual(sent, [
            [.string("conversation_load"), .string("offline")],
            [.string("message_send"), .string("timeout")],
            [.string("conversation_load"), .string("unknown")],
        ])
    }

    func testAFailureCardCountsOnceAndOnlyWhileItIsNews() async throws {
        let http = http()
        let engine = engine(http)
        let failure = AnalyticsEvent.chatFailureShown(kind: .network, providerKind: nil, isPool: true, target: .bot, sessionClient: .happyAgent)
        await engine.recordFailureShown(messageID: "m1", createdAt: start.addingTimeInterval(-60), failure, common: common, at: start)
        await engine.recordFailureShown(messageID: "m1", createdAt: start.addingTimeInterval(-60), failure, common: common, at: start.addingTimeInterval(5))
        await engine.recordFailureShown(messageID: "old", createdAt: start.addingTimeInterval(-301), failure, common: common, at: start)
        await engine.flush(now: start)
        XCTAssertEqual(try events(http).count, 1)
        let seen = await engine.seenFailures
        XCTAssertEqual(seen, ["m1"])
    }

    func testTheSeenFailuresAreBounded() async {
        let engine = engine(http())
        let failure = AnalyticsEvent.chatFailureShown(kind: .other, providerKind: nil, isPool: false, target: .session, sessionClient: .cli)
        for index in 0...AnalyticsEngine.seenFailureLimit {
            await engine.recordFailureShown(messageID: "m\(index)", createdAt: start, failure, common: common, at: start)
        }
        let seen = await engine.seenFailures
        XCTAssertEqual(seen.count, 500)
        XCTAssertEqual(seen.first, "m1")
    }

    /// Opting out deletes everything, the install id included; nothing is
    /// recorded or sent until it resumes, and then under a new install id.
    func testOptingOutDeletesEverythingAndOptingInIsANewInstall() async throws {
        let http = http()
        let storage = InMemoryKeyValueStore()
        let engine = engine(http, storage: storage)
        await engine.record(.teamServerSignedIn, common: common, at: start)
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start)
        let id = await engine.installID
        await engine.clear()
        let queue = await engine.queue
        XCTAssertEqual(queue, [])
        XCTAssertNil(storage.string(forKey: AnalyticsEngine.installKey))
        let whileOff = await engine.installID
        XCTAssertNil(whileOff, "no id is made while it is off")
        await engine.record(.paywallPresented(product: .pro), common: common, at: start)
        await engine.flush(now: start)
        XCTAssertTrue(http.requests.isEmpty, "nothing recorded or sent until it resumes")

        await engine.resume()
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(1))
        await engine.flush(now: start)
        let sent = try events(http)
        XCTAssertEqual(sent.map { $0["event"]?.stringValue }, ["error_shown"], "the throttle went too")
        let fresh = try XCTUnwrap(sent.first?["properties"]?["distinct_id"]?.stringValue)
        XCTAssertNotEqual(fresh, id)
        XCTAssertEqual(storage.string(forKey: AnalyticsEngine.installKey), fresh)
    }

    /// Cleared while a batch is on its way: the clear doesn't wait for it,
    /// and a failed answer brings nothing back for a retry.
    func testAClearDoesNotWaitForARequestOnItsWay() async throws {
        let gated = GatedHTTP(status: 503)
        let engine = engine(gated)
        await engine.record(.teamServerSignedIn, common: common, at: start)
        let at = start
        let flushing = Task { await engine.flush(now: at) }
        await gated.started(1)
        await engine.clear()
        let cleared = await engine.queue
        XCTAssertEqual(cleared, [], "cleared while the request is still out")
        gated.release()
        await flushing.value
        let after = await engine.queue
        XCTAssertEqual(after, [], "the failed batch came back to nothing")
        await engine.resume()
        await engine.flush(now: start)
        XCTAssertEqual(gated.requests.count, 1)
    }

    /// A signed-in account that isn't open has its opt-out read from its
    /// store's file, with this device's unsent change on top.
    func testAClosedAccountsStoredOptOutIsReadFromItsFile() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("store-\(UUID().uuidString)/store.sqlite")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = try LocalStore.open(at: url)
        let before = try await LocalStore.settingsSnapshot(at: url)
        XCTAssertFalse(AccountSettings(before).analyticsOptOut)
        try store.addPendingSettings(["analyticsOptOut": .bool(true)])
        let after = try await LocalStore.settingsSnapshot(at: url)
        XCTAssertTrue(AccountSettings(after).analyticsOptOut)
    }
}
