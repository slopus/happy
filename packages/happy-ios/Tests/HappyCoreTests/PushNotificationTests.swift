import Foundation
import XCTest
@testable import HappyCore

/// notificationRouting.test.ts, case for case, plus the payload shapes
/// expo-notifications hands over on iOS.
final class PushNotificationRoutingTests: XCTestCase {
    func testReturnsASessionRouteWhenSessionIdExists() {
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: ["sessionId": "session-123"]), "/session/session-123")
    }

    func testEncodesSessionIdsThatContainSpaces() {
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: ["sessionId": "session 123"]), "/session/session%20123")
    }

    func testReturnsNilWhenSessionIdIsMissing() {
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: ["kind": "done"]))
    }

    func testReturnsNilForEmptySessionIds() {
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: ["sessionId": "   "]))
    }

    func testUsesASessionURLWhenPresent() {
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: ["url": "/session/session-123"]), "/session/session-123")
    }

    /// getSessionRouteFromNotificationResponse reads content.data; on iOS
    /// that is a remote notification's `body`.
    func testReadsTheRouteFromContentData() {
        let userInfo: [AnyHashable: Any] = ["body": ["sessionId": "session-123"], "aps": ["alert": "Done"]]
        let data = NotificationRouting.data(userInfo: userInfo, isRemote: true)
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: data), "/session/session-123")
    }

    func testReturnsNilWhenContentDataIsMissing() {
        let data = NotificationRouting.data(userInfo: ["aps": ["alert": "Done"]], isRemote: true)
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: data))
    }

    func testLocalNotificationDataIsTheWholeUserInfo() {
        let data = NotificationRouting.data(userInfo: ["sessionId": "local"], isRemote: false)
        XCTAssertEqual(NotificationRouting.sessionId(fromData: data), "local")
    }

    func testURLWinsOverSessionId() {
        let data: [String: Any] = ["url": "happy:///session/from-url?tab=1", "sessionId": "from-id"]
        XCTAssertEqual(NotificationRouting.sessionId(fromData: data), "from-url")
    }

    func testURLWithoutASessionFallsBackToSessionId() {
        let data: [String: Any] = ["url": "https://app.happy.engineering/settings", "sessionId": " from-id "]
        XCTAssertEqual(NotificationRouting.sessionId(fromData: data), "from-id")
    }

    /// `(?:^|/)session/`: "mysession/x" isn't a session path.
    func testSessionPathMustStartASegment() {
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: ["url": "/mysession/abc"]))
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: ["url": "session/abc#x"]), "/session/abc")
    }

    func testURLIdsAreDecodedThenReEncoded() {
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: ["url": "/session/a%20b"]), "/session/a%20b")
        XCTAssertEqual(NotificationRouting.sessionId(fromData: ["url": "/session/a%20b"]), "a b")
    }

    /// decodeURIComponent throws on a stray `%`; the raw text is used.
    func testMalformedEscapesKeepTheRawId() {
        XCTAssertEqual(NotificationRouting.sessionRoute(fromData: ["url": "/session/100%"]), "/session/100%25")
        XCTAssertEqual(NotificationRouting.sessionId(fromData: ["url": "/session/100%"]), "100%")
    }

    func testEncodeURIComponentKeepsItsUnreservedSet() {
        XCTAssertEqual(NotificationRouting.encodeURIComponent("a-_.!~*'()b/?#&é"), "a-_.!~*'()b%2F%3F%23%26%C3%A9")
    }

    func testJSONStringPayloadIsParsed() {
        XCTAssertEqual(NotificationRouting.sessionId(fromData: #"{"sessionId":"from-json"}"#), "from-json")
    }

    func testNonObjectPayloadsNameNoSession() {
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: "not json"))
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: #"["session-1"]"#))
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: nil))
        XCTAssertNil(NotificationRouting.sessionRoute(fromData: ["sessionId": 42]))
    }

    func testResponsesAreHandledOnceAndOnlyForTheDefaultAction() {
        var filter = NotificationResponseFilter()
        XCTAssertTrue(filter.shouldRoute(requestIdentifier: "a", isDefaultAction: true))
        XCTAssertFalse(filter.shouldRoute(requestIdentifier: "a", isDefaultAction: true))
        XCTAssertFalse(filter.shouldRoute(requestIdentifier: "b", isDefaultAction: false))
        // A dismissed request stays handled.
        XCTAssertFalse(filter.shouldRoute(requestIdentifier: "b", isDefaultAction: true))
    }

    func testForegroundOnlyBadgesAndLists() {
        XCTAssertEqual(NotificationPresentation.forApp(active: true), .init(banner: false, list: true, sound: false, badge: true))
        XCTAssertEqual(NotificationPresentation.forApp(active: false), .init(banner: true, list: true, sound: true, badge: true))
    }
}

