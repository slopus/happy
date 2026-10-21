import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Answers every request with `body`, once opened.
private final class HeldHTTP: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let body: String
    private var opened = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var asked: [CheckedContinuation<Void, Never>] = []
    private var count = 0

    init(_ body: String) { self.body = body }

    var requests: Int { lock.withLock { count } }

    /// Returns once a request has come in.
    func untilAsked() async {
        await withCheckedContinuation { continuation in
            let now: Bool = lock.withLock {
                guard count == 0 else { return true }
                asked.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }

    func open() {
        let waiting = lock.withLock {
            opened = true
            defer { self.waiting = [] }
            return self.waiting
        }
        for continuation in waiting { continuation.resume() }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let asked = lock.withLock {
            count += 1
            defer { self.asked = [] }
            return self.asked
        }
        for continuation in asked { continuation.resume() }
        await withCheckedContinuation { continuation in
            let now: Bool = lock.withLock {
                guard !opened else { return true }
                waiting.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
        return HTTPResponse(status: 200, body: Data(body.utf8))
    }
}

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

    // MARK: One server's answer

    private let required = #"{"update_required":true,"update_url":"https://store.test/a"}"#

    private func api(_ server: String, _ transport: HTTPTransport) -> HappyAPI {
        HappyAPI(serverURL: URL(string: server)!, clientID: "ios/2026.10.1", transport: transport)
    }

    /// Account A's server is still answering when account B's is asked:
    /// B's server is the one asked next, and A's late answer never shows.
    func testAnotherServerAskedMeanwhileIsAskedNextAndTheFirstAnswerIsDropped() async {
        let first = HeldHTTP(required)
        let second = FakeHTTP()
        second.onRaw("POST /v1/version", #"{"update_required":false}"#)
        let check = NativeUpdateCheck()
        let running = check.invalidate(api: api("https://a.test", first), request: request)
        await first.untilAsked()

        XCTAssertNil(check.invalidate(api: api("https://b.test", second), request: request))
        XCTAssertEqual(check.server, URL(string: "https://b.test"))
        first.open()
        await running?.value

        XCTAssertEqual(first.requests, 1, "A's server is not asked again")
        XCTAssertEqual(second.requests("POST /v1/version").count, 1)
        XCTAssertEqual(check.status, NativeUpdateCheck.Status(available: false))
        XCTAssertNil(check.updateURL, "A's banner is not B's")
    }

    func testAnotherServerLetsTheLastAnswerGoAtOnce() async {
        let first = FakeHTTP()
        first.onRaw("POST /v1/version", required)
        let check = NativeUpdateCheck()
        await check.invalidate(api: api("https://a.test", first), request: request)?.value
        XCTAssertEqual(check.updateURL, "https://store.test/a")

        var changes = 0
        let observation = check.observe { changes += 1 }
        let second = HeldHTTP("busy")
        let running = check.invalidate(api: api("https://b.test", second), request: request)
        XCTAssertNil(check.status, "before B answers")
        XCTAssertEqual(changes, 1)
        second.open()
        await running?.value
        observation.cancel()
    }

    func testTheSameServerKeepsItsAnswerWhileAskedAgain() async {
        let http = FakeHTTP()
        http.onRaw("POST /v1/version", required)
        let check = NativeUpdateCheck()
        await check.invalidate(api: api("https://a.test", http), request: request)?.value
        // Another account on the same server: the check needs no account.
        let again = check.invalidate(api: api("https://a.test", http).authenticated(token: "other"), request: request)
        XCTAssertEqual(check.updateURL, "https://store.test/a")
        await again?.value
        XCTAssertEqual(check.updateURL, "https://store.test/a")
    }
}
