import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

private actor GitSettledProbe: RPCTransport {
    let cipher: RecordCipher
    var started = false
    var completed = false
    var gate: CheckedContinuation<Void, Never>?

    init(key: Data) { cipher = RecordCipher(key: key) }

    func call(method: String, params: String) async throws -> RPCCallResult {
        if method.hasSuffix(":readFileAtRevision") { throw SessionActionError.failed("base read failed") }
        started = true
        await withCheckedContinuation { gate = $0 }
        return RPCCallResult(ok: true, result: try cipher.encrypt(.object([
            "success": .bool(true), "content": .string(""), "hash": .string(String(repeating: "a", count: 64)),
        ])))
    }

    func release() {
        gate?.resume()
        gate = nil
    }

    func finish() { completed = true }
}

final class OpsHappyAgentGitTests: XCTestCase {
    let base = String(repeating: "a", count: 40)
    // Not `hash`: XCTestCase is an NSObject on Darwin, which has `hash: Int`.
    let contentHash = String(repeating: "b", count: 64)
    var store: LocalStore!
    var fixture: ServerFixture!
    var rpc: FakeRPC!
    var sync: SyncEngine!
    var actions: SessionActions!

    var native: JSONValue {
        .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "capabilities": .object([
                "files": .object(["read": .bool(true)]),
                "rpcMethods": .array(["gitState", "readFile", "readFileAtRevision"].map(JSONValue.string)),
            ]),
        ])
    }

    override func setUpWithError() throws {
        fixture = ServerFixture()
        store = try LocalStore.inMemory()
        let api = testAPI(FakeHTTP())
        sync = SyncEngine(api: api, store: store, keys: fixture.keys)
        rpc = FakeRPC()
        actions = SessionActions(api: api, store: store, sync: sync, rpc: rpc)
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))
        session.metadata = native
        try store.upsertSessions([session])
    }

    override func tearDown() async throws { await sync.stop() }

    func file(status: HappyAgentGitFileStatus = .modified, path: String = "src/file.ts",
              previous: String? = nil, binary: Bool = false) throws -> HappyAgentGitFile {
        var raw: [String: JSONValue] = [
            "path": .string(path), "status": .string(status.rawValue), "staged": .bool(false),
            "unstaged": .bool(false), "binary": .bool(binary), "extra": .number(9),
        ]
        if let previous { raw["previousPath"] = .string(previous) }
        return try HappyAgentGitFile(.object(raw))
    }

    func answer(_ response: JSONValue) {
        let cipher = RecordCipher(key: fixture.dataKey)
        rpc.answer = { _ in RPCCallResult(ok: true, result: try cipher.encrypt(response)) }
    }

    func contents(old: Data = Data(), new: Data = Data()) {
        encoded(old: old.base64EncodedString(), new: new.base64EncodedString())
    }

    func encoded(old: String = "", new: String = "") {
        let cipher = RecordCipher(key: fixture.dataKey)
        let hash = contentHash
        rpc.answer = { method in
            let after = method.hasSuffix(":readFile")
            var response: [String: JSONValue] = ["success": .bool(true), "content": .string(after ? new : old)]
            if after { response["hash"] = .string(hash) }
            return RPCCallResult(ok: true, result: try cipher.encrypt(.object(response)))
        }
    }

    func assertError(_ expected: String, operation: () async throws -> Void) async {
        do { try await operation(); XCTFail("expected refusal") }
        catch { XCTAssertEqual(error as? SessionActionError, .failed(expected)) }
    }

    func testCapabilityRequiresV1ReadableFilesAndAllThreeMethods() async throws {
        XCTAssertTrue(SessionActions.supportsHappyAgentGit(native))
        for version in [JSONValue.null, .number(0)] {
            var metadata = native.objectValue!
            metadata["rigMetadataVersion"] = version
            XCTAssertFalse(SessionActions.supportsHappyAgentGit(.object(metadata)))
        }
        var metadata = native.objectValue!
        metadata["capabilities"] = .object(["files": .object(["read": .bool(false)]),
                                            "rpcMethods": native["capabilities"]!["rpcMethods"]!])
        XCTAssertFalse(SessionActions.supportsHappyAgentGit(.object(metadata)))
        metadata["capabilities"] = .object(["files": .object(["read": .bool(true)]),
                                            "rpcMethods": .array([.string("gitState"), .string("readFile")])])
        XCTAssertFalse(SessionActions.supportsHappyAgentGit(.object(metadata)))
        var session = try XCTUnwrap(store.session(id: "s"))
        session.metadata = .object(metadata)
        session.metadataVersion += 1
        try store.upsertSessions([session])
        await assertError("Git changes are not available for this session.") {
            _ = try await self.actions.getHappyAgentGitState(sessionId: "s")
        }
        XCTAssertTrue(rpc.calls.isEmpty)
    }

    func state() throws -> JSONValue {
        .object([
            "facts": .object(["branch": .string("feature"), "detached": .bool(false), "head": .string(base),
                              "upstream": .null, "ahead": .number(1), "behind": .number(2), "future": .number(3)]),
            "comparison": .string("ready"), "base": .string(base), "changedFiles": .number(1),
            "insertions": .number(3), "deletions": .number(1), "countsExact": .bool(true),
            "conflicted": .bool(false), "files": .array([try file().raw]), "filesTruncated": .bool(false),
            "scannedAt": .number(123), "future": .string("preserved"),
        ])
    }

    func testStateEmptyRequestPreservesCommittedFilesAndPassthroughFields() async throws {
        let raw = try state()
        answer(.object(["success": .bool(true), "git": raw]))
        let result = try await actions.getHappyAgentGitState(sessionId: "s")
        XCTAssertEqual(result.raw, raw)
        XCTAssertEqual(result.files.count, 1)
        XCTAssertFalse(result.files[0].staged)
        XCTAssertFalse(result.files[0].unstaged)
        XCTAssertEqual(result.facts.ahead, 1)
        XCTAssertEqual(result.facts.raw["future"], .number(3))
        let call = try XCTUnwrap(rpc.calls.last)
        XCTAssertEqual(call.method, "s:gitState")
        XCTAssertEqual(RecordCipher(key: fixture.dataKey).decrypt(base64: call.params), .object([:]))
        XCTAssertEqual(try opsJSON(result), raw)
    }

    func testStateFailureAndMalformedSchema() async throws {
        answer(.object(["success": .bool(false), "code": .string("unavailable"), "error": .string("Git is unavailable for this workspace.")]))
        await assertError("Git is unavailable for this workspace.") { _ = try await self.actions.getHappyAgentGitState(sessionId: "s") }
        for patch in [
            ["base": JSONValue.null], ["changedFiles": .number(-1)], ["comparison": .string("unknown")],
            ["files": .array([.object(["path": .string("bad")])])], ["base": .string(String(repeating: "A", count: 40))],
        ] {
            let malformed = JSONValue.object(try state().objectValue!.merging(patch) { _, value in value })
            answer(.object(["success": .bool(true), "git": malformed]))
            await assertError("Happy Agent returned an invalid Git state.") { _ = try await self.actions.getHappyAgentGitState(sessionId: "s") }
        }
        answer(.object(["success": .bool(false), "code": .string("unknown"), "error": .string("oops")]))
        await assertError("Happy Agent returned an invalid Git state.") { _ = try await self.actions.getHappyAgentGitState(sessionId: "s") }
    }

    func testRenameAddDeleteUseExactPathsAndMissingSidesStayEmptyText() async throws {
        contents(old: Data("before\n".utf8), new: Data("after\n".utf8))
        let renamed = try file(status: .renamed, path: "new/name.ts", previous: "old/name.ts")
        let result = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: renamed)
        XCTAssertEqual(result, .text(oldText: "before\n", newText: "after\n"))
        let calls = rpc.calls
        XCTAssertEqual(calls.count, 2)
        let cipher = RecordCipher(key: fixture.dataKey)
        let before = try XCTUnwrap(calls.first { $0.method == "s:readFileAtRevision" })
        let after = try XCTUnwrap(calls.first { $0.method == "s:readFile" })
        XCTAssertEqual(cipher.decrypt(base64: before.params), .object(["path": .string("old/name.ts"), "revision": .string(base)]))
        XCTAssertEqual(cipher.decrypt(base64: after.params), .object(["path": .string("new/name.ts")]))
        let added = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file(status: .added))
        XCTAssertEqual(added, .text(oldText: "", newText: "after\n"))
        let deleted = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file(status: .deleted))
        XCTAssertEqual(deleted, .text(oldText: "before\n", newText: ""))
        contents()
        let empty = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file())
        XCTAssertEqual(empty, .text(oldText: "", newText: ""))
    }

    func testUpfrontRefusalsMakeNoRPCAndImagesUseEachSidesMIME() async throws {
        for (status, message) in [
            (HappyAgentGitFileStatus.conflicted, "This file has unresolved conflicts and cannot be previewed."),
            (.submodule, "Submodule changes cannot be previewed."), (.type_changed, "This file changed type and cannot be previewed."),
        ] {
            let result = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file(status: status))
            XCTAssertEqual(result, .message(message))
        }
        let binary = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file(binary: true))
        XCTAssertEqual(binary, .message("Binary file changes cannot be previewed."))
        await assertError("Happy Agent returned an invalid Git comparison base.") {
            _ = try await self.actions.readHappyAgentGitFile(sessionId: "s", gitBase: "HEAD", file: self.file())
        }
        XCTAssertTrue(rpc.calls.isEmpty)
        encoded(old: "iVBORw0K", new: "R0lGODlh")
        let image = try await actions.readHappyAgentGitFile(
            sessionId: "s", gitBase: base, file: file(status: .renamed, path: "new.jpg", previous: "old.png", binary: true)
        )
        XCTAssertEqual(image, .image(before: "data:image/png;base64,iVBORw0K", after: "data:image/jpeg;base64,R0lGODlh"))
        contents()
        let empty = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file(status: .added, path: "empty.png", binary: true))
        XCTAssertEqual(empty, .message("Image content is empty."))
    }

    func testBase64WhitespacePaddingUTF8BOMNULAndSizeEdges() throws {
        for value in ["Z g\n", "Zg==", "Zm8", "", "77u/", "\u{feff}Zg=="] {
            XCTAssertNoThrow(try GitFileDecoding.inspect(value))
        }
        for value in ["a", "Zg=", "Z=g=", "====", "Zg===", "Zm8$", "-_=="] {
            XCTAssertThrowsError(try GitFileDecoding.inspect(value))
        }
        XCTAssertEqual(try GitFileDecoding.text(old: "", new: "77u/"), .text(oldText: "", newText: "\u{feff}"))
        for bytes: [UInt8] in [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]] {
            XCTAssertEqual(
                try GitFileDecoding.text(old: "", new: Data(bytes).base64EncodedString()),
                .message("This file is not valid UTF-8 text.")
            )
        }
        let retained = "\u{feff}\u{feff}\u{fffd}hello"
        XCTAssertEqual(
            try GitFileDecoding.text(old: "", new: Data(retained.utf8).base64EncodedString()),
            .text(oldText: "", newText: retained)
        )
        XCTAssertEqual(try GitFileDecoding.text(old: "", new: "YQBi"), .message("This file contains binary data and cannot be shown as text."))
        let limit = String(repeating: "x", count: 512 * 1024)
        XCTAssertEqual(try GitFileDecoding.text(old: "", new: Data(limit.utf8).base64EncodedString()), .text(oldText: "", newText: limit))
        XCTAssertThrowsError(try GitFileDecoding.inspect(Data((limit + "x").utf8).base64EncodedString())) { error in
            XCTAssertEqual(error as? SessionActionError, .failed("This file is too large to preview on the phone."))
        }
    }

    func testCombinedLineLimitIgnoresFinalNewline() throws {
        let half = String(repeating: "x\n", count: 10000)
        let encoded = Data(half.utf8).base64EncodedString()
        XCTAssertEqual(try GitFileDecoding.text(old: encoded, new: encoded), .text(oldText: half, newText: half))
        let tooMany = Data(String(repeating: "x\n", count: 20001).utf8).base64EncodedString()
        XCTAssertEqual(try GitFileDecoding.text(old: "", new: tooMany), .message("This file has too many lines to preview here."))
    }

    func testReadFailuresRejectInvalidHashContentAndNativeErrors() async throws {
        for response in [
            JSONValue.object(["success": .bool(true), "content": .number(7), "hash": .string(contentHash)]),
            .object(["success": .bool(true), "content": .string(""), "hash": .string("bad")]),
        ] {
            answer(response)
            await assertError("Happy Agent returned an invalid file response.") {
                _ = try await self.actions.readHappyAgentGitFile(sessionId: "s", gitBase: self.base, file: self.file(status: .added))
            }
        }
        answer(.object(["success": .bool(false), "code": .string("missing"), "error": .string("The file does not exist at this revision.")]))
        await assertError("The file does not exist at this revision.") {
            _ = try await self.actions.readHappyAgentGitFile(sessionId: "s", gitBase: self.base, file: self.file(status: .added))
        }
    }

    func testBothStartedReadsSettleBeforeBeforeErrorSurfaces() async throws {
        let probe = GitSettledProbe(key: fixture.dataKey)
        let actions = SessionActions(api: testAPI(FakeHTTP()), store: store, sync: sync, rpc: probe)
        let file = try file()
        let base = self.base
        let reading = Task {
            do {
                _ = try await actions.readHappyAgentGitFile(sessionId: "s", gitBase: base, file: file)
                await probe.finish()
                return nil as SessionActionError?
            } catch {
                await probe.finish()
                return error as? SessionActionError
            }
        }
        for _ in 0..<2000 {
            if await probe.started { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let started = await probe.started
        let completed = await probe.completed
        XCTAssertTrue(started)
        XCTAssertFalse(completed)
        await probe.release()
        let error = await reading.value
        XCTAssertEqual(error, .failed("base read failed"))
    }
}
