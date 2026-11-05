import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// What leaves the phone and when: the envelope, the queue's bounds and
/// retries, the error throttle, the failure dedupe, the daily summary, and
/// opting out.
final class AnalyticsEngineTests: XCTestCase {
    private let common: [String: JSONValue] = [
        "client": .string("ios"), "app_version": .string("2.0.0"), "channel": .string("stable"), "os": .string("ios"),
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
        await engine.record(.chatFailureShown(kind: .usageLimit, providerKind: .claude, pool: false, target: .session, sessionClient: .happyAgent), common: common, at: start)
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
            "kind": .string("usage_limit"), "provider_kind": .string("claude"), "pool": .bool(false),
            "target": .string("session"), "session_client": .string("happy_agent"),
            "$lib": .string("happy-ios"), "$process_person_profile": .bool(false), "$ip": .null, "$geoip_disable": .bool(true),
        ]) { _, new in new })
    }

    func testTheInstallIdIsTheSameOnEveryEventAndNothingElseIdentifies() async throws {
        let http = http()
        let engine = engine(http)
        await engine.record(.onboardingCompleted, common: common, at: start)
        await engine.record(.onboardingStepViewed(step: .pair), common: common, at: start)
        await engine.flush(now: start)
        let ids = try events(http).map { $0["properties"]?["distinct_id"] }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1])
    }

    func testAnUnknownPropertyIsDroppedAndAValueOutsideTheCatalogDropsTheEvent() {
        XCTAssertEqual(AnalyticsSchema.admit("onboarding_step_viewed", ["step": .string("pair"), "path": .string("/Users/kirill")], common: common)?["path"], nil)
        XCTAssertNil(AnalyticsSchema.admit("onboarding_step_viewed", ["step": .string("Kirill's Mac")], common: common))
        XCTAssertNil(AnalyticsSchema.admit("mobile_pairing_failed", [:], common: common), "not an iOS event")
        XCTAssertNil(AnalyticsSchema.admit("onboarding_completed", [:], common: common.merging(["os_version": .string("26.1.2")]) { _, new in new }), "major.minor only")
        XCTAssertNil(AnalyticsSchema.admit("app_opened", ["launch_count": .number(-1), "cold": .bool(true)], common: common))
        XCTAssertNil(AnalyticsSchema.admit("onboarding_completed", [:], common: common.merging(["arch": .string("arm64")]) { _, new in new })?["arch"], "desktop's alone")
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
        await engine.record(.onboardingCompleted, common: common, at: start.addingTimeInterval(-8 * 86_400))
        for index in 0..<501 {
            await engine.record(.appOpened(launchCount: index, cold: true), common: common, at: start)
        }
        await engine.flush(now: start)
        let sent = try events(http)
        XCTAssertEqual(sent.count, 500)
        XCTAssertEqual(sent.first?["properties"]?["launch_count"], .number(1))
        XCTAssertEqual(sent.last?["properties"]?["launch_count"], .number(500))
        XCTAssertFalse(sent.contains { $0["event"] == .string("onboarding_completed") })
    }

    func testAFailedBatchIsSentAgainAsTheSameEvents() async throws {
        let http = FakeHTTP()
        http.on("POST /batch") { _ in throw URLError(.notConnectedToInternet) }
        let engine = engine(http)
        await engine.record(.onboardingCompleted, common: common, at: start)
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
        await engine.record(.onboardingCompleted, common: common, at: start)
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
        let failure = AnalyticsEvent.chatFailureShown(kind: .network, providerKind: nil, pool: true, target: .bot, sessionClient: .happyAgent)
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
        let failure = AnalyticsEvent.chatFailureShown(kind: .other, providerKind: nil, pool: false, target: .session, sessionClient: .cli)
        for index in 0...AnalyticsEngine.seenFailureLimit {
            await engine.recordFailureShown(messageID: "m\(index)", createdAt: start, failure, common: common, at: start)
        }
        let seen = await engine.snapshot.seenFailures
        XCTAssertEqual(seen.count, 500)
        XCTAssertEqual(seen.first, "m1")
    }

    func testTheFirstOpenOfALaterDaySendsTheEarlierDaysSummariesFirst() async throws {
        let http = http()
        let engine = engine(http)
        let config = AnalyticsEvent.DailyConfig(theme: .system, appLanguage: .en, agentsConnected: .one)
        await engine.appOpened(cold: true, common: common, config: config, at: start)
        await engine.count(.conversationsOpened, by: 1, at: start)
        await engine.count(.conversationsOpened, by: 2, at: start.addingTimeInterval(60))
        await engine.count(.filesOpened, by: 1, at: start.addingTimeInterval(60))
        // Used on the 6th too, but with nothing counted.
        await engine.markUsed(at: start.addingTimeInterval(86_400))
        await engine.appOpened(cold: false, common: common, config: config, at: start.addingTimeInterval(2 * 86_400))
        await engine.flush(now: start.addingTimeInterval(2 * 86_400))
        let sent = try events(http)
        XCTAssertEqual(sent.map { $0["event"]?.stringValue }, ["app_opened", "daily_summary", "daily_summary", "app_opened"])
        XCTAssertEqual(sent[1]["timestamp"], .string("2025-11-05T12:00:00.000Z"))
        let first = try XCTUnwrap(sent[1]["properties"]?.objectValue).filter { common[$0.key] == nil && !$0.key.hasPrefix("$") && $0.key != "distinct_id" }
        XCTAssertEqual(first, [
            "day": .number(20_397), "conversations_opened": .number(3), "files_opened": .number(1),
            "theme": .string("system"), "app_language": .string("en"), "agents_connected": .string("1"),
        ])
        XCTAssertEqual(sent[2]["properties"]?["day"], .number(20_398))
        XCTAssertNil(sent[2]["properties"]?["conversations_opened"], "zero counts are left out")
        XCTAssertEqual(sent[3]["properties"]?["launch_count"], .number(1))
        XCTAssertEqual(sent[3]["properties"]?["cold"], .bool(false))
    }

    func testSummariesOlderThanAWeekAreDropped() async throws {
        let http = http()
        let engine = engine(http)
        await engine.count(.searchUsed, by: 1, at: start)
        await engine.appOpened(cold: true, common: common, config: .init(), at: start.addingTimeInterval(8 * 86_400))
        await engine.flush(now: start.addingTimeInterval(8 * 86_400))
        XCTAssertEqual(try events(http).map { $0["event"]?.stringValue }, ["app_opened"])
    }

    func testOptingOutDeletesWhatWasWaitingButKeepsTheInstall() async throws {
        let http = http()
        let engine = engine(http)
        await engine.record(.onboardingCompleted, common: common, at: start)
        await engine.count(.feedOpened, by: 1, at: start)
        let id = await engine.snapshot.installID
        await engine.clear()
        let state = await engine.snapshot
        XCTAssertEqual(state.queue, [])
        XCTAssertEqual(state.days, [:])
        XCTAssertEqual(state.installID, id)
        await engine.flush(now: start)
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testTheQueueSurvivesARelaunch() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("analytics-\(UUID().uuidString)/analytics.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let failing = FakeHTTP()
        failing.on("POST /batch") { _ in throw URLError(.timedOut) }
        let first = engine(failing, file: file)
        await first.record(.onboardingCompleted, common: common, at: start)
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
