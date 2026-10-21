import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

private actor ReadinessProbe {
    var refreshes = 0
    var sleeps: [Duration] = []
    let readyAt: Int?

    init(readyAt: Int?) { self.readyAt = readyAt }
    func ready() -> Bool { readyAt.map { refreshes >= $0 } ?? false }
    func refresh() { refreshes += 1 }
    func sleep(_ duration: Duration) async throws {
        sleeps.append(duration)
        if duration == .seconds(4) { try await Task.sleep(for: duration) }
    }
}

private final class PullCounter: @unchecked Sendable {
    let lock = NSLock()
    var count = 0
    func next() -> Int {
        lock.withLock {
            count += 1
            return count
        }
    }
}

private actor UploadLease {
    var calls: [Bool] = []
    func record(_ value: Bool) { calls.append(value) }
}

private actor StopAfterUploadTransport: HTTPTransport {
    let http: FakeHTTP
    var sync: SyncEngine?

    init(http: FakeHTTP) { self.http = http }

    func configure(_ sync: SyncEngine) { self.sync = sync }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let response = try await http.send(request)
        if request.method == "PUT" {
            let active = sync
            sync = nil
            await active?.stop()
        }
        return response
    }
}

final class OpsCreationTests: XCTestCase {
    func testReadyFirstTryMakesNoRefresh() async throws {
        let probe = ReadinessProbe(readyAt: 0)
        try await SessionReadiness.ensure(isReady: { await probe.ready() }, refresh: { await probe.refresh() }, sleep: { try await probe.sleep($0) })
        let refreshes = await probe.refreshes
        XCTAssertEqual(refreshes, 0)
    }

    func testReadyOnRoundTwoBacksOffOnce() async throws {
        let probe = ReadinessProbe(readyAt: 2)
        try await SessionReadiness.ensure(isReady: { await probe.ready() }, refresh: { await probe.refresh() }, sleep: { try await probe.sleep($0) })
        let refreshes = await probe.refreshes
        let sleeps = await probe.sleeps
        XCTAssertEqual(refreshes, 2)
        XCTAssertEqual(sleeps.filter { $0 != .seconds(4) }, [.milliseconds(300)])
    }

    func testNotReadyAfterThreeRoundsThrowsVerbatimCopy() async throws {
        let probe = ReadinessProbe(readyAt: nil)
        do {
            try await SessionReadiness.ensure(isReady: { await probe.ready() }, refresh: { await probe.refresh() }, sleep: { try await probe.sleep($0) })
            XCTFail("must fail after three rounds")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The message was not sent: this session has not finished syncing. Please try again.")
        }
        let refreshes = await probe.refreshes
        let sleeps = await probe.sleeps
        XCTAssertEqual(refreshes, 3)
        XCTAssertEqual(sleeps.filter { $0 != .seconds(4) }, [.milliseconds(300), .milliseconds(600)])
    }

    func testTimeoutCancelsOnlyTheWaiterAndSharedSyncKeepsRunning() async throws {
        let job = InvalidateSync { try await Task.sleep(for: .seconds(60)) }
        await job.invalidate()
        do {
            try await SessionReadiness.ensure(isReady: { false }, refresh: { await job.invalidateAndAwait() }, sleep: { _ in })
            XCTFail("must time out")
        } catch { XCTAssertEqual(error as? SessionReadinessError, .notReady) }
        let running = await job.isRunning
        XCTAssertTrue(running, "timed-out wait must not stop the shared sessions job")
        await job.stop()
    }

