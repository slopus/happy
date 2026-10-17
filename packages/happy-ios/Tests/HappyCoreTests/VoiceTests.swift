import Foundation
@testable import HappyCore
import HappyWire
import XCTest

final class VoiceAPITests: XCTestCase {
    func testGrantUsesAuthenticatedBackendWithoutPurchaseConfiguration() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/voice/conversations", #"{"allowed":true,"conversationToken":"short-lived-jwt","conversationId":"conv_1","agentId":"agent","elevenUserId":"u_1","usedSeconds":0,"limitSeconds":1200}"#)
        let api = HappyAPI(serverURL: URL(string: "https://example.test")!, clientID: "ios/test", transport: http, token: "happy-token")
        guard case .allowed(let grant) = try await api.voiceCredentials() else { return XCTFail("free grant rejected") }
        XCTAssertEqual(grant.limitSeconds, 1200)
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.headers["Authorization"], "Bearer happy-token")
        XCTAssertEqual(request.headers["X-Happy-Client"], "ios/test")
        XCTAssertEqual(try JSONValue.decode(XCTUnwrap(request.body)), .object(["agentId": .string(HappyAPI.voiceAgentID)]))
    }

    func testDenialsStayDistinctAndMalformedGrantsFailClosed() throws {
        for reason in ["subscription_required", "voice_hard_limit_reached", "voice_conversation_limit_reached"] {
            let data = Data("{\"allowed\":false,\"reason\":\"\(reason)\",\"agentId\":\"a\",\"usedSeconds\":1200,\"limitSeconds\":1200}".utf8)
            guard case .denied(let denial) = try JSONDecoder().decode(VoiceCredentials.self, from: data) else { return XCTFail() }
            XCTAssertEqual(denial.reason.rawValue, reason)
        }
        XCTAssertThrowsError(try JSONDecoder().decode(VoiceCredentials.self, from: Data(#"{"allowed":true,"agentId":"a"}"#.utf8)))
    }

    func testErrorsDoNotExposeResponseCredentials() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/voice/conversations", "private-token", status: 500)
        let api = HappyAPI(serverURL: URL(string: "https://example.test")!, clientID: "test", transport: http, token: "token")
        do { _ = try await api.voiceCredentials(); XCTFail() }
        catch let error as APIError { XCTAssertEqual(error, .http(status: 500, body: "Voice service unavailable")) }
    }
}

@MainActor
final class VoiceLifecycleTests: XCTestCase {
    nonisolated private static let grant = VoiceGrant(conversationToken: "token", conversationId: "conv", agentId: "a", elevenUserId: "u", usedSeconds: 0, limitSeconds: 1200)
    private let request = VoiceStart(sessionId: "s", context: "history")

    private func until(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<2000 { if condition() { return }; await Task.yield() }
        XCTFail("voice state did not settle")
    }

    func testFreeBackendGrantConnectsWithoutRevenueCatAndMuteAndStopReachTransport() async {
        let connection = TestVoiceConnection()
        let session = VoiceSession(permission: { true }, credentials: { .allowed(Self.grant) }, connect: { grant, request, _, _ in
            XCTAssertEqual(grant, Self.grant); XCTAssertEqual(request.sessionId, "s")
            return connection
        })
        session.start(request)
        await until { session.state == .active(activity: .listening, muted: false) }
        await session.toggleMute()
        XCTAssertEqual(connection.mutes, [true])
        XCTAssertEqual(session.state, .active(activity: .listening, muted: true))
        session.stop()
        await until { connection.ended == 1 }
        XCTAssertEqual(session.state, .idle)
    }

    func testMicrophoneDenialNeverRequestsBackendOrOpensTransport() async {
        let session = VoiceSession(permission: { false }, credentials: { XCTFail("backend before permission"); return .allowed(Self.grant) }, connect: { _, _, _, _ in
            XCTFail("transport before permission"); return TestVoiceConnection()
        })
        session.start(request)
        await until { session.state == .failed(.microphonePermission) }
    }

    func testBackendDenialNeverOpensTransport() async throws {
        let denial = try JSONDecoder().decode(VoiceCredentials.self, from: Data(#"{"allowed":false,"reason":"subscription_required","usedSeconds":1200,"limitSeconds":1200,"agentId":"a"}"#.utf8))
        let session = VoiceSession(permission: { true }, credentials: { denial }, connect: { _, _, _, _ in
            XCTFail("server denial must be authoritative"); return TestVoiceConnection()
        })
        session.start(request)
        await until { if case .denied = session.state { return true }; return false }
    }

    func testStopWhileConnectingClosesLateConnectionAndIgnoresStaleCallbacks() async {
        let gate = ConnectionGate()
        let connection = TestVoiceConnection()
        var staleActivity: (@MainActor (VoiceActivity) -> Void)?
        let session = VoiceSession(permission: { true }, credentials: { .allowed(Self.grant) }, connect: { _, _, activity, _ in
            staleActivity = activity
            await gate.wait()
            return connection
        })
        session.start(request)
        await until { staleActivity != nil }
        session.stop()
        await gate.release()
        await until { connection.ended == 1 }
        staleActivity?(.agentSpeaking)
        XCTAssertEqual(session.state, .idle)
    }

    func testPromptsWaitForSilenceWhileContextIsImmediateAndStopDropsQueue() async {
        let connection = TestVoiceConnection()
        var activity: (@MainActor (VoiceActivity) -> Void)?
        let session = VoiceSession(permission: { true }, credentials: { .allowed(Self.grant) }, connect: { _, _, callback, _ in activity = callback; return connection })
        session.start(request)
        await until { session.state == .active(activity: .listening, muted: false) }
        activity?(.agentSpeaking)
        await session.context("new message", prompts: ["agent finished"])
        XCTAssertEqual(connection.contexts, ["new message"])
        XCTAssertEqual(connection.prompts, [])
        activity?(.listening)
        await until { connection.prompts == ["agent finished"] }
        activity?(.userSpeaking)
        await session.context("", prompts: ["permission"])
        session.stop()
        activity?(.listening)
        await Task.yield()
        XCTAssertEqual(connection.prompts, ["agent finished"])
    }

    func testNewSessionWaitsForCancelledStartupAndActualAudioTeardown() async {
        let lifetime = VoiceConnectionLifetime()
        let startup = ConnectionGate()
        let teardown = ConnectionGate()
        let firstConnection = TestVoiceConnection()
        firstConnection.endGate = teardown
        var firstOpened = false
        var secondOpened = false
        let first = VoiceSession(permission: { true }, credentials: { .allowed(Self.grant) }, lifetime: lifetime, connect: { _, _, _, _ in
            firstOpened = true
            await startup.wait()
            return firstConnection
        })
        let second = VoiceSession(permission: { true }, credentials: { .allowed(Self.grant) }, lifetime: lifetime, connect: { _, _, _, _ in
            secondOpened = true
            return TestVoiceConnection()
        })
        first.start(request)
        await until { firstOpened }
        first.stop()
        second.start(request)
        for _ in 0..<50 { await Task.yield() }
        XCTAssertFalse(secondOpened)
        await startup.release()
        await until { firstConnection.ended == 1 }
        XCTAssertFalse(secondOpened, "old SDK end still owns the audio device")
        await teardown.release()
        await until { secondOpened }
        XCTAssertEqual(first.state, .idle)
        await until { second.state == .active(activity: .listening, muted: false) }
        second.stop()
    }

    func testRapidMuteTapsCannotDesynchronizeMicrophoneAndUI() async {
        let gate = ConnectionGate()
        let connection = TestVoiceConnection()
        connection.muteGate = gate
        let session = VoiceSession(permission: { true }, credentials: { .allowed(Self.grant) }, connect: { _, _, _, _ in connection })
        session.start(request)
        await until { session.state == .active(activity: .listening, muted: false) }
        let first = Task { await session.toggleMute() }
        await until { connection.mutes == [true] }
        let second = Task { await session.toggleMute() }
        await second.value
        XCTAssertEqual(connection.mutes, [true])
        await gate.release()
        await first.value
        XCTAssertEqual(session.state, .active(activity: .listening, muted: true))
        session.stop()
    }
}

@MainActor
private final class TestVoiceConnection: VoiceConnection {
    var ended = 0
    var mutes: [Bool] = []
    var contexts: [String] = []
    var prompts: [String] = []
    var endGate: ConnectionGate?
    var muteGate: ConnectionGate?
    func end() async { ended += 1; await endGate?.wait() }
    func setMuted(_ muted: Bool) async throws { mutes.append(muted); await muteGate?.wait() }
    func context(_ text: String) async throws { contexts.append(text) }
    func prompt(_ text: String) async throws { prompts.append(text) }
}

private actor ConnectionGate {
    var continuation: CheckedContinuation<Void, Never>?
    var released = false
    func wait() async { if !released { await withCheckedContinuation { continuation = $0 } } }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

final class VoiceContextTests: XCTestCase {
    func testContextForwardsVisibleTextOnlyAndDoesNotRepeatPendingPermission() {
        let permission = ToolPermission(id: "permission", status: .pending)
        let snapshot = ChatSnapshot(sessionId: "s", messages: [
            .agentText(AgentTextMessage(id: "thinking", createdAt: 1, text: "private reasoning", isThinking: true)),
            .agentText(AgentTextMessage(id: "answer", createdAt: 2, text: "answer", isThinking: false)),
            .toolCall(ToolCallMessage(id: "tool", createdAt: 3, tool: ToolCall(name: "Bash", state: .running, input: .object([:]), createdAt: 3, permission: permission))),
        ])
        var reducer = VoiceContextReducer()
        let first = reducer.apply(snapshot)
        XCTAssertTrue(first.context.contains("answer"))
        XCTAssertFalse(first.context.contains("private reasoning"))
        XCTAssertEqual(first.prompts.count, 1)
        let second = reducer.apply(snapshot)
        XCTAssertEqual(second, VoiceContextUpdate())
    }

    func testLatestFiftyMessagesAndLanguageMapping() {
        let messages = (0..<75).map { ChatMessage.userText(UserTextMessage(id: "m\($0)", createdAt: Int64($0), text: "text-\($0)")) }
        var reducer = VoiceContextReducer()
        let update = reducer.apply(ChatSnapshot(sessionId: "s", messages: messages))
        XCTAssertFalse(update.context.contains("text-0\n"))
        XCTAssertTrue(update.context.contains("text-74"))
        XCTAssertEqual(VoiceLanguage.selection("fr-CA").providerCode, "fr")
        XCTAssertNil(VoiceLanguage.selection(nil).providerCode)
        XCTAssertNil(VoiceLanguage.selection("unknown").providerCode)
    }
}
