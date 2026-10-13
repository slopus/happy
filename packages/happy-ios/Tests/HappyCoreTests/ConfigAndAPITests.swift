import Foundation
import XCTest
@testable import HappyCore
import HappyWire

final class ServerConfigTests: XCTestCase {
    func testDefaultsToTheHostedServer() {
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        XCTAssertEqual(config.serverURL.absoluteString, "https://api.cluster-fluster.com")
        XCTAssertFalse(config.isCustomServer)
        XCTAssertEqual(config.displayHost, "api.cluster-fluster.com")
    }

    func testCustomServerIsValidatedNormalizedAndResettable() throws {
        let storage = InMemoryKeyValueStore()
        let config = ServerConfig(storage: storage)
        try config.setCustomServerURL("  http://192.168.1.20:3005/  ")
        XCTAssertEqual(config.serverURL.absoluteString, "http://192.168.1.20:3005")
        XCTAssertTrue(config.isCustomServer)
        XCTAssertEqual(config.displayHost, "192.168.1.20:3005")

        XCTAssertThrowsError(try config.setCustomServerURL("ftp://example.com")) {
            XCTAssertEqual($0 as? ServerURLError, .unsupportedScheme)
        }
        XCTAssertThrowsError(try ServerConfig.validate("not a url")) {
            XCTAssertEqual($0 as? ServerURLError, .invalid)
        }
        XCTAssertEqual(config.serverURL.absoluteString, "http://192.168.1.20:3005", "a rejected value leaves the old one")

        try config.setCustomServerURL(nil)
        XCTAssertFalse(config.isCustomServer)
        XCTAssertNil(storage.string(forKey: "custom-server-url"))
    }

    func testServerProbeLooksForTheGreeting() async {
        let http = FakeHTTP()
        let probe = ServerProbe(transport: http)
        let url = URL(string: "https://happy.example.com")!
        http.onRaw("GET ", "Welcome to Happy Server! v1")
        let ok = await probe.check(url)
        XCTAssertEqual(ok, .ok)
        XCTAssertEqual(http.requests.first?.headers["Accept"], "text/plain")

        http.onRaw("GET ", "<html>nginx</html>")
        let notHappy = await probe.check(url)
        XCTAssertEqual(notHappy, .notHappyServer)

        http.onRaw("GET ", "Welcome to Happy Server!", status: 502)
        let failing = await probe.check(url)
        XCTAssertEqual(failing, .serverError)

        http.on("GET ") { _ in throw URLError(.cannotConnectToHost) }
        let unreachable = await probe.check(url)
        XCTAssertEqual(unreachable, .unreachable)
    }

    func testAppVariantsUseTheRNBundleIds() {
        XCTAssertEqual(AppVariant.development.bundleIdentifier, "com.slopus.happy.dev")
        XCTAssertEqual(AppVariant.preview.bundleIdentifier, "com.slopus.happy.preview")
        XCTAssertEqual(AppVariant.production.bundleIdentifier, "com.ex3ndr.happy")
        XCTAssertEqual(HappyClientID.make(version: "1.8.0"), "ios/1.8.0")
    }
}

final class HappyAPITests: XCTestCase {
    func testRequestsCarryClientIdAndBearerToken() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/machines", "[]")
        _ = try await testAPI(http).machines()
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://api.example.test/v1/machines")
        XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
        XCTAssertEqual(request.headers["X-Happy-Client"], "ios/9.9.9")
    }

    func testSessionsDeltaQuery() async throws {
        let http = FakeHTTP()
        http.on("GET /v2/sessions", json: SessionsPage(sessions: [], nextCursor: nil, hasNext: false))
        _ = try await testAPI(http).sessions(changedSince: 1234, cursor: "cursor_v1_x", limit: 50)
        _ = try await testAPI(http).sessions(changedSince: nil, cursor: nil)
        let first = http.requests[0]
        XCTAssertEqual(first.query("changedSince"), "1234")
        XCTAssertEqual(first.query("cursor"), "cursor_v1_x")
        XCTAssertEqual(first.query("limit"), "50")
        XCTAssertNil(http.requests[1].query("changedSince"))
    }

    func testSessionIdsAreEscapedInPaths() throws {
        let request = try testAPI(FakeHTTP()).makeRequest("GET", "/v3/sessions/a%2Fb/messages")
        XCTAssertEqual(request.url.absoluteString, "https://api.example.test/v3/sessions/a%2Fb/messages")
    }

    func testServerURLWithAPathPrefixIsKept() throws {
        let api = HappyAPI(serverURL: URL(string: "https://host.test/happy")!, clientID: "c", transport: FakeHTTP())
        let request = try api.makeRequest("GET", "/v1/auth", authenticated: false)
        XCTAssertEqual(request.url.absoluteString, "https://host.test/happy/v1/auth")
        XCTAssertNil(request.headers["Authorization"])
    }

    func testErrors() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/machines", "{}", status: 401)
        http.onRaw("GET /v1/account/settings", "boom", status: 500)
        http.onRaw("GET /v2/sessions", "{\"nope\":1}")

        await XCTAssertThrowsAsync(try await testAPI(http).machines()) { XCTAssertEqual($0 as? APIError, .unauthorized) }
        await XCTAssertThrowsAsync(try await testAPI(http).accountSettings()) { XCTAssertEqual($0 as? APIError, .http(status: 500, body: "boom")) }
        await XCTAssertThrowsAsync(try await testAPI(http).sessions(changedSince: nil, cursor: nil)) {
            guard case .decoding? = $0 as? APIError else { return XCTFail("\($0)") }
        }
        await XCTAssertThrowsAsync(try await testAPI(http, token: nil).machines()) { XCTAssertEqual($0 as? APIError, .unauthenticated) }
    }
}

func XCTAssertThrowsAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ check: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {
        check(error)
    }
}
