import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// A failed turn's service message, as desktop's failure card reads it, and
/// the conversation that shows it, its retry, and the title the daemon writes.
final class FailureTests: XCTestCase {
    /// 2026-10-29 07:00 in Los Angeles.
    private let now = Date(timeIntervalSince1970: 1_793_282_400)
    private let zone = TimeZone(identifier: "America/Los_Angeles")!

    /// What preview.10 sent for a spent Codex account.
    static func usageLimit(id: String = "s1", resetsAt: Double, resolution: JSONValue? = nil) -> JSONValue {
        var failure: [String: JSONValue] = [
            "kind": .string("usage_limit"), "message": .string("Codex usage limit reached. It resets in about 6 days."),
            "fallbackProviders": .array([]), "resetsAt": .number(resetsAt),
            "provider": .object(["id": .string("codex"), "type": .string("codex"), "vendorName": .string("Codex"), "label": .string("Codex")]),
        ]
        if let resolution { failure["resolution"] = resolution }
        return .object([
            "id": .string(id), "role": .string("service"), "createdAt": .number(2), "metadata": .object([:]),
            "content": .array([.object(["type": .string("text"), "text": .string("Codex usage limit reached. It resets in about 6 days.")])]),
            "error": .object([
                "code": .string("out_of_tokens"), "credentialSource": .null,
                "mode": .object(["providerId": .string("codex"), "modelId": .string("gpt-6.1-sol"), "effort": .string("high"), "serviceTier": .null, "permissionMode": .string("auto")]),
                "recovery": .object(["steps": .array([.string("Wait for the limit to reset, or switch to another account.")]), "actions": .array([.string("ask_chief")])]),
            ]),
            "failure": .object(failure),
        ])
    }

    private func decode(_ value: JSONValue) throws -> AgentWire.Message {
        try JSONDecoder().decode(AgentWire.Message.self, from: JSONEncoder().encode(value))
    }

    func testAUsageLimitReadsAsDesktopWritesIt() throws {
        // Six days and nine hours on: 3:00 PM, the clocks having gone back.
        let resets = (now.timeIntervalSince1970 + 6 * 86_400 + 9 * 3_600) * 1000
        let failure = try XCTUnwrap(Failure.of(decode(Self.usageLimit(resetsAt: resets)), now: now, timeZone: zone))
        XCTAssertEqual(failure.reason.replacingOccurrences(of: "\u{202F}", with: " "), "Codex usage limit reached until Wednesday at 3:00 PM.")
        XCTAssertEqual(failure.steps, ["Wait for the limit to reset, or switch to another account."])
        XCTAssertEqual(failure.providerId, "codex")
        XCTAssertEqual(failure.modelId, "gpt-6.1-sol")
        XCTAssertNil(failure.resolution)
        XCTAssertTrue(failure.retryable)
    }

    func testAResetTellsItsDayAsDesktopDoes() {
        let hour: TimeInterval = 3_600
        func moment(_ offset: TimeInterval) -> String { Failure.moment(now.addingTimeInterval(offset), now: now, timeZone: zone, locale: Locale(identifier: "en_US")).replacingOccurrences(of: "\u{202F}", with: " ") }
        XCTAssertEqual(moment(2 * hour), "9:00 AM")
        XCTAssertEqual(moment(24 * hour), "tomorrow at 7:00 AM")
        XCTAssertEqual(moment(10 * 24 * hour), "Nov 8 at 6:00 AM")
    }

    func testWhatWasDoneAboutItIsRead() throws {
        let retried = try Failure.of(decode(Self.usageLimit(resetsAt: 0, resolution: .object(["action": .string("retried"), "at": .number(3)]))))
        XCTAssertEqual(retried?.resolution, .retried)
        let switched = try Failure.of(decode(Self.usageLimit(resetsAt: 0, resolution: .object(["action": .string("switched"), "at": .number(3), "providerId": .string("claude"), "modelId": .string("sonnet")]))))
        XCTAssertEqual(switched?.resolution, .switched(providerId: "claude", modelId: "sonnet"))
        let other = try Failure.of(decode(Self.usageLimit(resetsAt: 0, resolution: .object(["action": .string("dismissed"), "at": .number(3)]))))
        XCTAssertEqual(other?.resolution, .handled)
    }

    func testAnUnknownKindOrAnUntypedErrorReadsItsOwnWords() throws {
        let unknown: JSONValue = .object(["id": .string("s"), "role": .string("service"), "createdAt": .number(1), "content": .array([]),
            "failure": .object(["kind": .string("brand_new"), "message": .string("Something new broke."), "fallbackProviders": .array([])])])
        XCTAssertEqual(try Failure.of(decode(unknown))?.reason, "Something new broke.")
        let untyped: JSONValue = .object(["id": .string("s"), "role": .string("service"), "createdAt": .number(1),
            "content": .array([.object(["type": .string("text"), "text": .string("The provider refused.")])]),
            "error": .object(["code": .string("x"), "mode": .null, "credentialSource": .null, "recovery": .object(["steps": .array([]), "actions": .array([])])])])
        XCTAssertEqual(try Failure.of(decode(untyped))?.reason, "The provider refused.")
        let tooLong: JSONValue = .object(["id": .string("s"), "role": .string("service"), "createdAt": .number(1), "content": .array([]),
            "failure": .object(["kind": .string("context_too_long"), "modelId": .string("sonnet"), "message": .string("Too long."), "fallbackProviders": .array([])])])
        XCTAssertEqual(try Failure.of(decode(tooLong))?.retryable, false)
    }

