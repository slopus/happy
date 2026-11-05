import Foundation
import XCTest
@testable import HappyAnalytics
@testable import HappyCore
import HappyStore
import HappyWire

/// What leaves the phone and when: the envelope, the queue's bounds and
/// retries, the error throttle, the failure dedupe, `app_opened`'s
/// snapshot, and opting out.
final class AnalyticsEngineTests: XCTestCase {
    private let common: [String: JSONValue] = [
        "client": .string("ios"), "app_version": .string("2.0.0"), "flavor": .string("standard"), "os": .string("ios"),
        "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .null, "agent_os": .null,
        "happy_agent_version": .null,
    ]
    private let start = Date(timeIntervalSince1970: 1_762_344_000) // 2025-11-05 12:00 UTC

    private func engine(_ http: FakeHTTP, file: URL? = nil) -> AnalyticsEngine {
        AnalyticsEngine(destination: .init(apiKey: "phc_test"), file: file, transport: http)
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
        await engine.record(.chatFailureShown(kind: .usageLimit, providerKind: .claude, isPool: false, target: .session, sessionClient: .happyAgent), common: common, at: start)
        await engine.flush(now: start)

        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://us.i.posthog.com/batch/")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        let body = try XCTUnwrap(batches(http).first)
        XCTAssertEqual(body["api_key"], .string("phc_test"))
        let event = try XCTUnwrap(body["batch"]?.arrayValue?.first)
        XCTAssertEqual(event["event"], .string("chat_failure_shown"))
        XCTAssertEqual(event["timestamp"], .string("2025-11-05T12:00:00.000Z"))
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

    func testTheInstallIdIsTheSameOnEveryEventAndNothingElseIdentifies() async throws {
        let http = http()
        let engine = engine(http)
        await engine.record(.accountCreated, common: common, at: start)
        await engine.record(.paywallPresented(product: .pro), common: common, at: start)
        await engine.flush(now: start)
        let ids = try events(http).map { $0["properties"]?["distinct_id"] }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1])
    }

    func testAnUnknownPropertyIsDroppedAndAValueOutsideTheCatalogDropsTheEvent() {
        XCTAssertEqual(AnalyticsSchema.admit("paywall_presented", ["product": .string("pro"), "path": .string("/Users/kirill")], common: common)?["path"], nil)
        XCTAssertNil(AnalyticsSchema.admit("paywall_presented", ["product": .string("Kirill's Mac")], common: common))
        XCTAssertNil(AnalyticsSchema.admit("onboarding_completed", [:], common: common), "desktop's alone now")
        XCTAssertNil(AnalyticsSchema.admit("run_stopped", [:], common: common), "dropped in v4")
        XCTAssertNil(AnalyticsSchema.admit("account_created", [:], common: common.merging(["os_version": .string("26.1.2")]) { _, new in new }), "major.minor only")
        XCTAssertNil(AnalyticsSchema.admit("app_opened", ["launch_count": .number(-1), "is_cold_start": .bool(true)], common: common))
        XCTAssertNil(AnalyticsSchema.admit("app_opened", ["launch_count": .number(1), "is_cold_start": .bool(true), "theme": .string("dark")], common: common)?["theme"],
                     "the theme is no longer sent")
        XCTAssertNil(AnalyticsSchema.admit("account_created", [:], common: common.merging(["arch": .string("arm64")]) { _, new in new })?["arch"], "desktop's alone")
    }

    func testModelsAreFirstPartyVendorIdsOrOther() {
        XCTAssertEqual(AnalyticsSchema.model("anthropic/claude-opus-4-5"), "anthropic/claude-opus-4-5")
        XCTAssertEqual(AnalyticsSchema.model("claude_work:openai/gpt-5.1-codex"), "openai/gpt-5.1-codex")
        XCTAssertEqual(AnalyticsSchema.model("claude-opus-4-5"), "other")
        XCTAssertEqual(AnalyticsSchema.model("acme/secret-project-model"), "other")
        XCTAssertEqual(AnalyticsSchema.model("Anthropic/Claude"), "other")
    }

    func testTheQueueKeepsTheNewest500AndNothingOlderThanAWeek() async throws {
        let http = http()
        let engine = engine(http)
        await engine.record(.accountCreated, common: common, at: start.addingTimeInterval(-8 * 86_400))
        for index in 0..<501 {
            await engine.record(.appOpened(launchCount: index, isColdStart: true, config: .init()), common: common, at: start)
        }
        await engine.flush(now: start)
        let sent = try events(http)
        XCTAssertEqual(sent.count, 500)
        XCTAssertEqual(sent.first?["properties"]?["launch_count"], .number(1))
        XCTAssertEqual(sent.last?["properties"]?["launch_count"], .number(500))
        XCTAssertFalse(sent.contains { $0["event"] == .string("account_created") })
    }

    func testAFailedBatchIsSentAgainAsTheSameEvents() async throws {
        let http = FakeHTTP()
        http.on("POST /batch") { _ in throw URLError(.notConnectedToInternet) }
        let engine = engine(http)
        await engine.record(.accountCreated, common: common, at: start)
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
        await engine.record(.accountCreated, common: common, at: start)
        await engine.flush(now: start)
        await engine.flush(now: start)
        XCTAssertEqual(http.requests.count, 1)
    }

    func testErrorsAreThrottledPerAreaAndCodeWithTheHeldBackOnesCounted() async throws {
        let http = http()
        let engine = engine(http)
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start)
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(60))
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(300))
        await engine.recordError(area: .messageSend, code: .timeout, common: common, at: start.addingTimeInterval(301))
        await engine.recordError(area: .messageSend, code: .offline, common: common, at: start.addingTimeInterval(601))
        await engine.flush(now: start.addingTimeInterval(601))
        let sent = try events(http).map { [$0["properties"]?["code"], $0["properties"]?["repeat_count"]] }
        XCTAssertEqual(sent, [
            [.string("offline"), .number(0)],
            [.string("timeout"), .number(0)],
            [.string("offline"), .number(2)],
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
        let seen = await engine.snapshot.seenFailures
        XCTAssertEqual(seen, ["m1"])
    }

    func testTheSeenFailuresAreBounded() async {
        let engine = engine(http())
        let failure = AnalyticsEvent.chatFailureShown(kind: .other, providerKind: nil, isPool: false, target: .session, sessionClient: .cli)
        for index in 0...AnalyticsEngine.seenFailureLimit {
            await engine.recordFailureShown(messageID: "m\(index)", createdAt: start, failure, common: common, at: start)
        }
        let seen = await engine.snapshot.seenFailures
        XCTAssertEqual(seen.count, 500)
        XCTAssertEqual(seen.first, "m1")
    }

    func testAppOpenedCarriesTheSnapshotAndCountsColdStarts() async throws {
        let http = http()
        let engine = engine(http)
        let config = AnalyticsEvent.AppConfig(appLanguage: .en, notifications: .denied, agentsConnected: .one)
        await engine.appOpened(cold: true, common: common, config: config, at: start)
        await engine.appOpened(cold: false, common: common, config: .init(), at: start.addingTimeInterval(3_600))
        await engine.appOpened(cold: true, common: common, config: .init(), at: start.addingTimeInterval(7_200))
        await engine.flush(now: start.addingTimeInterval(7_200))
        let sent = try events(http).map { try XCTUnwrap($0["properties"]?.objectValue).filter { common[$0.key] == nil && !$0.key.hasPrefix("$") && $0.key != "distinct_id" } }
        XCTAssertEqual(sent, [
            ["launch_count": .number(1), "is_cold_start": .bool(true), "app_language": .string("en"),
             "notifications": .string("denied"), "agents_connected": .string("1")],
            ["launch_count": .number(1), "is_cold_start": .bool(false)],
            ["launch_count": .number(2), "is_cold_start": .bool(true)],
        ])
    }

    func testOptingOutDeletesWhatWasWaitingButKeepsTheInstall() async throws {
        let http = http()
        let engine = engine(http)
        await engine.record(.accountCreated, common: common, at: start)
        let id = await engine.snapshot.installID
        await engine.clear()
        let state = await engine.snapshot
        XCTAssertEqual(state.queue, [])
        XCTAssertEqual(state.installID, id)
        await engine.flush(now: start)
        XCTAssertTrue(http.requests.isEmpty)
    }

    /// A queue file from an older build goes through today's allowlist
    /// before it is sent: an event the catalog dropped (v3's `run_stopped`) goes, a property it
    /// doesn't know is left out, a malformed `$insert_id` drops its event,
    /// and the privacy envelope is made again.
    func testAReplayedQueueIsCheckedAgainstTodaysCatalog() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("analytics-\(UUID().uuidString)/analytics.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let failing = FakeHTTP()
        failing.on("POST /batch") { _ in throw URLError(.timedOut) }
        let first = engine(failing, file: file)
        await first.record(.accountCreated, common: common, at: start)
        await first.flush(now: start)
        await first.saveNow()

        var state = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
        var queue = try XCTUnwrap(state["queue"]?.arrayValue)
        var kept = try XCTUnwrap(queue.first?.objectValue)
        var properties = try XCTUnwrap(kept["properties"]?.objectValue)
        properties["note"] = .string("hello from v1")
        properties["$ip"] = .string("203.0.113.9")
        properties["$process_person_profile"] = .bool(true)
        kept["properties"] = .object(properties)
        var summary = kept
        summary["event"] = .string("run_stopped")
        var summaryProperties = properties
        summaryProperties["day"] = .number(20_397)
        summaryProperties["$insert_id"] = .string(UUID().uuidString.lowercased())
        summary["properties"] = .object(summaryProperties)
        var forged = kept
        var forgedProperties = properties
        forgedProperties["$insert_id"] = .string("not-a-uuid")
        forged["properties"] = .object(forgedProperties)
        queue = [.object(kept), .object(summary), .object(forged)]
        guard case .object(var object) = state else { return XCTFail("state") }
        object["queue"] = .array(queue)
        state = .object(object)
        try JSONEncoder().encode(state).write(to: file)

        let http = http()
        let second = engine(http, file: file)
        await second.flush(now: start)
        let sent = try events(http)
        XCTAssertEqual(sent.map { $0["event"]?.stringValue }, ["account_created"])
        let sentProperties = try XCTUnwrap(sent.first?["properties"]?.objectValue)
        XCTAssertNil(sentProperties["note"])
        XCTAssertEqual(sentProperties["$ip"], .null)
        XCTAssertEqual(sentProperties["$process_person_profile"], .bool(false))
        XCTAssertEqual(sentProperties["$insert_id"], properties["$insert_id"])
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

    func testTheQueueSurvivesARelaunch() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("analytics-\(UUID().uuidString)/analytics.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let failing = FakeHTTP()
        failing.on("POST /batch") { _ in throw URLError(.timedOut) }
        let first = engine(failing, file: file)
        await first.record(.accountCreated, common: common, at: start)
        await first.flush(now: start)
        await first.saveNow()
        let queued = await first.snapshot.queue

        let http = http()
        let second = engine(http, file: file)
        await second.flush(now: start)
        let sent = try events(http)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["properties"]?["$insert_id"]?.stringValue, queued.first?.insertID)
    }
}
