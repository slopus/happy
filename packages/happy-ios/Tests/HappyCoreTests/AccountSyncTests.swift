import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

/// Settings push and conflicts (sync.ts `syncSettings`), the profile,
/// projects and the activity ephemeral.
final class AccountSyncTests: XCTestCase {
    var fixture: ServerFixture!
    var http: FakeHTTP!
    var store: LocalStore!
    var engine: SyncEngine!
    var account: AccountCipher!

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        store = try LocalStore.inMemory()
        account = AccountCipher(secret: fixture.keys.secret)
        var options = SyncEngine.Options()
        options.backoff = Backoff(initial: .milliseconds(1), maximum: .milliseconds(2))
        engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options)
    }

    override func tearDown() async throws {
        await engine.stop()
    }

    private func serverSettings(_ value: JSONValue, version: Int) throws {
        let sealed = try account.encrypt(value)
        http.onRaw("GET /v1/account/settings", #"{"settings":"\#(sealed)","settingsVersion":\#(version)}"#)
    }

    private func pushed(_ request: HTTPRequest) throws -> (expected: Int, values: JSONValue?) {
        let body = try request.jsonBody(UpdateAccountSettingsRequest.self)
        return (body.expectedVersion, body.settings.flatMap(account.decrypt(base64:)))
    }

    // MARK: Settings

    func testAChangeIsPushedOverTheServersCopy() async throws {
        try serverSettings(.object(["theme": .string("dark")]), version: 3)
        await engine.run(.settings)
        XCTAssertTrue(http.requests("POST /v1/account/settings").isEmpty, "nothing pending, nothing pushed")

        http.onRaw("POST /v1/account/settings", #"{"success":true,"version":4}"#)
        try await engine.updateSettings(["experiments": .bool(true)])
        XCTAssertEqual(AccountSettings(try store.settingsSnapshot()).experiments, true, "shown before the server answers")
        await engine.waitForIdle()

        let sent = try pushed(XCTUnwrap(http.requests("POST /v1/account/settings").first))
        XCTAssertEqual(sent.expected, 3)
        XCTAssertEqual(sent.values?["theme"], .string("dark"), "unknown keys survive")
        XCTAssertEqual(sent.values?["experiments"], .bool(true))
        XCTAssertEqual(sent.values?["schemaVersion"], .number(2))
        XCTAssertNil(sent.values?["agentDefaultOverrides"], "empty overrides are dropped")
        XCTAssertEqual(try store.accountSettings()?.version, 4)
        XCTAssertEqual(try store.pendingSettings(), [:])
    }

    func testAConflictRebasesOnTheServersCopyAndLocalKeysWin() async throws {
        try serverSettings(.object([:]), version: 1)
        await engine.run(.settings)
        let theirs = try account.encrypt(.object(["experiments": .bool(false), "avatarStyle": .string("gradient")]))
        let attempts = PageCounter()
        http.on("POST /v1/account/settings") { _ in
            attempts.count += 1
            if attempts.count == 1 {
                return (200, Data(#"{"success":false,"error":"version-mismatch","currentVersion":5,"currentSettings":"\#(theirs)"}"#.utf8))
            }
            return (200, Data(#"{"success":true,"version":6}"#.utf8))
        }
        try serverSettings(.object([:]), version: 6)

        try await engine.updateSettings(["experiments": .bool(true)])
        await engine.waitForIdle()

        let requests = http.requests("POST /v1/account/settings")
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try pushed(requests[0]).expected, 1)
        let second = try pushed(requests[1])
        XCTAssertEqual(second.expected, 5)
        XCTAssertEqual(second.values?["experiments"], .bool(true))
        XCTAssertEqual(second.values?["avatarStyle"], .string("gradient"))
        XCTAssertEqual(try store.pendingSettings(), [:])
    }

    func testEndlessConflictsGiveUpAndKeepTheChange() async throws {
        let theirs = try account.encrypt(.object([:]))
        http.onRaw("POST /v1/account/settings", #"{"success":false,"error":"version-mismatch","currentVersion":9,"currentSettings":"\#(theirs)"}"#)
        try store.addPendingSettings(["experiments": .bool(true)])
        do {
            try await engine.pushSettings()
            XCTFail("expected a conflict")
        } catch let error as SyncEngine.SyncError {
            XCTAssertEqual(error, .settingsConflict)
        }
        XCTAssertEqual(http.requests("POST /v1/account/settings").count, 3)
        XCTAssertEqual(try store.pendingSettings(), ["experiments": .bool(true)])
    }

    func testOverridesSurviveWhenSet() {
        let settings = AccountSettings(["agentDefaultOverrides": .object([
            "claude": .object(["modelMode": .string("claude-opus-5")]),
            "codex": .object([:]),
        ])])
        XCTAssertEqual(settings.syncPayload["agentDefaultOverrides"], .object(["claude": .object(["modelMode": .string("claude-opus-5")])]))
    }

    func testDefaultsFillInAndChineseMigrates() {
        let settings = AccountSettings(["preferredLanguage": .string("zh"), "avatarStyle": .string("nope")])
        XCTAssertEqual(settings.preferredLanguage, "zh-Hans")
        XCTAssertEqual(settings.avatarStyle, .brutalist)
        XCTAssertTrue(settings.hideArchivedSessions)
        XCTAssertEqual(settings.userMessageBubbleColor, .gray)
        XCTAssertEqual(settings.sessionListGrouping, .flat)
    }

    func testPendingLayersOverSynced() {
        let snapshot = SettingsSnapshot(
            synced: AccountSettingsRecord(version: 1, cipher: nil, settings: .object(["experiments": .bool(true), "avatarMonochrome": .bool(true)])),
            pending: ["experiments": .bool(false)]
        )
        let settings = AccountSettings(snapshot)
        XCTAssertFalse(settings.experiments)
        XCTAssertTrue(settings.avatarMonochrome)
    }

    // MARK: Profile

    func testProfileIsFetchedThenPatchedLive() async throws {
        http.onRaw("GET /v1/account/profile", """
        {"id":"u1","timestamp":100,"firstName":"Ada","lastName":null,"username":"ada",
         "avatar":null,"github":{"id":7,"login":"ada","name":null,"avatar_url":"https://x/a.png","bio":"Math"},
         "connectedServices":["anthropic"]}
        """)
        await engine.run(.profile)
        var profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.displayName, "Ada")
        XCTAssertEqual(profile.github?.login, "ada")
        XCTAssertEqual(profile.avatarURL, "https://x/a.png")
        XCTAssertEqual(profile.bio, "Math")
        XCTAssertEqual(profile.connectedServices, ["anthropic"])

        await engine.handle(UpdateContainer(id: "u", seq: 1, body: .updateAccount(UpdateAccountUpdate(id: "u1", lastName: .some("Lovelace"))), createdAt: 200))
        profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.displayName, "Ada Lovelace")
        XCTAssertEqual(profile.timestamp, 200)
    }

    // MARK: Projects

    func testProjectsAreFetchedForTheSessionsThatNameThemAndDecrypted() async throws {
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        var a = decoder.session(fixture.session("a", updatedAt: 1))
        a.projectId = "p1"
        var b = decoder.session(fixture.session("b", updatedAt: 1))
        b.projectId = "p2"
        try store.upsertSessions([a, b])

        let keyed = APIProject(
            id: "p1", externalId: "e1", metadata: fixture.seal(.object(["name": .string("Keyed")])), metadataVersion: 1,
            dataEncryptionKey: fixture.wrappedKey, createdAt: 1, updatedAt: 1
        )
        let legacy = APIProject(
            id: "p2", externalId: "e2", metadata: try account.encrypt(.object(["name": .string("Legacy")])), metadataVersion: 1,
            dataEncryptionKey: nil, createdAt: 1, updatedAt: 1
        )
        http.on("GET /v1/projects") { _ in
            (200, Data(#"{"projects":[\#(String(decoding: try JSONEncoder().encode(keyed), as: UTF8.self)),{"broken":true},\#(String(decoding: try JSONEncoder().encode(legacy), as: UTF8.self))]}"#.utf8))
        }
        await engine.run(.projects)
        XCTAssertEqual(http.requests("GET /v1/projects").first?.query("ids"), "p1,p2")
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: try store.projects().map { ($0.id, $0.name) }), ["p1": "Keyed", "p2": "Legacy"])

        await engine.handle(UpdateContainer(id: "u", seq: 1, body: .updateProject(projectId: "p1"), createdAt: 1))
        await engine.waitForIdle()
        XCTAssertEqual(http.requests("GET /v1/projects").count, 2, "a project update refetches")

        await engine.handle(UpdateContainer(id: "u", seq: 2, body: .deleteProject(projectId: "p1"), createdAt: 1))
        XCTAssertEqual(try store.projects().map(\.id), ["p2"])
        XCTAssertNil(try store.session(id: "a")?.projectId)
    }

    func testNoReferencedProjectsMeansNoRequest() async throws {
        await engine.run(.projects)
        XCTAssertTrue(http.requests("GET /v1/projects").isEmpty)
    }

    // MARK: Activity

    func testActivityEphemeralsDriveThinkingAndUnread() async throws {
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        await engine.handle(.activity(sessionId: "s", active: true, activeAt: 10, thinking: true))
        XCTAssertEqual(try store.session(id: "s")?.thinking, true)
        await engine.handle(.activity(sessionId: "s", active: true, activeAt: 20, thinking: false))
        XCTAssertEqual(try store.session(id: "s")?.unread, true)
    }
}

/// A computer at the other end of `rpc-call`, sealing with the session key.
final class FakeRPC: RPCTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [(method: String, params: String)] = []
    var answer: @Sendable (String) throws -> RPCCallResult = { _ in RPCCallResult(ok: false, error: "offline") }

    var calls: [(method: String, params: String)] {
        lock.lock()
        defer { lock.unlock() }
        return _calls
    }

    func call(method: String, params: String) async throws -> RPCCallResult {
        let answer = lock.withLock {
            _calls.append((method, params))
            return self.answer
        }
        return try answer(method)
    }
}

final class SessionActionsTests: XCTestCase {
    var fixture: ServerFixture!
    var http: FakeHTTP!
    var store: LocalStore!
    var engine: SyncEngine!
    var rpc: FakeRPC!
    var actions: SessionActions!

    override func setUpWithError() throws {
        fixture = ServerFixture()
        http = FakeHTTP()
        store = try LocalStore.inMemory()
        engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        rpc = FakeRPC()
        actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: rpc, now: { 500 })
    }

    override func tearDown() async throws {
        await engine.stop()
    }

    private func storeSession(_ id: String = "s", bot: Bool = false) throws {
        var record = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session(id, updatedAt: 1))
        if bot { record.metadata = .object(["bot": .object(["id": .string("b1")])]) }
        try store.upsertSessions([record])
    }

    func testArchiveAsksTheComputerToStopTheSession() async throws {
        try storeSession()
        let key = fixture.dataKey
        rpc.answer = { _ in RPCCallResult(ok: true, result: try RecordCipher(key: key).encrypt(.object(["success": .bool(true)]))) }
        try await actions.archive(sessionId: "s")

        let call = try XCTUnwrap(rpc.calls.first)
        XCTAssertEqual(call.method, "s:killSession")
        XCTAssertEqual(RecordCipher(key: key).decrypt(base64: call.params), .object([:]))
        XCTAssertTrue(http.requests.isEmpty, "the server hears it from the computer")
        XCTAssertEqual(try store.session(id: "s")?.archiving, true, "stays out of the list until the server agrees")
    }

    func testAnUnreachableComputerFallsBackToTheServer() async throws {
        try storeSession()
        http.onRaw("POST /v1/sessions/s/archive", #"{"success":true}"#)
        try await actions.archive(sessionId: "s")
        XCTAssertEqual(http.requests("POST /v1/sessions/s/archive").count, 1)
        let stored = try XCTUnwrap(try store.session(id: "s"))
        XCTAssertFalse(stored.active)
        XCTAssertFalse(stored.archiving, "settled by the local inactive mark")
        XCTAssertTrue(stored.isArchived)
    }

    func testAFailedArchivePutsTheRowBack() async throws {
        try storeSession()
        http.onRaw("POST /v1/sessions/s/archive", "nope", status: 500)
        do {
            try await actions.archive(sessionId: "s")
            XCTFail("expected an error")
        } catch {}
        XCTAssertEqual(try store.session(id: "s")?.archiving, false)
        XCTAssertEqual(try store.session(id: "s")?.isArchived, false)
    }

    func testABotNeedsItsMachine() async throws {
        try storeSession(bot: true)
        do {
            try await actions.archive(sessionId: "s")
            XCTFail("expected an error")
        } catch let error as SessionActionError {
            XCTAssertEqual(error, .botNeedsMachine)
        }
        XCTAssertTrue(http.requests.isEmpty)
        XCTAssertEqual(try store.session(id: "s")?.archiving, false)
    }

    func testUnknownSession() async {
        do {
            try await actions.archive(sessionId: "missing")
            XCTFail("expected an error")
        } catch let error as SessionActionError {
            XCTAssertEqual(error, .unknownSession)
        } catch {
            XCTFail("\(error)")
        }
    }

    func testDeleteRemovesItEverywhere() async throws {
        try storeSession()
        http.onRaw("DELETE /v1/sessions/s", #"{"success":true}"#)
        try await actions.delete(sessionId: "s")
        XCTAssertNil(try store.session(id: "s"))
    }

    func testPermissionRequestsLeaveOutWhatWasNotSet() {
        XCTAssertEqual(
            SessionActions.permission(id: "p", approved: true, mode: nil, allowedTools: nil, decision: nil, updatedInput: nil),
            .object(["id": .string("p"), "approved": .bool(true)])
        )
        XCTAssertEqual(
            SessionActions.permission(id: "p", approved: false, mode: "plan", allowedTools: ["Bash"], decision: .abort, updatedInput: nil),
            .object([
                "id": .string("p"),
                "approved": .bool(false),
                "mode": .string("plan"),
                "allowTools": .array([.string("Bash")]),
                "decision": .string("abort"),
            ])
        )
    }

    func testMarkRead() throws {
        try storeSession()
        try store.applySessionActivity(id: "s", active: true, activeAt: 2, thinking: true)
        try store.applySessionActivity(id: "s", active: true, activeAt: 3)
        XCTAssertEqual(try store.session(id: "s")?.unread, true)
        actions.markRead(sessionId: "s")
        XCTAssertEqual(try store.session(id: "s")?.unread, false)
    }
}
