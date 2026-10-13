import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// What the tablet sidebar's checkout headings read of git: only statuses
/// already fetched, told again only when a heading would change, and a
/// refresh on a new message only for the checkouts the headings show.
final class GitHeadingStatusTests: XCTestCase {
    let repo = GitCheckoutKey(machineId: "m", path: "/repo")

    private func make(_ paths: [String: String]) throws -> (GitStatusSync, HeadingRPC, SyncEngine) {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        for (id, path) in paths {
            var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session(id, updatedAt: 1))
            session.metadata = .object(["machineId": .string("m"), "path": .string(path)])
            try store.upsertSessions([session])
        }
        let http = FakeHTTP()
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        let rpc = HeadingRPC(key: fixture.dataKey)
        let actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: rpc)
        return (GitStatusSync(actions: actions, store: store), rpc, engine)
    }

    private func waitUntil(_ condition: @Sendable () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<300 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out", file: file, line: line)
    }

    func testHeadingsReadWhatWasFetchedAndOnlyWhatTheyShow() async throws {
        let (git, rpc, engine) = try make(["a": "/repo", "b": "/repo"])
        let seen = Seen()
        let stream = await git.headingStatuses()
        let reader = Task { for await value in stream { await seen.append(value) } }
        try await waitUntil { await seen.values == [[:]] }
        // Following asks no computer for anything.
        try await Task.sleep(for: .milliseconds(50))
        let quiet = await rpc.calls.count
        XCTAssertEqual(quiet, 0)

        await git.refresh(sessionId: "a")
        let first = GitHeadingStatus(branch: "main", unstagedLinesAdded: 2, unstagedLinesRemoved: 1)
        try await waitUntil { await seen.values.count == 2 }
        let afterFirst = await seen.values.last
        XCTAssertEqual(afterFirst, [repo: first])

        // Only the staged lines changed: no heading shows those.
        await rpc.set(staged: "7\t3\tsrc/file with spaces.swift")
        await git.refresh(sessionId: "a")
        try await Task.sleep(for: .milliseconds(50))
        let afterStaged = await seen.values.count
        XCTAssertEqual(afterStaged, 2)

        // Either chat of the checkout fetches it for both.
        await rpc.set(branch: "feature")
        await git.refresh(sessionId: "b")
        try await waitUntil { await seen.values.count == 3 }
        let afterBranch = await seen.values.last
        XCTAssertEqual(afterBranch, [repo: GitHeadingStatus(branch: "feature", unstagedLinesAdded: 2, unstagedLinesRemoved: 1)])

        // Deleting one chat keeps the checkout's status; deleting the last
        // clears it.
        await git.clearForSession(sessionId: "a")
        try await Task.sleep(for: .milliseconds(50))
        let afterOne = await seen.values.count
        XCTAssertEqual(afterOne, 3)
        await git.clearForSession(sessionId: "b")
        try await waitUntil { await seen.values.count == 4 }
        let cleared = await seen.values.last
        XCTAssertEqual(cleared, [:])

        // An account switch ends the stream.
        await git.stop()
        await reader.value
        await engine.stop()
    }

    func testAMessageRefreshesOnlyAShownCheckout() async throws {
        let (git, rpc, engine) = try make(["a": "/repo", "c": "/other"])
        var headings = await git.headingStatuses().makeAsyncIterator()
        let initial = await headings.next()
        XCTAssertEqual(initial, [:])

        // Nobody observes or shows it: a message fetches nothing.
        await git.invalidate(sessionId: "a")
        try await Task.sleep(for: .milliseconds(400))
        let unseen = await rpc.calls.count
        XCTAssertEqual(unseen, 0)

        var interest: GitCheckoutInterest? = git.interest()
        interest?.set([repo])
        try await waitUntil { [repo] in await git.interestedCheckouts == [repo] }
        await git.invalidate(sessionId: "c")
        await git.invalidate(sessionId: "a")
        let refreshed = await headings.next()
        XCTAssertEqual(refreshed, [repo: GitHeadingStatus(branch: "main", unstagedLinesAdded: 2, unstagedLinesRemoved: 1)])
        let calls = await rpc.calls
        XCTAssertEqual(calls.count, 4)
        XCTAssertTrue(calls.allSatisfy { $0.0 == "a:bash" && $0.1["cwd"] == .string("/repo") })

        // Withdrawn when released; the chat was never taken as observed, so
        // its next message fetches nothing.
        interest = nil
        try await waitUntil { await git.interestedCheckouts.isEmpty }
        await git.invalidate(sessionId: "a")
        try await Task.sleep(for: .milliseconds(400))
        let after = await rpc.calls.count
        XCTAssertEqual(after, 4)
        await git.stop()
        await engine.stop()
    }

    func testWithdrawingACheckoutCancelsItsPendingRefresh() async throws {
        let (git, rpc, engine) = try make(["a": "/repo"])
        let interest = git.interest()
        interest.set([repo])
        try await waitUntil { [repo] in await git.interestedCheckouts == [repo] }
        await git.invalidate(sessionId: "a")
        // The sidebar regroups before the 300ms debounce ends.
        interest.set([GitCheckoutKey(machineId: "m", path: "/elsewhere")])
        try await waitUntil { await git.interestedCheckouts == [GitCheckoutKey(machineId: "m", path: "/elsewhere")] }
        try await Task.sleep(for: .milliseconds(400))
        let calls = await rpc.calls.count
        XCTAssertEqual(calls, 0)
        await git.stop()
        await engine.stop()
    }

    func testAShownCheckoutOutlivesItsChatClosing() async throws {
        let (git, rpc, engine) = try make(["a": "/repo"])
        let interest = git.interest()
        interest.set([repo])
        try await waitUntil { [repo] in await git.interestedCheckouts == [repo] }
        // The chat screen observes it, a message arrives, then it closes.
        var observed: AsyncStream<GitStatus?>.Iterator? = await git.observe(sessionId: "a").makeAsyncIterator()
        _ = await observed?.next()
        await git.invalidate(sessionId: "a")
        observed = nil
        await git.stop(sessionId: "a")
        try await waitUntil { await rpc.calls.count == 4 }
        await git.stop()
        await engine.stop()
    }
}

