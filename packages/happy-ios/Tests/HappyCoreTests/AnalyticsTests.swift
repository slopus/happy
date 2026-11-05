import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The app's side of analytics: which builds send at all, opting out,
/// `app_opened`'s rule, the common properties, connection incidents and
/// crash reasons.
@MainActor
final class AnalyticsTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_762_344_000)

    private func started(_ http: FakeHTTP, consent: AnalyticsConsent = AnalyticsConsent(storage: InMemoryKeyValueStore())) -> Analytics {
        let analytics = Analytics()
        analytics.now = { [unowned self] in clock }
        analytics.start(.init(destination: .init(apiKey: "phc_test"), file: nil, transport: http, variant: .production,
                              appVersion: "2.0.0", osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 3),
                              deviceClass: .phone), consent: consent)
        return analytics
    }

    private func http() -> FakeHTTP {
        let http = FakeHTTP()
        http.on("POST /batch") { _ in (200, Data()) }
        return http
    }

    private func sent(_ analytics: Analytics, _ http: FakeHTTP) async throws -> [JSONValue] {
        analytics.appEnteredBackground()
        await analytics.settle()
        return try http.requests("POST /batch").flatMap { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap($0.body))["batch"]?.arrayValue ?? [] }
    }

    func testOnlyAReleaseBuildWithAKeyOrADebugRunGivenACaptureEndpointSends() async {
        XCTAssertEqual(Analytics.destination(apiKey: "phc_x", debug: false, automated: false, environment: [:])?.url.absoluteString, "https://us.i.posthog.com/batch/")
        XCTAssertNil(Analytics.destination(apiKey: nil, debug: false, automated: false, environment: [:]), "no key")
        XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: true, automated: false, environment: [:]), "debug build")
        XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: false, automated: true, environment: [:]), "tests or UI automation")
        XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: true, automated: true, environment: ["HAPPY_ANALYTICS_CAPTURE": "http://10.0.0.2:8787/batch/"]))
        XCTAssertEqual(Analytics.destination(apiKey: nil, debug: true, automated: false, environment: ["HAPPY_ANALYTICS_CAPTURE": "http://10.0.0.2:8787/batch/"])?.url.absoluteString, "http://10.0.0.2:8787/batch/")
        XCTAssertTrue(Analytics.isAutomated(environment: [:], arguments: ["Happy", "-screen", "home"]))
        XCTAssertTrue(Analytics.isAutomated(environment: ["XCTestConfigurationFilePath": "/x"], arguments: []))
    }

    func testNothingIsRecordedBeforeTheAppStartsIt() async {
        let analytics = Analytics()
        XCTAssertFalse(analytics.isRecording)
        analytics.log(.onboardingCompleted)
        await analytics.settle()
    }

    func testCommonPropertiesSayOnlyTheClientItsVersionsAndTheAgentsKind() async throws {
        let http = http()
        let analytics = started(http)
        analytics.agent = { .init(location: .remote, os: .mac, version: "0.14.2") }
        analytics.log(.onboardingCompleted)
        let events = try await sent(analytics, http)
        let properties = try XCTUnwrap(events.first?["properties"]?.objectValue)
        XCTAssertEqual(properties.filter { !$0.key.hasPrefix("$") && $0.key != "distinct_id" }, [
            "client": .string("ios"), "app_version": .string("2.0.0"), "channel": .string("stable"), "os": .string("ios"),
            "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .string("remote"),
            "agent_os": .string("mac"), "happy_agent_version": .string("0.14.2"),
        ])
    }

    func testAppOpenedOnAColdStartAndAfterHalfAnHourAway() async throws {
        let http = http()
        let analytics = started(http)
        analytics.appBecameActive()
        analytics.appEnteredBackground()
        clock += 29 * 60
        analytics.appBecameActive()
        analytics.appEnteredBackground()
        clock += 30 * 60
        analytics.appBecameActive()
        let opened = try await sent(analytics, http).filter { $0["event"] == .string("app_opened") }.map { $0["properties"]?["cold"] }
        XCTAssertEqual(opened, [.bool(true), .bool(false)])
    }

    func testTheDeviceSwitchStopsEverythingAndDeletesTheQueue() async throws {
        let failing = FakeHTTP()
        failing.on("POST /batch") { _ in throw URLError(.notConnectedToInternet) }
        let storage = InMemoryKeyValueStore()
        let consent = AnalyticsConsent(storage: storage)
        let analytics = started(failing, consent: consent)
        analytics.log(.onboardingCompleted)
        consent.setDeviceOptOut(true)
        analytics.log(.onboardingStepViewed(step: .done))
        consent.setDeviceOptOut(false)
        failing.on("POST /batch") { _ in (200, Data()) }
        analytics.log(.onboardingStepViewed(step: .pair))
        let events = try await sent(analytics, failing).map { $0["event"]?.stringValue }
        XCTAssertEqual(events, ["onboarding_step_viewed"], "only what came after opting back in")
        XCTAssertFalse(AnalyticsConsent(storage: storage).isOptedOut)
    }

    func testAnySignedInAccountThatOptedOutStopsSending() async {
        let storage = InMemoryKeyValueStore()
        let consent = AnalyticsConsent(storage: storage)
        consent.setAccount("a", optedOut: false)
        consent.setAccount("b", optedOut: true)
        XCTAssertTrue(consent.isOptedOut)
        XCTAssertTrue(AnalyticsConsent(storage: storage).isOptedOut, "remembered across launches")
        consent.keepAccounts(["a"])
        XCTAssertFalse(consent.isOptedOut, "b signed out")
        consent.setDeviceOptOut(true)
        XCTAssertTrue(AnalyticsConsent(storage: storage).isOptedOut)
    }

    func testAShortDropSendsNothingAndALongOneSaysHowItEnded() async {
        var incidents = ConnectionIncidents()
        let link = ConnectionIncidents.Link(id: "agent-1", transport: .direct, down: false)
        var down = link
        down.down = true
        XCTAssertNil(incidents.update(link, at: clock))
        XCTAssertNil(incidents.update(down, at: clock))
        XCTAssertNil(incidents.update(link, at: clock + 9), "under ten seconds")

        XCTAssertNil(incidents.update(down, at: clock + 20))
        var timedOut = down
        timedOut.code = .timeout
        XCTAssertNil(incidents.update(timedOut, at: clock + 25))
        XCTAssertEqual(incidents.update(link, at: clock + 45), .connectionIssue(transport: .direct, code: .timeout, outcome: .recovered, duration: .from10sTo30s))

        XCTAssertNil(incidents.update(down, at: clock + 100))
        XCTAssertEqual(incidents.setForeground(false, at: clock + 400), .connectionIssue(transport: .direct, code: .unknown, outcome: .backgrounded, duration: .from5mTo15m))
        XCTAssertNil(incidents.update(down, at: clock + 500), "not while in the background")
        XCTAssertNil(incidents.setForeground(true, at: clock + 600))
        let relay = ConnectionIncidents.Link(id: "account-1", transport: .relay, down: false)
        XCTAssertEqual(incidents.update(relay, at: clock + 2000), .connectionIssue(transport: .direct, code: .unknown, outcome: .gaveUp, duration: .from15mTo1h))
    }

    func testTheWatchFollowsOnlyTheLinkTheAppShows() async {
        let watch = ConnectionWatch()
        var logged: [AnalyticsEvent] = []
        watch.log = { logged.append($0) }
        watch.now = { [unowned self] in clock }
        watch.setActive("agent:a")
        watch.report(.init(id: "relay:x", transport: .relay, down: true))
        watch.report(.init(id: "agent:a", transport: .direct, down: true, code: .unreachable))
        clock += 15
        watch.report(.init(id: "relay:x", transport: .relay, down: false))
        XCTAssertEqual(logged, [], "another account's link")
        watch.report(.init(id: "agent:a", transport: .direct, down: false))
        XCTAssertEqual(logged, [.connectionIssue(transport: .direct, code: .unreachable, outcome: .recovered, duration: .from10sTo30s)])
    }

    func testAConnectionsErrorIsReadByItsTypeAlone() async {
        typealias Code = AnalyticsEvent.ConnectionCode
        XCTAssertEqual(Code(URLError(.timedOut)), .timeout)
        XCTAssertEqual(Code(URLError(.cannotFindHost)), .unreachable)
        XCTAssertEqual(Code(PairingError.updateRequired), .versionMismatch)
        XCTAssertEqual(Code(PairingError.unavailable), .unreachable)
        XCTAssertEqual(Code(CancellationError()), .unknown)
    }

    func testCrashesAreReducedToTheCatalogsReasons() async {
        typealias Reason = AnalyticsEvent.CrashReason
        XCTAssertEqual(Reason(exceptionType: 1, signal: 11, termination: nil), .nativeCrash)
        XCTAssertEqual(Reason(exceptionType: 6, signal: 5, termination: nil), .crash)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 6, termination: nil), .crash)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 9, termination: "Namespace FRONTBOARD, Code 0x8badf00d"), .hang)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 9, termination: "Namespace CODESIGNING, Code 2"), .integrity)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 9, termination: nil), .killed)
        XCTAssertEqual(Reason(exceptionType: 11, signal: 9, termination: "MEMORY limit"), .oom)
        XCTAssertEqual(Reason(exceptionType: nil, signal: nil, termination: nil), .unknown)
    }

    func testWireWordsMapToTheCatalogsWords() async {
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: "usage_limit"), .usageLimit)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: "quota_melted"), .other)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: "untyped"), .other)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: nil), .untyped)
        XCTAssertEqual(AnalyticsEvent.ProviderKind(type: "Codex"), .codex)
        XCTAssertEqual(AnalyticsEvent.ProviderKind(type: "acme-internal"), .other)
        XCTAssertEqual(AnalyticsEvent.DurationBucket(seconds: 9.9), .under10s)
        XCTAssertEqual(AnalyticsEvent.DurationBucket(seconds: 3600), .over1h)
        XCTAssertEqual(AnalyticsEvent.ErrorCode(status: 503), .serverError)
        XCTAssertEqual(AnalyticsEvent.PairingErrorCode(PairingError.turnedOff), .disabled)
        XCTAssertEqual(AnalyticsEvent.PairingErrorCode(URLError(.timedOut)), .unknown)
        XCTAssertEqual(AnalyticsEvent.Bucket123(7), .threeOrMore)
    }
}
