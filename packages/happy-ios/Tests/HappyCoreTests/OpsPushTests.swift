import Foundation
import XCTest
@testable import HappyCore
import HappyWire

final class OpsPushTests: XCTestCase {
    func exchange(_ http: FakeHTTP, deviceToken: Data? = Data([0, 15, 255])) -> ExpoPushTokenExchange {
        ExpoPushTokenExchange(transport: http, configuration: .init(deviceId: "UUID-UPPER", development: true, appId: "com.slopus.happy.dev"), deviceToken: { deviceToken })
    }

    func testAPNsExchangeExactBodyHasNoAccountCredentials() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", #"{"data":{"expoPushToken":"ExponentPushToken[abc]"}}"#)
        let token = try await exchange(http).token()
        XCTAssertEqual(token, "ExponentPushToken[abc]")
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://exp.host/--/api/v2/push/getExpoPushToken")
        XCTAssertEqual(request.headers, ["content-type": "application/json"])
        XCTAssertEqual(try request.jsonBody(JSONValue.self), .object(["type": .string("apns"), "deviceId": .string("uuid-upper"), "development": .bool(true), "appId": .string("com.slopus.happy.dev"), "deviceToken": .string("000fff"), "projectId": .string("4558dd3d-cd5a-47cd-bad9-e591a241cc06")]))
    }

    func testExchangeRejectsMalformedAndHTTPFailure() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", #"{"data":{}}"#)
        do {
            _ = try await exchange(http).token()
            XCTFail("malformed")
        } catch { XCTAssertEqual(error as? SessionOpsError, .malformedResponse) }
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", "offline", status: 503)
        do {
            _ = try await exchange(http).token()
            XCTFail("503")
        } catch { XCTAssertEqual(error as? APIError, .http(status: 503, body: "offline")) }
    }

    func testNoAPNsTokenMakesNoExchange() async throws {
        let http = FakeHTTP()
        let token = try await exchange(http, deviceToken: nil).token()
        XCTAssertNil(token)
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testRegisterThenListAndUnregisterUseHappyAccountAPI() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", #"{"data":{"expoPushToken":"ExponentPushToken[abc]"}}"#)
        http.onRaw("POST /v1/push-tokens", #"{"success":true}"#)
        http.onRaw("GET /v1/push-tokens", #"{"tokens":[{"id":"id","token":"ExponentPushToken[abc]","createdAt":1,"updatedAt":2}]}"#)
        http.onRaw("DELETE /v1/push-tokens/ExponentPushToken[abc]", #"{"success":true}"#)
        let registration = TokenPushRegistration(source: exchange(http))
        let api = testAPI(http)
        let token = try await registration.register(api: api)
        let current = await registration.currentToken()
        XCTAssertEqual(token, "ExponentPushToken[abc]")
        XCTAssertEqual(current, token)
        let request = try XCTUnwrap(http.requests("POST /v1/push-tokens").first)
        XCTAssertEqual(try request.jsonBody(JSONValue.self), .object(["token": .string("ExponentPushToken[abc]")]))
        XCTAssertNotNil(request.headers["Authorization"])
        XCTAssertNotNil(request.headers["X-Happy-Client"])
        let listed = try await api.pushTokens()
        XCTAssertEqual(listed.first?.token, token)
        try await api.unregisterPushToken(try XCTUnwrap(token))
        XCTAssertEqual(http.requests("DELETE /v1/push-tokens/ExponentPushToken[abc]").count, 1)
    }

    func testFailedRegistrationDoesNotClaimTokenWasRegistered() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", #"{"data":{"expoPushToken":"ExponentPushToken[abc]"}}"#)
        http.onRaw("POST /v1/push-tokens", #"{"success":false}"#)
        let registration = TokenPushRegistration(source: exchange(http))
        do {
            _ = try await registration.register(api: testAPI(http))
            XCTFail("must refuse")
        } catch {}
        let current = await registration.currentToken()
        XCTAssertNil(current)
    }

    func testLastRegisteredTokenSurvivesRegistrationObjectRelaunch() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", #"{"data":{"expoPushToken":"ExponentPushToken[abc]"}}"#)
        http.onRaw("POST /v1/push-tokens", #"{"success":true}"#)
        let cache = PushCache()
        let first = TokenPushRegistration(source: exchange(http), cache: cache)
        _ = try await first.register(api: testAPI(http))
        let restored = TokenPushRegistration(source: exchange(http, deviceToken: nil), cache: cache)
        let token = await restored.currentToken()
        XCTAssertEqual(token, "ExponentPushToken[abc]")
    }

    func testTokenCacheIsPerAccountAndClearedOnSignOut() async throws {
        let first = LocalSettings(storage: InMemoryKeyValueStore())
        let second = LocalSettings(storage: InMemoryKeyValueStore())
        XCTAssertEqual(LocalSettings.storageSuite(accountID: "account-a"), "happy-ios.local-settings.account-a")
        try await first.saveToken("ExponentPushToken[first]")
        let token = try await first.loadToken()
        let other = try await second.loadToken()
        XCTAssertEqual(token, "ExponentPushToken[first]")
        XCTAssertNil(other)
        first.clear()
        let cleared = try await first.loadToken()
        XCTAssertNil(cleared)
    }
}

private actor PushCache: PushRegistrationTokenCache {
    var token: String?
    func loadToken() async throws -> String? { token }
    func saveToken(_ token: String) async throws { self.token = token }
}