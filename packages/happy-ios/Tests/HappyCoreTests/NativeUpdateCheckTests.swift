import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// sync.ts `fetchNativeUpdate` and UpdateBanner's `useNativeUpdate`.
@MainActor
final class NativeUpdateCheckTests: XCTestCase {
    private let request = NativeUpdateCheck.Request(version: "2026.10.1", appId: "com.ex3ndr.happy")

    private func api(_ http: FakeHTTP) -> HappyAPI {
        HappyAPI(serverURL: URL(string: "https://api.test")!, clientID: "ios/2026.10.1", transport: http)
            .authenticated(token: "secret")
    }

    func testThePostIsHappyAppsWithoutTheToken() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/version", #"{"update_required":true,"update_url":"https://apps.apple.com/app/id1"}"#)
        let check = NativeUpdateCheck()
        await check.invalidate(api: api(http), request: request)?.value

        let sent = try XCTUnwrap(http.requests("POST /v1/version").first)
        XCTAssertNil(sent.headers["Authorization"], "a version check needs no account")
        XCTAssertEqual(sent.headers["X-Happy-Client"], "ios/2026.10.1")
        XCTAssertEqual(sent.headers["Content-Type"], "application/json")
        let body = try sent.jsonBody(JSONValue.self)
        XCTAssertEqual(body, .object(["platform": .string("ios"), "version": .string("2026.10.1"), "app_id": .string("com.ex3ndr.happy")]))

        XCTAssertEqual(check.status, NativeUpdateCheck.Status(available: true, updateURL: "https://apps.apple.com/app/id1"))
        XCTAssertEqual(check.updateURL, "https://apps.apple.com/app/id1")
    }

    func testTodaysServerAnswerShowsNothing() async {
        // versionRoutes.ts answers `{ updateUrl }`, which happy-app doesn't read.
        let http = FakeHTTP()
        http.onRaw("POST /v1/version", #"{"updateUrl":"https://apps.apple.com/app/id1"}"#)
        let check = NativeUpdateCheck()
        await check.invalidate(api: api(http), request: request)?.value
        XCTAssertEqual(check.status, NativeUpdateCheck.Status(available: false))
        XCTAssertNil(check.updateURL)
    }

    func testARefusalKeepsTheLastAnswerAndAFailureClearsIt() async {
        let http = FakeHTTP()
        http.onRaw("POST /v1/version", #"{"update_required":1,"update_url":"https://store.test"}"#)
        let check = NativeUpdateCheck()
        var changes = 0
        let observation = check.observe { changes += 1 }
        await check.invalidate(api: api(http), request: request)?.value
        XCTAssertEqual(check.updateURL, "https://store.test", "any truthy flag")

        http.onRaw("POST /v1/version", "busy", status: 503)
        await check.invalidate(api: api(http), request: request)?.value
        XCTAssertEqual(check.updateURL, "https://store.test")

        http.onRaw("POST /v1/version", "<html>")
        await check.invalidate(api: api(http), request: request)?.value
        XCTAssertNil(check.status)
        XCTAssertEqual(changes, 2)
        observation.cancel()
    }

    func testAnswers() {
        func outcome(_ body: String, status: Int = 200) -> NativeUpdateCheck.Outcome {
            NativeUpdateCheck.outcome(status: status, body: Data(body.utf8))
        }
        XCTAssertEqual(outcome(#"{"update_required":true,"update_url":""}"#), .set(.init(available: false)))
        XCTAssertEqual(outcome(#"{"update_required":false,"update_url":"https://x"}"#), .set(.init(available: false)))
        XCTAssertEqual(outcome(#"{"update_required":"yes","update_url":"https://x"}"#), .set(.init(available: true, updateURL: "https://x")))
        XCTAssertEqual(outcome("null"), .set(nil), "reading a field of null throws")
        XCTAssertEqual(outcome("{}", status: 404), .keep)
    }

    func testAskingWhileAskingRunsOnceMore() async {
        let http = FakeHTTP()
        http.onRaw("POST /v1/version", "{}")
        let check = NativeUpdateCheck()
        let first = check.invalidate(api: api(http), request: request)
        XCTAssertNil(check.invalidate(api: api(http), request: request))
        XCTAssertNil(check.invalidate(api: api(http), request: request))
        await first?.value
        XCTAssertEqual(http.requests("POST /v1/version").count, 2)
    }
}