/// The grouped sidebar's swipe on a chat only stops it (CompactSessionRow).
final class TabletChatArchiveTests: XCTestCase {
    func testKillOnlyAndItsMessages() async {
        let ops = KillOps()
        await ops.answer(.success(SessionKillResponse(success: true, message: "")))
        let killed = await TabletChatArchive.run(ops, sessionId: "s1")
        XCTAssertEqual(killed, .killed)
        await ops.answer(.success(SessionKillResponse(success: false, message: "Session not found")))
        let refused = await TabletChatArchive.run(ops, sessionId: "s2")
        XCTAssertEqual(refused, .refused("Session not found"))
        // `result.message || t('sessionInfo.failedToArchiveSession')`.
        await ops.answer(.success(SessionKillResponse(success: false, message: "")))
        let silent = await TabletChatArchive.run(ops, sessionId: "s3")
        XCTAssertEqual(silent, .refused(nil))
        await ops.answer(.failure(Offline()))
        let failed = await TabletChatArchive.run(ops, sessionId: "s4")
        XCTAssertEqual(failed, .failed)
        let kills = await ops.kills
        let archives = await ops.archives
        XCTAssertEqual(kills, ["s1", "s2", "s3", "s4"])
        // Never the server archive the flat row's swipe adds.
        XCTAssertEqual(archives, [])
    }
}

private struct Offline: Error {}

private actor Seen {
    var values: [[GitCheckoutKey: GitHeadingStatus]] = []
    func append(_ value: [GitCheckoutKey: GitHeadingStatus]) { values.append(value) }
}

private actor HeadingRPC: RPCTransport {
    let key: Data
    var branch = "main"
    var staged = ""
    var calls: [(String, JSONValue)] = []

    init(key: Data) {
        self.key = key
    }

    func set(branch: String? = nil, staged: String? = nil) {
        if let branch { self.branch = branch }
        if let staged { self.staged = staged }
    }

    func call(method: String, params: String) async throws -> RPCCallResult {
        let cipher = RecordCipher(key: key)
        let request = try XCTUnwrap(cipher.decrypt(base64: params))
        calls.append((method, request))
        let command = request["command"]?.stringValue ?? ""
        let stdout = if command.hasPrefix("git rev-parse") {
            "true"
        } else if command.contains("status --porcelain") {
            "# branch.head \(branch)\n1 MM N... 100644 100644 100644 abc def src/file with spaces.swift"
        } else if command.contains("--cached") {
            staged
        } else {
            "2\t1\tsrc/file with spaces.swift"
        }
        return RPCCallResult(ok: true, result: try cipher.encrypt(.object([
            "success": .bool(true), "stdout": .string(stdout), "stderr": .string(""), "exitCode": .number(0),
        ])))
    }
}

private actor KillOps: HomeSessionOps {
    var kills: [String] = []
    var archives: [String] = []
    private var next: Result<SessionKillResponse, Error> = .success(SessionKillResponse(success: true, message: ""))

    func answer(_ result: Result<SessionKillResponse, Error>) { next = result }

    func sessionKill(sessionId: String) async throws -> SessionKillResponse {
        kills.append(sessionId)
        return try next.get()
    }

    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
    func archive(sessionId: String) async throws { archives.append(sessionId) }
    func ensureSessionReady(sessionId: String) async throws {}
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { ("", 0) }
}
