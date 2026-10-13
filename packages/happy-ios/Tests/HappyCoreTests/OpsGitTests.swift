import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

final class OpsGitTests: XCTestCase {
    let ordinary = "1 MM N... 100644 100644 100644 abc def src/file with spaces.swift"

    func testSeparateIndexAndWorktreeStatsAndBranchTracking() {
        let status = GitStatusParser.parse(
            status: "# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n# stash 4\n\(ordinary)\n? new.txt\n",
            unstagedNumstat: "2\t1\tsrc/file with spaces.swift\n", stagedNumstat: "7\t3\tsrc/file with spaces.swift\n", now: 42
        )
        XCTAssertEqual(status.branch, "main")
        XCTAssertEqual(status.upstreamBranch, "origin/main")
        XCTAssertEqual(status.aheadCount, 2)
        XCTAssertEqual(status.behindCount, 3)
        XCTAssertEqual(status.stashCount, 4)
        XCTAssertEqual(status.modifiedCount, 1)
        XCTAssertEqual(status.stagedCount, 1)
        XCTAssertEqual(status.untrackedCount, 1)
        XCTAssertEqual(status.stagedFiles.first?.fileName, "file with spaces.swift")
        XCTAssertEqual(status.stagedFiles.first?.filePath, "src")
        XCTAssertEqual(status.stagedLinesAdded, 7)
        XCTAssertEqual(status.unstagedLinesAdded, 2)
        XCTAssertEqual(status.linesRemoved, 4)
        XCTAssertEqual(status.linesChanged, 13)
        XCTAssertEqual(status.lastUpdatedAt, 42)
        XCTAssertTrue(status.isDirty)
    }

    func testGitQuotesOctalUnicodeRenamesAndBinaryStats() {
        let path = #""caf\303\251\t\".txt""#
        XCTAssertEqual(GitStatusParser.decodePath(path), "café\t\".txt")
        let status = GitStatusParser.parse(
            status: "2 R. N... 100644 100644 100644 abc def R100 new/file.txt\told/file.txt\n1 .M N... 100644 100644 100644 abc def \(path)\n",
            unstagedNumstat: "-\t-\t\(path)\n", stagedNumstat: "5\t2\t{old => new}/file.txt"
        )
        XCTAssertEqual(status.stagedFiles.first?.fullPath, "new/file.txt")
        XCTAssertEqual(status.stagedFiles.first?.oldPath, "old/file.txt")
        XCTAssertEqual(status.stagedFiles.first?.status, .renamed)
        XCTAssertEqual(status.stagedLinesAdded, 5)
        XCTAssertEqual(status.unstagedFiles.first?.fullPath, "café\t\".txt")
        XCTAssertEqual(status.unstagedLinesAdded, 0)
    }

    func testConflictsDetachedAndMalformedLines() {
        let status = GitStatusParser.parse(status: "# branch.head (detached)\nu UU N... 100644 100644 100644 100644 abc def fed conflicted.txt\n1 broken\n! ignored.txt\n? dir/\n")
        XCTAssertNil(status.branch)
        XCTAssertNil(status.aheadCount)
        XCTAssertTrue(status.isDirty)
        XCTAssertEqual(status.stagedFiles.first?.fullPath, "conflicted.txt")
        XCTAssertEqual(status.unstagedFiles.count, 1)
        XCTAssertEqual(status.modifiedCount, 0)
        XCTAssertEqual(GitStatusParser.parse(status: "# branch.head (initial)").branch, nil)
    }

    func testSharedCheckoutRefreshAndOfflineRetainsSnapshot() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        for id in ["a", "b"] {
            var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session(id, updatedAt: 1))
            session.metadata = .object(["machineId": .string("m"), "path": .string("/repo")])
            try store.upsertSessions([session])
        }
        let http = FakeHTTP()
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        let rpc = GitRPC(key: fixture.dataKey, outputs: ["true", "# branch.head main\n\(ordinary)", "2\t1\tsrc/file with spaces.swift", "7\t3\tsrc/file with spaces.swift"])
        let actions = SessionActions(api: testAPI(http), store: store, sync: engine, rpc: rpc)
        let git = GitStatusSync(actions: actions, store: store)
        var a = await git.observe(sessionId: "a").makeAsyncIterator()
        var b = await git.observe(sessionId: "b").makeAsyncIterator()
        _ = await a.next()
        _ = await b.next()
        let result = await git.refresh(sessionId: "a")
        let seenA = await a.next()
        let seenB = await b.next()
        XCTAssertEqual(seenA!, result)
        XCTAssertEqual(seenB!, result)
        let calls = await rpc.calls
        XCTAssertEqual(calls.map { $0.1["command"]?.stringValue }, [
            "git rev-parse --is-inside-work-tree",
            "git -c core.quotepath=false status --porcelain=v2 --branch --show-stash --untracked-files=all",
            "git -c core.quotepath=false diff --numstat", "git -c core.quotepath=false diff --cached --numstat",
        ])
        XCTAssertTrue(calls.allSatisfy { $0.0 == "a:bash" && $0.1["cwd"] == .string("/repo") })
        XCTAssertEqual(calls.first?.1["timeout"], .number(5000))
        XCTAssertEqual(calls.last?.1["timeout"], .number(10000))
        let offline = await git.refresh(sessionId: "b")
        XCTAssertEqual(offline, result)
        await git.stop()
        let done = await a.next()
        XCTAssertNil(done)
        await engine.stop()
    }
}

private actor GitRPC: RPCTransport {
    let key: Data
    var outputs: [String]
    var calls: [(String, JSONValue)] = []
    init(key: Data, outputs: [String]) {
        self.key = key
        self.outputs = outputs
    }
    func call(method: String, params: String) async throws -> RPCCallResult {
        let cipher = RecordCipher(key: key)
        calls.append((method, try XCTUnwrap(cipher.decrypt(base64: params))))
        guard !outputs.isEmpty else { return RPCCallResult(ok: false, error: "offline") }
        let stdout = outputs.removeFirst()
        return RPCCallResult(ok: true, result: try cipher.encrypt(.object(["success": .bool(true), "stdout": .string(stdout), "stderr": .string(""), "exitCode": .number(0)])))
    }
}