final class PushProvisioningProfileTests: XCTestCase {
    func profile(apsEnvironment: String?, closed: Bool = true) -> Data {
        let entitlements = apsEnvironment.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
        <key>Name</key><string>Happy Dev</string>
        <key>Entitlements</key><dict>\(entitlements)<key>get-task-allow</key><true/></dict>
        </dict>\(closed ? "</plist>" : "")
        """
        // The CMS envelope around it: DER bytes, including non-ASCII ones.
        return Data([0x30, 0x82, 0x0F, 0xA1, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x00, 0xFF]) + Data(xml.utf8)
            + (closed ? Data([0xA0, 0x82, 0x0B, 0x9D, 0x00, 0xC3]) : Data())
    }

    func testReadsApsEnvironmentFromTheEmbeddedPlist() {
        XCTAssertEqual(ProvisioningProfile.apsEnvironment(profile(apsEnvironment: "development")), "development")
        XCTAssertEqual(ProvisioningProfile.apsEnvironment(profile(apsEnvironment: "production")), "production")
        XCTAssertNil(ProvisioningProfile.apsEnvironment(profile(apsEnvironment: nil)))
    }

    func testOnlyADevelopmentProfileUsesTheSandbox() {
        XCTAssertTrue(ProvisioningProfile.usesDevelopmentAPNs(profile(apsEnvironment: "development")))
        XCTAssertFalse(ProvisioningProfile.usesDevelopmentAPNs(profile(apsEnvironment: "production")))
        XCTAssertFalse(ProvisioningProfile.usesDevelopmentAPNs(profile(apsEnvironment: nil)))
        XCTAssertFalse(ProvisioningProfile.usesDevelopmentAPNs(nil))
    }

    func testUnreadableProfilesMeanProduction() {
        XCTAssertNil(ProvisioningProfile.apsEnvironment(Data([0x30, 0x82, 0x00])))
        XCTAssertNil(ProvisioningProfile.apsEnvironment(Data(#"<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>"#.utf8)))
        XCTAssertFalse(ProvisioningProfile.usesDevelopmentAPNs(Data("<plist>garbage</plist>".utf8)))
    }

    /// NSScanner reads to the end when `</plist>` is missing; the tag is
    /// appended either way.
    func testAMissingClosingTagReadsToTheEnd() {
        XCTAssertEqual(ProvisioningProfile.apsEnvironment(profile(apsEnvironment: "development", closed: false)), "development")
    }
}

final class PushInstallationIDTests: XCTestCase {
    let bundleID = "com.slopus.happy.dev"

    func installation(_ keychain: FakeKeychain, defaults: InMemoryKeyValueStore = InMemoryKeyValueStore(),
                      id: String = "NEW-UUID") -> ExpoInstallationID {
        ExpoInstallationID(backend: keychain, legacyDefaults: defaults, bundleIdentifier: bundleID, makeID: { id })
    }

    func testQueryIsExposItem() {
        let query = installation(FakeKeychain()).query
        XCTAssertEqual(query.service, bundleID)
        XCTAssertEqual(query.account, Data("EXDeviceInstallationUUIDKey".utf8))
        XCTAssertEqual(query.generic, Data("EXDeviceInstallationUUIDKey".utf8))
    }

    /// The RN build's item is reused as is: no write of any kind.
    func testExistingItemIsReadAndNeverRewritten() throws {
        let keychain = FakeKeychain()
        let ids = installation(keychain)
        keychain.seed(ids.query, Data("RN-INSTALLATION".utf8), accessibility: .afterFirstUnlockThisDeviceOnly)
        let defaults = InMemoryKeyValueStore()
        defaults.set("LEGACY", forKey: ExpoInstallationID.key)
        XCTAssertEqual(try installation(keychain, defaults: defaults).read(), "RN-INSTALLATION")
        XCTAssertEqual(keychain.calls, [.copy(bundleID)])
        XCTAssertEqual(defaults.string(forKey: ExpoInstallationID.key), "LEGACY")
    }

    func testLegacyDefaultMovesIntoTheKeychainThenLeavesDefaults() throws {
        let keychain = FakeKeychain()
        let defaults = InMemoryKeyValueStore()
        defaults.set("LEGACY", forKey: ExpoInstallationID.key)
        let ids = installation(keychain, defaults: defaults)
        XCTAssertEqual(try ids.read(), "LEGACY")
        XCTAssertEqual(keychain.calls, [.copy(bundleID), .delete(bundleID), .add(bundleID, "LEGACY", .afterFirstUnlockThisDeviceOnly)])
        XCTAssertNil(defaults.string(forKey: ExpoInstallationID.key))
        XCTAssertEqual(try ids.read(), "LEGACY")
    }

    func testLegacyDefaultStaysWhenTheSaveFails() {
        let keychain = DuplicateKeychain()
        let defaults = InMemoryKeyValueStore()
        defaults.set("LEGACY", forKey: ExpoInstallationID.key)
        let ids = ExpoInstallationID(backend: keychain, legacyDefaults: defaults, bundleIdentifier: bundleID)
        XCTAssertThrowsError(try ids.read())
        XCTAssertEqual(defaults.string(forKey: ExpoInstallationID.key), "LEGACY")
    }

    func testNewInstallationStoresAUUIDOnce() throws {
        let keychain = FakeKeychain()
        let ids = installation(keychain)
        XCTAssertEqual(try ids.read(), "NEW-UUID")
        XCTAssertEqual(keychain.stored(ids.query)?.accessibility, .afterFirstUnlockThisDeviceOnly)
        XCTAssertEqual(try installation(keychain, id: "OTHER").read(), "NEW-UUID")
    }

    func testKeychainErrorsAreThrownNotReplaced() {
        let keychain = FakeKeychain()
        keychain.copyFailures[bundleID] = -25308
        XCTAssertThrowsError(try installation(keychain).read()) { error in
            XCTAssertEqual(error as? KeychainStatusError, KeychainStatusError(-25308))
        }
        XCTAssertEqual(keychain.calls, [.copy(bundleID)])
    }

    /// A Keychain whose add always reports a duplicate.
    final class DuplicateKeychain: KeychainBackend, @unchecked Sendable {
        func copyData(_ query: KeychainItemQuery) throws -> Data? { nil }
        func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult { .duplicate }
        func update(_ query: KeychainItemQuery, data: Data) throws {}
        func delete(_ query: KeychainItemQuery) {}
    }
}

final class PushAPNsTokenSourceTests: XCTestCase {
    final class Registrations: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func increment() { lock.withLock { count += 1 } }
    }

    func testTokenComesFromTheCallbackAfterRegistering() async throws {
        let registrations = Registrations()
        let box = SourceBox()
        let source = APNsTokenSource {
            registrations.increment()
            await box.source?.didRegister(Data([1, 2, 3]))
        }
        box.source = source
        let token = try await source.token()
        XCTAssertEqual(token, Data([1, 2, 3]))
        XCTAssertEqual(registrations.value, 1)
    }

    func testFailurePropagates() async {
        struct NoEntitlement: Error {}
        let box = SourceBox()
        let source = APNsTokenSource { await box.source?.didFail(NoEntitlement()) }
        box.source = source
        do {
            _ = try await source.token()
            XCTFail("expected the registration error")
        } catch {
            XCTAssertTrue(error is NoEntitlement)
        }
    }

    func testWaitingRequestsShareOneCallbackAndEachAsksAgain() async throws {
        let registrations = Registrations()
        let source = APNsTokenSource { registrations.increment() }
        async let first = source.token()
        async let second = source.token()
        while registrations.value < 2 { await Task.yield() }
        await source.didRegister(Data([9]))
        let tokens = try await [first, second]
        XCTAssertEqual(tokens, [Data([9]), Data([9])])
        XCTAssertEqual(registrations.value, 2)
    }

    func testCallbackWithNobodyWaitingIsDropped() async throws {
        let box = SourceBox()
        let source = APNsTokenSource { await box.source?.didRegister(Data([2])) }
        box.source = source
        await source.didRegister(Data([1]))
        let token = try await source.token()
        XCTAssertEqual(token, Data([2]))
    }

    final class SourceBox: @unchecked Sendable {
        var source: APNsTokenSource?
    }
}

final class PushTokenSyncTests: XCTestCase {
    /// A registration that records its calls and answers from a script.
    actor FakeRegistration: PushRegistration {
        var registered: [String] = []
        var current: String?
        var next: String? = "ExponentPushToken[new]"
        var failure: (any Error)?
        var gate: CheckedContinuation<Void, Never>?
        var blocks = false
        func currentToken() async -> String? { current }
        func register(api: HappyAPI) async throws -> String? {
            if blocks { await withCheckedContinuation { gate = $0 } }
            if let failure { throw failure }
            registered.append(api.serverURL.absoluteString)
            current = next
            return next
        }
        func set(next: String?) { self.next = next }
        func set(current: String?) { self.current = current }
        func set(failure: (any Error)?) { self.failure = failure }
        func set(blocks: Bool) { self.blocks = blocks }
        func release() { gate?.resume(); gate = nil }
        var isWaiting: Bool { gate != nil }
    }

    final class PermissionScript: @unchecked Sendable {
        private let lock = NSLock()
        private var _current: PushPermission
        private var _onRequest: PushPermission
        private var _requests = 0
        init(current: PushPermission, onRequest: PushPermission) {
            _current = current
            _onRequest = onRequest
        }
        var requests: Int { lock.withLock { _requests } }
        var permissions: PushTokenSync.Permissions {
            PushTokenSync.Permissions(
                current: { self.lock.withLock { self._current } },
                request: {
                    self.lock.withLock {
                        self._requests += 1
                        self._current = self._onRequest
                        return self._current
                    }
                })
        }
    }

    let api = HappyAPI(serverURL: URL(string: "https://a.example")!, clientID: "ios/test", transport: FakeHTTP(), token: "t")

    func testGrantedRegistersWithoutAsking() async throws {
        let registration = FakeRegistration()
        let script = PermissionScript(current: .init(system: .authorized), onRequest: .init(system: .denied))
        let result = try await PushTokenSync.syncCurrentPushToken(.init(registration: registration, api: api), permissions: script.permissions)
        XCTAssertEqual(result, .init(registered: true, token: "ExponentPushToken[new]", permission: .init(system: .authorized)))
        XCTAssertEqual(script.requests, 0)
        let registered = await registration.registered
        XCTAssertEqual(registered, ["https://a.example"])
    }

    /// The first sign-in prompts, as happy-app's sync init does.
    func testUndeterminedAsksThenRegisters() async throws {
        let registration = FakeRegistration()
        let script = PermissionScript(current: .init(system: .notDetermined), onRequest: .init(system: .authorized))
        let result = try await PushTokenSync.syncCurrentPushToken(.init(registration: registration, api: api), permissions: script.permissions)
        XCTAssertTrue(result.registered)
        XCTAssertEqual(script.requests, 1)
    }

    func testDeclinedPromptRegistersNothing() async throws {
        let registration = FakeRegistration()
        await registration.set(current: "ExponentPushToken[saved]")
        let script = PermissionScript(current: .init(system: .notDetermined), onRequest: .init(system: .denied))
        let result = try await PushTokenSync.syncCurrentPushToken(.init(registration: registration, api: api), permissions: script.permissions)
        XCTAssertEqual(result, .init(registered: false, token: "ExponentPushToken[saved]", permission: .init(system: .denied)))
        let registered = await registration.registered
        XCTAssertTrue(registered.isEmpty)
    }

    func testDeniedNeverAsks() async throws {
        let registration = FakeRegistration()
        let script = PermissionScript(current: .init(system: .denied), onRequest: .init(system: .authorized))
        let result = try await PushTokenSync.syncCurrentPushToken(.init(registration: registration, api: api), permissions: script.permissions)
        XCTAssertFalse(result.registered)
        XCTAssertEqual(script.requests, 0)
    }

    func testNoTokenIsNotRegistered() async throws {
        let registration = FakeRegistration()
        await registration.set(next: nil)
        let script = PermissionScript(current: .init(system: .authorized), onRequest: .init(system: .authorized))
        let result = try await PushTokenSync.syncCurrentPushToken(.init(registration: registration, api: api), permissions: script.permissions)
        XCTAssertFalse(result.registered)
    }

    func testRunsSkipSignedOutAndSwallowFailures() async {
        let registration = FakeRegistration()
        await registration.set(failure: APIError.http(status: 500, body: ""))
        let script = PermissionScript(current: .init(system: .authorized), onRequest: .init(system: .authorized))
        let signedOut = PushTokenSync(permissions: script.permissions, target: { nil })
        await signedOut.invalidate()
        await signedOut.awaitQueue()
        let api = self.api
        let failing = PushTokenSync(permissions: script.permissions, target: { .init(registration: registration, api: api) })
        await failing.invalidate()
        await failing.awaitQueue()
        await registration.set(failure: nil)
        await failing.invalidate()
        await failing.awaitQueue()
        let registered = await registration.registered
        XCTAssertEqual(registered, ["https://a.example"])
    }

    /// InvalidateSync: any number of invalidations during a run queue one.
    func testInvalidationsDuringARunCoalesceIntoOneMore() async {
        let registration = FakeRegistration()
        await registration.set(blocks: true)
        let script = PermissionScript(current: .init(system: .authorized), onRequest: .init(system: .authorized))
        let api = self.api
        let sync = PushTokenSync(permissions: script.permissions, target: { .init(registration: registration, api: api) })
        await sync.invalidate()
        while await !registration.isWaiting { await Task.yield() }
        await sync.invalidate()
        await sync.invalidate()
        await sync.invalidate()
        await registration.release()
        while await !registration.isWaiting { await Task.yield() }
        await registration.set(blocks: false)
        await registration.release()
        await sync.awaitQueue()
        let registered = await registration.registered
        XCTAssertEqual(registered.count, 2)
    }

    /// Each run reads the active account as it starts.
    func testEachRunUsesTheAccountActiveWhenItStarts() async {
        let registration = FakeRegistration()
        let script = PermissionScript(current: .init(system: .authorized), onRequest: .init(system: .authorized))
        let target = TargetBox(.init(registration: registration, api: api))
        let sync = PushTokenSync(permissions: script.permissions, target: { target.value })
        await sync.invalidate()
        await sync.awaitQueue()
        target.value = .init(registration: registration, api: HappyAPI(serverURL: URL(string: "https://b.example")!, clientID: "ios/test", transport: FakeHTTP(), token: "u"))
        await sync.invalidate()
        await sync.awaitQueue()
        let registered = await registration.registered
        XCTAssertEqual(registered, ["https://a.example", "https://b.example"])
    }

    final class TargetBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _value: PushTokenSync.Target?
        init(_ value: PushTokenSync.Target?) { _value = value }
        var value: PushTokenSync.Target? {
            get { lock.withLock { _value } }
            set { lock.withLock { _value = newValue } }
        }
    }

    /// The source the app composes: installation id from the Keychain,
    /// signing environment, bundle id and APNs bytes in Expo's body.
    func testExpoDeviceSourceSendsTheInstallationAndEnvironment() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /--/api/v2/push/getExpoPushToken", #"{"data":{"expoPushToken":"ExponentPushToken[x]"}}"#)
        let keychain = FakeKeychain()
        let ids = ExpoInstallationID(backend: keychain, legacyDefaults: InMemoryKeyValueStore(), bundleIdentifier: "com.ex3ndr.happy")
        keychain.seed(ids.query, Data("ABC-DEF".utf8), accessibility: .afterFirstUnlockThisDeviceOnly)
        let source = ExpoDevicePushTokenSource(transport: http, installationID: ids, development: false, appId: "com.ex3ndr.happy",
                                               deviceToken: { Data([0xAB, 0x01]) })
        let token = try await source.token()
        XCTAssertEqual(token, "ExponentPushToken[x]")
        let body = try XCTUnwrap(http.requests.first).jsonBody([String: JSONValueProbe].self)
        XCTAssertEqual(body["deviceId"], .string("abc-def"))
        XCTAssertEqual(body["development"], .bool(false))
        XCTAssertEqual(body["appId"], .string("com.ex3ndr.happy"))
        XCTAssertEqual(body["deviceToken"], .string("ab01"))
    }

    func testExpoDeviceSourceFailsOnAKeychainError() async {
        let http = FakeHTTP()
        let keychain = FakeKeychain()
        keychain.copyFailures["com.ex3ndr.happy"] = -25308
        let ids = ExpoInstallationID(backend: keychain, legacyDefaults: InMemoryKeyValueStore(), bundleIdentifier: "com.ex3ndr.happy")
        let source = ExpoDevicePushTokenSource(transport: http, installationID: ids, development: false, appId: "com.ex3ndr.happy",
                                               deviceToken: { Data([1]) })
        do {
            _ = try await source.token()
            XCTFail("expected the Keychain error")
        } catch {
            XCTAssertEqual(error as? KeychainStatusError, KeychainStatusError(-25308))
        }
        XCTAssertTrue(http.requests.isEmpty)
    }

    enum JSONValueProbe: Decodable, Equatable {
        case string(String)
        case bool(Bool)
        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let bool = try? container.decode(Bool.self) { self = .bool(bool) } else { self = .string(try container.decode(String.self)) }
        }
    }
}
