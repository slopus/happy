import Foundation
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire
import XCTest

private actor VoiceSendProbe: ChatSending {
    var sent: [(String, OutgoingMessage)] = []
    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String { sent.append((sessionId, message)); return "accepted" }
    func retry(localId: String) async throws {}
    func discard(localId: String) async throws {}
}

final class VoiceToolTests: XCTestCase {
    private func fixture() throws -> (VoiceContext, AccountSession, VoiceSendProbe, FakeRPC, ServerFixture) {
        let server = ServerFixture()
        let store = try LocalStore.inMemory()
        var record = RecordDecoder(keyRing: KeyRing(keys: server.keys)).session(server.session("s", updatedAt: 1))
        record.agentState = .object(["requests": .object(["permission": .object(["tool": .string("Bash")])])])
        try store.upsertSessions([record])
        let account = try AccountSession(credentials: Credentials(token: "token", secret: Data(repeating: 7, count: 32)), store: store,
                                         dependencies: .init(serverURL: URL(string: "https://example.test")!, clientID: "test", transport: FakeHTTP(), connector: FakeConnector()))
        let rpc = FakeRPC()
        rpc.answer = { _ in RPCCallResult(ok: true, result: server.seal(.null)) }
        let sync = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: server.keys)
        let actions = SessionActions(api: testAPI(FakeHTTP()), store: store, sync: sync, rpc: rpc)
        let sender = VoiceSendProbe()
        return (VoiceContext(account: account, sessionId: "s", sending: sender, actions: actions), account, sender, rpc, server)
    }

    func testSendToolUsesVoiceSourceAndRejectsUnknownSessionAndMalformedParameters() async throws {
        let (context, account, sender, rpc, _) = try fixture()
        let sent = await context.tool(name: "sendMessageToSession", parameters: Data(#"{"sessionId":"s","message":"implement it"}"#.utf8))
        XCTAssertFalse(sent.isError)
        let messages = await sender.sent
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.0, "s")
        XCTAssertEqual(messages.first?.1, OutgoingMessage(text: "implement it", source: .voice))
        for body in [#"{"sessionId":"unknown","message":"x"}"#, #"{"sessionId":"s","message":" "}"#, #"{"sessionId":12,"message":"x"}"#, #"{}"#] {
            let result = await context.tool(name: "sendMessageToSession", parameters: Data(body.utf8))
            XCTAssertTrue(result.isError)
        }
        let finalMessages = await sender.sent
        XCTAssertEqual(finalMessages.count, 1)
        XCTAssertTrue(rpc.calls.isEmpty)
        await context.stop(); await account.stop()
    }

    func testPermissionToolFindsOwnerAndUsesExistingEncryptedRPCAndRefusesStaleRequests() async throws {
        let (context, account, _, rpc, server) = try fixture()
        for decision in ["allow", "deny"] {
            let result = await context.tool(name: "processPermissionRequest", parameters: Data("{\"requestId\":\"permission\",\"decision\":\"\(decision)\"}".utf8))
            XCTAssertFalse(result.isError)
            let call = try XCTUnwrap(rpc.calls.last)
            XCTAssertEqual(call.method, "s:permission")
            XCTAssertEqual(RecordCipher(key: server.dataKey).decrypt(base64: call.params), .object([
                "id": .string("permission"), "approved": .bool(decision == "allow"),
            ]))
        }
        var record = try XCTUnwrap(account.store.session(id: "s"))
        record.agentStateVersion += 1
        record.agentState = .object(["requests": .object([:])])
        try account.store.upsertSessions([record])
        for body in [#"{"requestId":"permission","decision":"allow"}"#, #"{"requestId":"permission","decision":"always"}"#, #"{"requestId":"","decision":"deny"}"#] {
            let result = await context.tool(name: "processPermissionRequest", parameters: Data(body.utf8))
            XCTAssertTrue(result.isError)
        }
        XCTAssertEqual(rpc.calls.count, 2)
        await context.stop()
        let afterStop = await context.tool(name: "processPermissionRequest", parameters: Data(#"{"requestId":"permission","decision":"allow"}"#.utf8))
        XCTAssertTrue(afterStop.isError)
        await account.stop()
    }

    func testVoiceOutboxAcceptancePreservesSyncedRigDraft() async throws {
        let server = ServerFixture()
        let store = try LocalStore.inMemory()
        var record = RecordDecoder(keyRing: KeyRing(keys: server.keys)).session(server.session("s", updatedAt: 1))
        record.metadata = .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "draftUpdatedAt": .number(10),
            "draft": .object(["text": .string("unsent keyboard draft"), "providerId": .string("p"), "modelId": .string("m"), "permissionMode": .string("ask")]),
        ])
        try store.upsertSessions([record], reconcileComposer: SessionModePushCounters().reconciliation)
        let sync = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: server.keys)
        let sender = OutboxSender(store: store, sync: sync, filesDirectory: FileManager.default.temporaryDirectory)
        _ = try await sender.send(OutgoingMessage(text: "spoken instruction", source: .voice), sessionId: "s")
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "unsent keyboard draft")
        XCTAssertEqual(try store.composerState(sessionId: "s").values["draftUpdatedAt"], .number(10))
        XCTAssertEqual(try store.pendingOutbox().first?.payload["content"]?["text"], .string("spoken instruction"))
        await sync.stop()
    }
}
