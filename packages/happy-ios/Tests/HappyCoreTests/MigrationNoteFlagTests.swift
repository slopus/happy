import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// The migration card's PostHog flag: asked for the account's anonID,
/// kept per account, and the card hidden unless the last answer was yes.
@MainActor
final class MigrationNoteFlagTests: XCTestCase {
    private let route = "POST /flags"

    private func answering(_ body: String, status: Int = 200) -> FakeHTTP {
        let http = FakeHTTP()
        http.onRaw(route, body, status: status)
        return http
    }

    private func on(_ enabled: Bool) -> String {
        #"{"flags":{"direct-connection-migration-note":{"key":"direct-connection-migration-note","enabled":\#(enabled),"variant":null}},"errorsWhileComputingFlags":false}"#
    }

    /// The flag on for this person shows the card, and the answer stays
    /// with the account for the next launch.
    func testFlagOnShowsTheCard() async throws {
        let flag = MigrationNoteFlag()
        let storage = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: storage)
        let http = answering(on(true))
        XCTAssertFalse(flag.isOn(settings, optedOut: false), "shown before PostHog answered")
        await flag.refresh(accountID: "anon-1", settings: settings, optedOut: false, apiKey: "phc_test", transport: http)?.value
        XCTAssertTrue(flag.isOn(settings, optedOut: false))
        XCTAssertTrue(MigrationNoteFlag().isOn(LocalSettings(storage: storage), optedOut: false), "not kept for the account")

        let request = try XCTUnwrap(http.requests(route).first)
        XCTAssertEqual(request.url.host, "us.i.posthog.com")
        XCTAssertEqual(request.query("v"), "2")
        let body = try request.jsonBody([String: JSONValue].self)
        XCTAssertEqual(body["api_key"], .string("phc_test"))
        XCTAssertEqual(body["distinct_id"], .string("anon-1"))
        XCTAssertEqual(body["flag_keys_to_evaluate"], .array([.string("direct-connection-migration-note")]))
    }

    /// Off, or missing from a whole answer, hides the card, a yes before
    /// included.
    func testFlagOffHidesTheCard() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        settings.migrationNoteFlag = true
        await flag.refresh(accountID: "anon", settings: settings, optedOut: false, apiKey: "phc_test", transport: answering(on(false)))?.value
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
        settings.migrationNoteFlag = true
        await flag.refresh(accountID: "anon", settings: settings, optedOut: false, apiKey: "phc_test", transport: answering(#"{"flags":{},"errorsWhileComputingFlags":false}"#))?.value
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
    }

    /// Unknown stays hidden; a failure, a refusal or a flag PostHog
    /// couldn't compute keeps the last answer.
    func testFailuresKeepTheLastAnswer() async {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        let failing = FakeHTTP()
        failing.on(route) { _ in throw URLError(.notConnectedToInternet) }
        await flag.refresh(accountID: "anon", settings: settings, optedOut: false, apiKey: "phc_test", transport: failing)?.value
        XCTAssertNil(settings.migrationNoteFlag)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))

        settings.migrationNoteFlag = true
        for transport in [failing, answering("{}", status: 500), answering("not json"), answering(#"{"flags":{},"errorsWhileComputingFlags":true}"#)] {
            await flag.refresh(accountID: "anon", settings: settings, optedOut: false, apiKey: "phc_test", transport: transport)?.value
            XCTAssertEqual(settings.migrationNoteFlag, true)
        }
    }

    /// Opted out of analytics, or a build without the key: nothing is
    /// asked, and the card stays hidden.
    func testOptedOutOrNoKeyAsksNothing() {
        let flag = MigrationNoteFlag()
        let settings = LocalSettings(storage: InMemoryKeyValueStore())
        settings.migrationNoteFlag = true
        XCTAssertFalse(flag.isOn(settings, optedOut: true))
        let http = answering(on(true))
        XCTAssertNil(flag.refresh(accountID: "anon", settings: settings, optedOut: true, apiKey: "phc_test", transport: http))
        XCTAssertNil(flag.refresh(accountID: "anon", settings: settings, optedOut: false, apiKey: nil, transport: http))
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertNil(settings.migrationNoteFlag)
        XCTAssertFalse(flag.isOn(settings, optedOut: false))
        // xtool leaves the build setting unexpanded.
        XCTAssertNil(MigrationNoteFlag.validKey("$(HAPPY_POSTHOG_API_KEY)"))
        XCTAssertNil(MigrationNoteFlag.validKey(" "))
        XCTAssertEqual(MigrationNoteFlag.validKey("phc_abc"), "phc_abc")
    }

    /// PostHog's v1 answer, a variant name counting as on.
    func testTheOlderAnswer() {
        XCTAssertEqual(MigrationNoteFlag.answer(status: 200, body: Data(#"{"featureFlags":{"direct-connection-migration-note":true}}"#.utf8)), true)
        XCTAssertEqual(MigrationNoteFlag.answer(status: 200, body: Data(#"{"featureFlags":{"direct-connection-migration-note":"test"}}"#.utf8)), true)
        XCTAssertEqual(MigrationNoteFlag.answer(status: 200, body: Data(#"{"featureFlags":{"direct-connection-migration-note":false}}"#.utf8)), false)
        XCTAssertEqual(MigrationNoteFlag.answer(status: 200, body: Data(#"{"featureFlags":{}}"#.utf8)), false)
    }
}
