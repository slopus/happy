import Foundation
import XCTest
@testable import HappyAnalytics
@testable import HappyCore
import HappyWire

/// The migration card's PostHog flag, which only analytics asks for: asked
/// for this install's random id, one answer in memory for every account,
/// and the card hidden unless it was yes while analytics may ask.
@MainActor
final class MigrationFlagTests: XCTestCase {
    private let route = "POST /flags"

    /// A release build's analytics, with the accounts' settings read.
    private func started(_ http: HTTPTransport, flag: MigrationNoteFlag, flagKey: String? = "phc_test",
                         consent: AnalyticsConsent = AnalyticsConsent(storage: InMemoryKeyValueStore()),
                         accounts: [String: Bool]? = [:]) -> Analytics {
        let analytics = Analytics()
        analytics.flag = flag
        analytics.start(.init(destination: .init(apiKey: "phc_test"), transport: http, storage: InMemoryKeyValueStore(), variant: .production,
                              appVersion: "2.0.0", osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 3),
                              deviceClass: .phone, flagKey: flagKey), consent: consent)
        if let accounts { consent.settle(accounts, since: consent.revisions) }
        return analytics
    }

    /// One ask, with the analytics that made it kept until the answer is in:
    /// the ask holds it weakly, as the app's own does.
    private func ask(_ http: HTTPTransport, flag: MigrationNoteFlag) async {
        let analytics = started(http, flag: flag)
        await analytics.refreshMigrationFlag(accountOptedOut: false)?.value
        withExtendedLifetime(analytics) {}
    }

    private func answering(_ body: String, status: Int = 200) -> FakeHTTP {
        let http = FakeHTTP()
        http.on(route) { _ in (status, Data(body.utf8)) }
        return http
    }

    private func on(_ enabled: Bool) -> String {
        #"{"flags":{"direct-connection-migration-note":{"key":"direct-connection-migration-note","enabled":\#(enabled),"variant":null}},"errorsWhileComputingFlags":false}"#
    }

    /// The flag on for this install shows the card. PostHog is asked with
    /// the id analytics sends, never an account's, and nothing else.
    func testFlagOnShowsTheCardAndIsAskedForTheInstall() async throws {
        let flag = MigrationNoteFlag()
        let http = answering(on(true))
        let analytics = started(http, flag: flag)
        XCTAssertFalse(flag.isOn(optedOut: false), "shown before PostHog answered")
        await analytics.refreshMigrationFlag(accountOptedOut: false)?.value
        XCTAssertTrue(flag.isOn(optedOut: false))
        XCTAssertFalse(flag.isOn(optedOut: true), "an account that opted out never sees it")

        let request = try XCTUnwrap(http.requests(route).first)
        XCTAssertEqual(request.url.host, "us.i.posthog.com")
        XCTAssertEqual(request.query("v"), "2")
        let body = try request.jsonBody([String: JSONValue].self)
        let install = try await XCTUnwrap(analytics.engine).installID
        XCTAssertEqual(body["api_key"], .string("phc_test"))
        XCTAssertEqual(body["distinct_id"], install.map(JSONValue.string))
        XCTAssertEqual(body["flag_keys_to_evaluate"], .array([.string("direct-connection-migration-note")]))
        XCTAssertEqual(Set(body.keys), ["api_key", "distinct_id", "flag_keys_to_evaluate"])
    }

    /// Off, or missing from a whole answer, hides the card, a yes before
    /// included.
    func testFlagOffHidesTheCard() async {
        let flag = MigrationNoteFlag()
        flag.store(true)
        await ask(answering(on(false)), flag: flag)
        XCTAssertFalse(flag.isOn(optedOut: false))
        flag.store(true)
        await ask(answering(#"{"flags":{},"errorsWhileComputingFlags":false}"#), flag: flag)
        XCTAssertFalse(flag.isOn(optedOut: false))
    }

    /// Unknown stays hidden; a failure, a refusal or a flag PostHog
    /// couldn't compute keeps the last answer.
    func testFailuresKeepTheLastAnswer() async {
        let flag = MigrationNoteFlag()
        let failing = FakeHTTP()
        failing.on(route) { _ in throw URLError(.notConnectedToInternet) }
        await ask(failing, flag: flag)
        XCTAssertEqual(failing.requests(route).count, 1)
        XCTAssertNil(flag.answer)

        flag.store(true)
        for transport in [failing, answering("{}", status: 500), answering("not json"), answering(#"{"flags":{},"errorsWhileComputingFlags":true}"#),
                          answering("", status: 302)] {
            let before = transport.requests(route).count
            await ask(transport, flag: flag)
            XCTAssertEqual(transport.requests(route).count, before + 1)
            XCTAssertEqual(flag.answer, true)
        }
    }

    /// Nothing is asked before the accounts are read, for an account that
    /// opted out, or while anyone here has; opting out drops the answer.
    func testOptedOutOrUnreadAsksNothing() async {
        let flag = MigrationNoteFlag()
        let http = answering(on(true))
        XCTAssertNil(started(http, flag: flag, accounts: nil).refreshMigrationFlag(accountOptedOut: false))
        XCTAssertFalse(flag.isOn(optedOut: false), "nothing counts before the accounts are read")
        XCTAssertNil(started(http, flag: flag).refreshMigrationFlag(accountOptedOut: true))

        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(http, flag: flag, consent: consent)
        flag.store(true)
        consent.setDeviceOptOut(true)
        XCTAssertNil(flag.answer, "an opt-out drops the answer")
        XCTAssertNil(analytics.refreshMigrationFlag(accountOptedOut: false))
        XCTAssertFalse(flag.isOn(optedOut: false))
        XCTAssertTrue(http.requests.isEmpty)
    }

    /// Opted out after the ask was made but before it went: nothing is
    /// sent, and opted back in, the next ask goes.
    func testAnOptOutBeforeTheAskGoesSendsNothing() async {
        let flag = MigrationNoteFlag()
        let http = answering(on(true))
        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(http, flag: flag, consent: consent)
        let asking = analytics.refreshMigrationFlag(accountOptedOut: false)
        XCTAssertNotNil(asking)
        consent.setDeviceOptOut(true)
        await asking?.value
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertNil(flag.answer)

        consent.setDeviceOptOut(false)
        await analytics.settle()
        await analytics.refreshMigrationFlag(accountOptedOut: false)?.value
        XCTAssertEqual(http.requests(route).count, 1, "the dropped ask let go")
        XCTAssertEqual(flag.answer, true)
    }

    /// An answer that comes back after an opt-out is dropped.
    func testAnAnswerAfterAnOptOutIsDropped() async {
        let flag = MigrationNoteFlag()
        let gated = GatedHTTP(status: 200, body: on(true))
        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(gated, flag: flag, consent: consent)
        let asking = analytics.refreshMigrationFlag(accountOptedOut: false)
        await gated.started(1)
        consent.setDeviceOptOut(true)
        gated.release()
        await asking?.value
        XCTAssertNil(flag.answer)
        XCTAssertFalse(flag.isOn(optedOut: false))
    }

    /// A debug run, a test or a harness (no flag key), and a build without
    /// a destination, ask nothing; the card stays hidden, as in a build
    /// without analytics at all.
    func testABuildThatMayNotAskKeepsTheCardHidden() async {
        let flag = MigrationNoteFlag()
        let http = answering(on(true))
        XCTAssertNil(started(http, flag: flag, flagKey: nil).refreshMigrationFlag(accountOptedOut: false))
        let nothing = Analytics()
        nothing.flag = flag
        nothing.start(nil, consent: AnalyticsConsent(storage: InMemoryKeyValueStore()))
        XCTAssertNil(nothing.refreshMigrationFlag(accountOptedOut: false))
        XCTAssertTrue(http.requests.isEmpty)
        flag.store(true)
        XCTAssertFalse(flag.isOn(optedOut: false))
        XCTAssertFalse(MigrationNoteFlag().isOn(optedOut: false), "nothing asks: a build without analytics")
    }

    /// PostHog's v1 answer, a variant name counting as on; and a key xtool
    /// left unexpanded is no key.
    func testTheOlderAnswerAndTheKey() {
        XCTAssertEqual(MigrationFlagAsk.answer(status: 200, body: Data(#"{"featureFlags":{"direct-connection-migration-note":true}}"#.utf8)), true)
        XCTAssertEqual(MigrationFlagAsk.answer(status: 200, body: Data(#"{"featureFlags":{"direct-connection-migration-note":"test"}}"#.utf8)), true)
        XCTAssertEqual(MigrationFlagAsk.answer(status: 200, body: Data(#"{"featureFlags":{"direct-connection-migration-note":false}}"#.utf8)), false)
        XCTAssertEqual(MigrationFlagAsk.answer(status: 200, body: Data(#"{"featureFlags":{}}"#.utf8)), false)
        XCTAssertNil(Analytics.validKey("$(HAPPY_POSTHOG_API_KEY)"))
        XCTAssertNil(Analytics.validKey(" "))
        XCTAssertEqual(Analytics.validKey("phc_abc"), "phc_abc")
    }
}
