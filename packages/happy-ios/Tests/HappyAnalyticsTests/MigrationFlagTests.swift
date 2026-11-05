import Foundation
import XCTest
@testable import HappyAnalytics
@testable import HappyCore
import HappyWire

/// The migration card's PostHog flag, which only analytics asks for: asked
/// for this install's random id, kept per account, and the card hidden
/// unless the last answer was yes while analytics may ask.
@MainActor
final class MigrationFlagTests: XCTestCase {
    private let route = "POST /flags"

    /// A release build's analytics, with the accounts' settings read.
    private func started(_ http: HTTPTransport, flag: MigrationNoteFlag, flagKey: String? = "phc_test",
                         consent: AnalyticsConsent = AnalyticsConsent(storage: InMemoryKeyValueStore()),
                         accounts: [String: Bool]? = [:]) -> Analytics {
        let analytics = Analytics()
        analytics.flag = flag
        analytics.start(.init(destination: .init(apiKey: "phc_test"), file: nil, transport: http, variant: .production,
                              appVersion: "2.0.0", osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 3),
                              deviceClass: .phone, flagKey: flagKey), consent: consent)
        if let accounts { consent.settle(accounts) }
        return analytics
    }

    private func answering(_ body: String, status: Int = 200) -> FakeHTTP {
        let http = FakeHTTP()
        http.on(route) { _ in (status, Data(body.utf8)) }
        return http
    }

    private func on(_ enabled: Bool) -> String {
        #"{"flags":{"direct-connection-migration-note":{"key":"direct-connection-migration-note","enabled":\#(enabled),"variant":null}},"errorsWhileComputingFlags":false}"#
    }

    /// The flag on for this install shows the card, and the answer stays
    /// with the account. PostHog is asked with the id analytics sends,
    /// never an account's.
    func testFlagOnShowsTheCardAndIsAskedForTheInstall() async throws {
        let flag = MigrationNoteFlag()
        let storage = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: storage)
        let http = answering(on(true))
        let analytics = started(http, flag: flag)
        XCTAssertFalse(flag.isOn(settings, optedOut: false), "shown before PostHog answered")
        await analytics.refreshMigrationFlag(settings: settings, accountOptedOut: false)?.value
        XCTAssertTrue(flag.isOn(settings, optedOut: false))
        XCTAssertEqual(LocalSettings(storage: storage).migrationNoteFlag, true, "not kept for the account")

        let request = try XCTUnwrap(http.requests(route).first)
        XCTAssertEqual(request.url.host, "us.i.posthog.com")
        XCTAssertEqual(request.query("v"), "2")
        let body = try request.jsonBody([String: JSONValue].self)
        let install = try await XCTUnwrap(analytics.engine).installID
        XCTAssertEqual(body["api_key"], .string("phc_test"))
        XCTAssertEqual(body["distinct_id"], .string(install))
        XCTAssertEqual(body["flag_keys_to_evaluate"], .array([.string("direct-connection-migration-note")]))
        XCTAssertEqual(Set(body.keys), ["api_key", "distinct_id", "flag_keys_to_evaluate"])
    }

    /// Off, or missing from a whole answer, hides the card, a yes before
    /// included.
    func testFlagOffHidesTheCard() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        settings.migrationNoteFlag = true
        await started(answering(on(false)), flag: flag).refreshMigrationFlag(settings: settings, accountOptedOut: false)?.value
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
        settings.migrationNoteFlag = true
        await started(answering(#"{"flags":{},"errorsWhileComputingFlags":false}"#), flag: flag)
            .refreshMigrationFlag(settings: settings, accountOptedOut: false)?.value
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
    }

    /// Unknown stays hidden; a failure, a refusal or a flag PostHog
    /// couldn't compute keeps the last answer.
    func testFailuresKeepTheLastAnswer() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        let failing = FakeHTTP()
        failing.on(route) { _ in throw URLError(.notConnectedToInternet) }
        await started(failing, flag: flag).refreshMigrationFlag(settings: settings, accountOptedOut: false)?.value
        XCTAssertNil(settings.migrationNoteFlag)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))

        settings.migrationNoteFlag = true
        for transport in [failing, answering("{}", status: 500), answering("not json"), answering(#"{"flags":{},"errorsWhileComputingFlags":true}"#)] {
            await started(transport, flag: flag).refreshMigrationFlag(settings: settings, accountOptedOut: false)?.value
            XCTAssertEqual(settings.migrationNoteFlag, true)
        }
    }

    /// Opted out, the account or anyone on this phone: nothing is asked,
    /// a stored answer goes and the card stays hidden. Before the accounts
    /// are read nothing is asked either.
    func testOptedOutOrUnreadAsksNothing() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        let http = answering(on(true))

        let unread = started(http, flag: flag, accounts: nil)
        settings.migrationNoteFlag = true
        XCTAssertNil(unread.refreshMigrationFlag(settings: settings, accountOptedOut: false))
        XCTAssertFalse(flag.isOn(settings, optedOut: false), "nothing counts before the accounts are read")

        let analytics = started(http, flag: flag)
        XCTAssertNil(analytics.refreshMigrationFlag(settings: settings, accountOptedOut: true))
        XCTAssertNil(settings.migrationNoteFlag)

        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        consent.setDeviceOptOut(true)
        settings.migrationNoteFlag = true
        let device = started(http, flag: flag, consent: consent)
        XCTAssertNil(device.refreshMigrationFlag(settings: settings, accountOptedOut: false))
        XCTAssertNil(settings.migrationNoteFlag)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
        XCTAssertTrue(http.requests.isEmpty)
    }

    /// An answer that comes back after an opt-out is dropped.
    func testAnAnswerAfterAnOptOutIsDropped() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        let gated = GatedHTTP(status: 200, body: on(true))
        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(gated, flag: flag, consent: consent)
        let asking = analytics.refreshMigrationFlag(settings: settings, accountOptedOut: false)
        await gated.started(1)
        consent.setDeviceOptOut(true)
        gated.release()
        await asking?.value
        XCTAssertNil(settings.migrationNoteFlag)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
    }

    /// A debug run, a test or a harness (no flag key), and a build without
    /// a destination, ask nothing; the card stays hidden even with a yes
    /// kept from before, as in a build without analytics at all.
    func testABuildThatMayNotAskKeepsTheCardHidden() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        settings.migrationNoteFlag = true
        let http = answering(on(true))
        let debug = started(http, flag: flag, flagKey: nil)
        XCTAssertNil(debug.refreshMigrationFlag(settings: settings, accountOptedOut: false))
        let nothing = Analytics()
        nothing.flag = flag
        nothing.start(nil, consent: AnalyticsConsent(storage: InMemoryKeyValueStore()))
        XCTAssertNil(nothing.refreshMigrationFlag(settings: settings, accountOptedOut: false))
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertEqual(settings.migrationNoteFlag, true)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
        XCTAssertFalse(MigrationNoteFlag().isOn(settings, optedOut: false), "nothing asks: a build without analytics")
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