    func testSyncEngineWaitsForMetadataAndBothKeysOnSecondPull() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        let http = FakeHTTP()
        let counter = PullCounter()
        let row = fixture.session("new", updatedAt: 2)
        http.on("GET /v2/sessions") { _ in
            let rows = counter.next() == 1 ? [] : [row]
            return (200, try JSONEncoder().encode(SessionsPage(sessions: rows, nextCursor: nil, hasNext: false)))
        }
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, sleep: { duration in
            if duration == .seconds(4) { try await Task.sleep(for: duration) }
        })
        let actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: FakeRPC())
        try await actions.ensureSessionReady(sessionId: "new")
        XCTAssertEqual(http.requests("GET /v2/sessions").count, 2)
        XCTAssertNotNil(try store.session(id: "new")?.metadata)
        try await actions.ensureSessionReady(sessionId: "new")
        XCTAssertEqual(http.requests("GET /v2/sessions").count, 2, "already-ready sessions need no new pull")
        await engine.stop()
    }

    func testBlobUploadUsesSharedKeyAndDifferentWireVersusResultSizes() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", #"{"ref":"face","uploadUrl":"https://blob.example/upload","method":"PUT"}"#)
        http.onRaw("PUT /upload", "")
        let lease = UploadLease()
        var options = SyncEngine.Options()
        options.deliveryActivity = { await lease.record($0) }
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options)
        let actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: FakeRPC())
        let bytes = Data([0, 10, 255, 13])
        let result = try await actions.uploadSessionBlob(sessionId: "s", name: "face.png", bytes: bytes)
        XCTAssertEqual(result.ref, "face")
        XCTAssertEqual(result.size, bytes.count)
        let request = try XCTUnwrap(http.requests("POST /v1/sessions/s/attachments/request-upload").first)
        XCTAssertEqual(try request.jsonBody(JSONValue.self), .object(["filename": .string("face.png"), "size": .number(44)]))
        let upload = try XCTUnwrap(http.requests("PUT /upload").first)
        XCTAssertEqual(upload.headers, ["Content-Type": "application/octet-stream"])
        XCTAssertEqual(upload.url.host, "blob.example")
        XCTAssertEqual(BlobCipher.open(try XCTUnwrap(upload.body), key: BlobCipher.sessionKey(dataKey: fixture.dataKey)), bytes)
        let calls = await lease.calls
        XCTAssertEqual(calls, [true, false])
        await engine.stop()
    }

    func testBlobUploadFailureReleasesLeaseAndNoKeyMakesNoHTTPCall() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", "offline", status: 503)
        let lease = UploadLease()
        var options = SyncEngine.Options()
        options.deliveryActivity = { await lease.record($0) }
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys, options: options)
        do {
            _ = try await engine.uploadSessionBlob(sessionId: "s", name: "face.png", bytes: Data([1]))
            XCTFail("must report upload failure")
        } catch { XCTAssertEqual(error as? APIError, .http(status: 503, body: "offline")) }
        let calls = await lease.calls
        XCTAssertEqual(calls, [true, false])
        do {
            _ = try await engine.uploadSessionBlob(sessionId: "missing", name: "face.png", bytes: Data([1]))
            XCTFail("must require own blob key")
        } catch { XCTAssertEqual(error as? SessionActionError, .notDecryptable) }
        XCTAssertEqual(http.requests.count, 1)
        await engine.stop()
    }

    func testAccountStopDuringBlobUploadReleasesLeaseAndRefusesLateSuccess() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        try store.upsertSessions([RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))])
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", #"{"ref":"face","uploadUrl":"https://blob.example/upload","method":"PUT"}"#)
        http.onRaw("PUT /upload", "")
        let transport = StopAfterUploadTransport(http: http)
        let lease = UploadLease()
        var options = SyncEngine.Options()
        options.deliveryActivity = { await lease.record($0) }
        let engine = SyncEngine(
            api: HappyAPI(serverURL: URL(string: "https://example.test")!, clientID: "test", transport: transport)
                .authenticated(token: "token"), store: store, keys: fixture.keys, options: options
        )
        await transport.configure(engine)
        do {
            _ = try await engine.uploadSessionBlob(sessionId: "s", name: "face.png", bytes: Data([1]))
            XCTFail("late upload success cannot cross account stop")
        } catch { XCTAssertTrue(error is CancellationError, String(describing: error)) }
        let calls = await lease.calls
        XCTAssertEqual(calls, [true, false])
    }
}