    func testHousekeepingIsNoFailure() throws {
        let notice: JSONValue = .object(["id": .string("s"), "role": .string("service"), "createdAt": .number(1),
            "content": .array([.object(["type": .string("text"), "text": .string("Context was reset.")])])])
        XCTAssertNil(try Failure.of(decode(notice)))
    }

    /// The reported run: the first message of new work failed at once. The
    /// conversation shows the failure under it, takes the title the daemon
    /// wrote, and a retry shows what was done.
    func testAFailedFirstTurnShowsItsFailureTitleAndRetry() async throws {
        let server = FailedTurnServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: nil)
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a1")
        var updates = conversation.updates.makeAsyncIterator()
        func next(_ predicate: (ChatSnapshot) -> Bool) async -> ChatSnapshot? {
            while let snapshot = await updates.next() { if predicate(snapshot) { return snapshot } }
            return nil
        }
        func failure(_ snapshot: ChatSnapshot?) -> Failure? {
            snapshot?.items.compactMap { if case .failure(let failure) = $0.role { failure } else { nil } }.first
        }
        await conversation.start()
        let loaded = await next { $0.loaded && $0.items.count == 2 }
        XCTAssertEqual(loaded?.items.first?.role, .user)
        XCTAssertEqual(failure(loaded)?.messageId, "s1")
        XCTAssertNil(failure(loaded)?.resolution)
        XCTAssertEqual(loaded?.title, "In ~/code/sproutsense-dashboard, fix the DST bug")
        // The draft's mode (the last pick) stands over what the agent last ran with.
        XCTAssertEqual(loaded?.mode?.providerId, "claude")
        XCTAssertEqual(loaded?.working, false)

        try await conversation.resolveFailure("s1")
        let retried = await next { failure($0)?.resolution != nil }
        XCTAssertEqual(failure(retried)?.resolution, .retried)
        let posted = await server.posts()
        XCTAssertEqual(posted.first?.path, "/v0/agents/a1/messages/s1/retry")
        XCTAssertNotNil(posted.first?.body["mutationId"]?.stringValue)

        try await conversation.resolveFailure("s1", switchTo: AgentWire.Mode(providerId: "claude", modelId: "sonnet", effort: "high", serviceTier: nil, permissionMode: "auto"))
        let switched = await server.posts()
        XCTAssertEqual(switched.last?.path, "/v0/agents/a1/messages/s1/switch")
        XCTAssertEqual(switched.last?.body["providerId"], .string("claude"))
        XCTAssertEqual(switched.last?.body["modelId"], .string("sonnet"))

        // Renamed later: the header follows.
        await engine.spaces.externalEvent(.object(["type": .string("agent.updated"), "payload": .object(["agentId": .string("a1"), "changes": .object(["title": .string("Fix the DST bug")])])]))
        let renamed = await next { $0.title == "Fix the DST bug" }
        XCTAssertNotNil(renamed)
        await conversation.stop()
    }
}

/// A daemon holding one conversation whose only run failed.
private actor FailedTurnServer: AgentTransport {
    private var resolved: JSONValue?
    private var posted: [(path: String, body: JSONValue)] = []

    func posts() -> [(path: String, body: JSONValue)] { posted }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if method == "POST", path.hasPrefix("/v0/agents/a1/messages/s1/") {
            let request = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
            posted.append((path, request))
            let action: JSONValue = path.hasSuffix("/retry")
                ? .object(["action": .string("retried"), "at": .number(3)])
                : .object(["action": .string("switched"), "at": .number(3), "providerId": request["providerId"] ?? .null, "modelId": request["modelId"] ?? .null])
            resolved = FailureTests.usageLimit(resetsAt: 0, resolution: action)
            value = .object(["agent": .object(["id": .string("a1"), "workspaceId": .string("w"), "status": .string("idle")]), "message": resolved!, "cursor": .string("c")])
        } else if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([
                .object(["id": .string("r1"), "status": .string("failed"), "startedAt": .number(1), "messages": .array([
                    .object(["id": .string("u1"), "role": .string("user"), "createdAt": .number(1), "metadata": .object([:]),
                             "content": .array([.object(["type": .string("text"), "text": .string("In ~/code/sproutsense-dashboard, fix the DST bug")])])]),
                    resolved ?? FailureTests.usageLimit(resetsAt: 0),
                ])]),
            ])])
        } else if path.hasSuffix("/bootstrap") {
            let mode: JSONValue = .object(["providerId": .string("codex"), "modelId": .string("gpt-6.1-sol"), "effort": .string("high"), "serviceTier": .null, "permissionMode": .string("auto")])
            let draft: JSONValue = .object(["updatedAt": .number(5), "value": .object([
                "text": .string(""), "providerId": .string("claude"), "modelId": .string("sonnet"), "effort": .string("high"), "serviceTier": .null, "permissionMode": .string("auto"),
            ])])
            value = .object(["agent": .object(["id": .string("a1"), "workspaceId": .string("w"), "status": .string("idle"),
                                               "title": .string("In ~/code/sproutsense-dashboard, fix the DST bug")]),
                             "mode": mode, "draft": draft, "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
