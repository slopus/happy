#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private struct HistoryOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct HistoryNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer whose history is `Fixtures/agent-history.json`, what
/// `GET /v0/agents/:id/messages` and `/bootstrap` return today (API.md),
/// field for field: the newest runs first, the older ones on the page
/// asked for with `before`.
private actor HistoryComputer: AgentTransport {
    let newer: JSONValue
    let older: JSONValue
    let bootstrap: JSONValue

    init(fixture: JSONValue, olderRuns: Int) throws {
        guard case .array(let runs)? = fixture["history"]?["runs"], let bootstrap = fixture["bootstrap"] else { throw URLError(.cannotParseResponse) }
        older = .object(["runs": .array(Array(runs.prefix(olderRuns))), "hasMore": .bool(false), "cursor": .string("c")])
        newer = .object(["runs": .array(Array(runs.dropFirst(olderRuns))), "hasMore": .bool(olderRuns > 0), "cursor": .string("c")])
        self.bootstrap = bootstrap
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = path.contains("before=") ? older : newer
        } else if path.hasSuffix("/agents/a/bootstrap") {
            value = bootstrap
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() {}
    func close() {}
}

/// Every one of the person's own messages, sent long ago or just now,
/// shows its time and its mark, in both chats, from history in the shapes
/// the computer and the server keep it in, the pages loaded later by
/// scrolling included.
///
/// With `HAPPY_EVIDENCE_DIR` set, each chat is kept there, light and dark.
@MainActor
final class HostedDeliveryHistoryTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func all<View: UIView>(_ type: View.Type, in view: UIView) -> [View] {
        var found: [View] = []
        if let match = view as? View { found.append(match) }
        for subview in view.subviews { found += all(type, in: subview) }
        return found
    }

    private func fixture(_ name: String) throws -> JSONValue {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json") ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"), "\(name).json is not in the test bundle")
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    private func shoot(_ window: UIWindow, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_EVIDENCE_DIR"] else { return }
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(600))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(style == .dark ? "dark" : "light").png"))
        }
        window.overrideUserInterfaceStyle = .unspecified
    }

    /// What a row shows at its foot: the time drawn just before the mark,
    /// and the mark.
    private func foot(_ plan: ChatRowPlan) -> (time: String?, mark: MessageDelivery)? {
        guard let index = plan.items.lastIndex(where: { if case .delivery = $0 { true } else { false } }),
              case .delivery(let mark, _) = plan.items[index] else { return nil }
        var time: String?
        if index > 0, case .text(let layout, _) = plan.items[index - 1] { time = layout.string.string }
        return (time, mark.state)
    }

    private func expectFeet(_ plans: [ChatRowPlan], _ expected: [String: (createdAt: Double, mark: MessageDelivery)], others: Set<String>, _ chat: String) {
        let byId = Dictionary(plans.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (id, want) in expected {
            guard let plan = byId[id] else { XCTFail("\(chat): no row for \(id) among \(plans.map(\.id))"); continue }
            guard let foot = foot(plan) else { XCTFail("\(chat): \(id) shows no time or mark"); continue }
            XCTAssertEqual(foot.time, MessageTime.string(want.createdAt), "\(chat): \(id)'s time")
            XCTAssertEqual(foot.mark, want.mark, "\(chat): \(id)'s mark")
        }
        for id in others {
            guard let plan = byId[id] else { XCTFail("\(chat): no row for \(id)"); continue }
            XCTAssertNil(foot(plan), "\(chat): another person's message \(id) shows a mark")
        }
    }

    // MARK: The agent chat

    func testEveryOwnMessageInTheAgentsHistoryShowsItsTimeAndMark() async throws {
        let fixture = try fixture("agent-history")
        // The two oldest runs come on the page asked for by scrolling up.
        let computer = try HistoryComputer(fixture: fixture, olderRuns: 2)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: HistoryOffline(), connector: HistoryNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"history-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "History", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        addTeardownBlock { @MainActor in
            window.overrideUserInterfaceStyle = .unspecified
            window.isHidden = true
            hostWindow?.makeKey()
            Session.forget(pairing.id)
            try? await controller.agentConnections.remove(pairing.id)
        }
        window.layoutIfNeeded()

        // Every user message the computer keeps (runs, and the pending queue).
        var created: [String: Double] = [:]
        if case .array(let runs)? = fixture["history"]?["runs"] {
            for run in runs {
                guard case .array(let messages)? = run["messages"] else { continue }
                for message in messages where message["role"]?.stringValue == "user" {
                    created[message["id"]!.stringValue!] = message["createdAt"]!.numberValue!
                }
            }
        }
        if case .array(let pending)? = fixture["bootstrap"]?["pending"] {
            for message in pending { created[message["id"]!.stringValue!] = message["createdAt"]!.numberValue! }
        }
        var expected = Dictionary(uniqueKeysWithValues: ["user-3", "user-4", "user-5"].map { ($0, (createdAt: created[$0]!, mark: MessageDelivery.accepted)) })
        // Not yet taken into a run: the computer has it, one check.
        expected["user-6"] = (created["user-6"]!, .received)
        let first = try await until { Set(chat.plans.map(\.id)).isSuperset(of: Set(expected.keys)) }
        XCTAssertTrue(first, "the first page never landed: \(chat.plans.map(\.id))")
        expectFeet(chat.plans, expected, others: [], "agent")

        // The live marks are up over each own row on screen.
        try await Task.sleep(for: .milliseconds(300))
        let shown = all(ChatDeliveryView.self, in: chat.view).filter { !$0.isHidden && $0.window != nil && $0.mark != nil }
        XCTAssertFalse(shown.isEmpty, "no mark is on screen")
        try await shoot(window, "history-agent")

        // Scrolling up loads the older runs: their messages show both too.
        let transcript = try XCTUnwrap(all(AgentChatUltraList.self, in: chat.view).first)
        transcript.onReachedOldest?()
        let older = try await until { chat.plans.contains { $0.id == "user-1" } }
        XCTAssertTrue(older, "the older page never landed: \(chat.plans.map(\.id))")
        for id in ["user-1", "user-2"] { expected[id] = (created[id]!, .accepted) }
        expectFeet(chat.plans, expected, others: [], "agent, older page")
    }

    // MARK: The Happy CLI chat

    func testEveryOwnMessageInTheHappyCLIHistoryShowsItsTimeAndMark() async throws {
        let fixture = try fixture("legacy-history")
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: HistoryOffline(), connector: HistoryNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 5, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        let sessionId = "legacy-history"
        guard case .array(let raw)? = fixture["records"] else { return XCTFail("no records") }
        let records = raw.map { record in
            MessageRecord(
                id: record["id"]!.stringValue!, sessionId: sessionId, seq: Int(record["seq"]!.numberValue!), localId: record["localId"]?.stringValue,
                createdAt: Int64(record["createdAt"]!.numberValue!), updatedAt: Int64(record["createdAt"]!.numberValue!),
                contentCipher: "fixture", content: record["content"]!
            )
        }
        let base: Int64 = 1_761_993_000_000
        let session = SessionRecord(
            id: sessionId, seq: records.count, createdAt: base, updatedAt: base, active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000), projectId: nil,
            metadataVersion: 1, metadataCipher: "fixture",
            metadata: .object([
                "path": fixture["session"]?["path"] ?? .string("/"), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": fixture["session"]?["flavor"] ?? .string("claude"), "version": .string("1.0.0"),
                "os": .string("darwin"), "summary": .object(["text": .string("History"), "updatedAt": .number(Double(base))]),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
        // The newest half is on disk when the chat opens; the older half
        // arrives later, as a page fetched behind it.
        let newer = Array(records.dropFirst(6)), older = Array(records.prefix(6))
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.upsertSessions([session])
            try store.applyMessagePage(sessionId: sessionId, messages: newer, syncedThrough: records.count)
        }.value
        let context = AppContext(account: controller, variant: .development, version: "test")
        let chat = LegacyChatViewController(context: context, session: account, sessionId: sessionId)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        addTeardownBlock { @MainActor in
            window.overrideUserInterfaceStyle = .unspecified
            window.isHidden = true
            hostWindow?.makeKey()
            await controller.signOut()
        }
        window.layoutIfNeeded()
        func list() -> ChatListView? { all(ChatListView.self, in: chat.view).first }

        let created = Dictionary(uniqueKeysWithValues: records.map { ($0.id, Double($0.createdAt)) })
        // Rows are named by the send's local id when it has one, by the
        // session envelope's id for a CLI one, else by the record's.
        var expected: [String: (createdAt: Double, mark: MessageDelivery)] = [
            "local-command": (created["o-command"]!, .accepted),
            "o-bare": (created["o-bare"]!, .accepted),
            // Newer than every answer, in a session without receipts: one check.
            "local-last": (created["o-last"]!, .received),
        ]
        let first = try await until { Set(list()?.plans.map(\.id) ?? []).isSuperset(of: Set(expected.keys)) }
        XCTAssertTrue(first, "the newer records never drew: \(list()?.plans.map(\.id) ?? [])")
        expectFeet(list()?.plans ?? [], expected, others: [], "Happy CLI")

        try await Task.detached { try store.applyMessagePage(sessionId: sessionId, messages: older, syncedThrough: records.count) }.value
        expected["local-app"] = (created["o-app"]!, .accepted)
        expected["env-o-terminal"] = (created["o-terminal"]!, .accepted)
        expected["env-o-owner"] = (created["o-owner"]!, .accepted)
        let landed = try await until { Set(list()?.plans.map(\.id) ?? []).isSuperset(of: Set(expected.keys).union(["env-x-other"])) }
        XCTAssertTrue(landed, "the older records never drew: \(list()?.plans.map(\.id) ?? [])")
        expectFeet(list()?.plans ?? [], expected, others: ["env-x-other"], "Happy CLI, older page")
        try await Task.sleep(for: .milliseconds(300))
        try await shoot(window, "history-legacy")
    }
}
#endif
