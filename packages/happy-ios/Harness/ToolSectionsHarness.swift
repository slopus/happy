#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct ToolSectionsHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ToolSectionsSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// What the harness's computer and script say, as the daemon's JSON.
private enum ToolSectionsScript {
    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func call(_ id: String, _ name: String, status: String = "completed", _ presentation: [String: JSONValue]) -> JSONValue {
        .object(["type": .string("tool_call"), "id": .string(id), "name": .string(name), "status": .string(status), "presentation": .object(presentation)])
    }

    static func read(_ id: String, _ file: String, status: String = "completed") -> JSONValue {
        call(id, "exec_command", status: status, ["type": .string("exploration"), "operations": .array([.object(["kind": .string("read"), "name": .string(file)])])])
    }

    static func command(_ id: String, _ command: String, status: String = "completed") -> JSONValue {
        call(id, "exec_command", status: status, ["type": .string("exec_command"), "command": .string(command)])
    }

    static func edit(_ id: String, _ path: String, added: Int, deleted: Int, status: String = "completed") -> JSONValue {
        call(id, "apply_patch", status: status, ["type": .string("file_diff"), "files": .array([.object([
            "path": .string(path), "kind": .string("update"), "added": .number(Double(added)), "deleted": .number(Double(deleted)), "hunks": .array([]),
        ])])])
    }

    static func search(_ id: String, _ query: String, status: String = "completed") -> JSONValue {
        call(id, "exec_command", status: status, ["type": .string("exploration"), "operations": .array([.object(["kind": .string("search"), "query": .string(query), "path": .string("Sources")])])])
    }

    static let question: JSONValue = .object([
        "type": .string("tool_call"), "id": .string("ask"), "name": .string(AgentWire.Question.toolName), "status": .string("completed"),
        "arguments": .object(["questions": .array([.object([
            "id": .string("scope"), "header": .string("Scope"), "question": .string("How far should the fix go?"),
            "options": .array([.object(["label": .string("Only the cache module")]), .object(["label": .string("The cache and every caller")])]),
        ])])]),
        "result": .object(["output": .string("The person answered.\nStatus: Answered\nAnswer:\nscope: Only the cache module")]),
    ])

    static func message(_ id: String, at: Double, _ content: [JSONValue], role: String = "agent", status: String = "completed") -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(at), "metadata": .object([:]), "status": .string(status), "content": .array(content)])
    }
}

/// One agent, `sections`, whose newest turn is still running when the chat
/// opens: two runs of calls already ended (one summed up, one a single
/// call), an answered question, then calls that `play` brings one by one,
/// each replacing the last on the section's line, until the turn ends.
private struct ToolSectionsComputer: AgentTransport {
    let started: Double

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        typealias S = ToolSectionsScript
        let value: JSONValue
        if path.contains("/agents/sections/messages?") {
            let earlier: JSONValue = .object([
                "id": .string("r0"), "status": .string("completed"), "startedAt": .number(started - 600_000), "endedAt": .number(started - 480_000), "reason": .string("completed"),
                "messages": .array([
                    S.message("u0", at: started - 600_000, [S.text("Why is the cache test flaky?")], role: "user"),
                    S.message("m0a", at: started - 598_000, [S.text("Let me read the cache first."), S.read("h1", "Store.swift"), S.read("h2", "StoreTests.swift"), S.command("h3", "swift test --filter StoreTests")]),
                    S.message("m0b", at: started - 500_000, [S.text("The test races the eviction timer: a read can land just after the cutoff was taken.")]),
                ]),
            ])
            let live: JSONValue = .object([
                "id": .string("live"), "status": .string("running"), "startedAt": .number(started),
                "messages": .array([
                    S.message("u1", at: started, [S.text("Fix it, and keep the test honest.")], role: "user"),
                    S.message("m1", at: started + 1_000, [S.text("I'll look at how reads and eviction meet."),
                                                         S.read("t1", "Sources/Cache/Store.swift"), S.read("t2", "Sources/Cache/Clock.swift")]),
                    S.message("m2", at: started + 40_000, [S.search("t3", "evict"), S.read("t4", "Tests/CacheTests/StoreTests.swift"),
                                                          S.search("t5", "touched"), S.edit("t6", "Sources/Cache/Store.swift", added: 6, deleted: 3)]),
                    S.message("m3", at: started + 192_000, [S.text("Before I change the callers too:"), S.question]),
                    S.message("m4", at: started + 230_000, [S.text("Only the cache, then."), S.edit("t7", "Tests/CacheTests/StoreTests.swift", added: 2, deleted: 1)]),
                    S.message("m5", at: started + 236_000, [S.text("Now the suite, ten times over.")]),
                ]),
            ])
            value = .object(["hasMore": .bool(false), "runs": .array([earlier, live])])
        } else if path.hasSuffix("/agents/sections/bootstrap") {
            value = .object(["agent": .object(["id": .string("sections"), "workspaceId": .string("w"), "status": .string("working")]), "pending": .array([])])
        } else {
            throw URLError(.cannotConnectToHost)
        }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() async {}
    func close() async {}
}

/// Group tool calls in the agents' chat (`-screen toolSections`): a
/// running turn with sections already ended, then a run of calls played
/// in through the store's events, as the daemon sends them. `-ungrouped`
/// turns Group tool calls off first; `-still` plays nothing; `-finish`
/// ends the turn after the run, folding it; `-settings` opens Settings
/// at the toggle instead.
@MainActor
final class ToolSectionsHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let started = Date().timeIntervalSince1970 * 1000 - 300_000
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/tool-sections",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in ToolSectionsComputer(started: started) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ToolSectionsHTTP(), connector: ToolSectionsSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "tool-sections", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            account.localSettings.groupsToolCalls = !arguments.contains("-ungrouped")
            let context = AppContext(account: account, variant: .development, version: "tool-sections")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            if arguments.contains("-settings") {
                navigation.pushViewController(SettingsViewController(context: context, computer: connection.id), animated: false)
                try await Task.sleep(for: .seconds(1.5))
                // Appearance, tapped as a finger would.
                func rows(_ view: UIView) -> [UIView] { (view is SettingsCardView.RowView ? [view] : []) + view.subviews.flatMap(rows) }
                func says(_ view: UIView, _ text: String) -> Bool { (view as? UILabel)?.text == text || view.subviews.contains { says($0, text) } }
                if let settings = navigation.topViewController, let row = rows(settings.view).first(where: { says($0, SettingsIndex.appearance.title) }) {
                    row.perform(NSSelectorFromString("tapped"))
                }
                return
            }
            let chat = ChatViewController(session: session, agentId: "sections", title: "Cache", spaceId: nil, intro: nil)
            navigation.pushViewController(chat, animated: false)
            guard !arguments.contains("-still") else { return }
            try await Task.sleep(for: .seconds(4))
            await play(session.store, started: started, finish: arguments.contains("-finish"))
        } catch {
            print("TOOL_SECTIONS error: \(error)")
        }
    }

    private func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
        var payload = payload
        payload["agentId"] = .string("sections")
        return .object(["type": .string(type), "payload": .object(payload)])
    }

    /// The run's calls, one message each, each running for a moment and
    /// done as the next starts; then the agent's words end the run.
    private func play(_ store: Store, started: Double, finish: Bool) async {
        typealias S = ToolSectionsScript
        let calls: [(String, String) -> JSONValue] = [
            { S.command($0, "swift test --filter StoreTests -q", status: $1) },
            { S.read($0, "Sources/Cache/Eviction.swift", status: $1) },
            { S.edit($0, "Sources/Cache/Eviction.swift", added: 4, deleted: 9, status: $1) },
            { S.command($0, "for i in $(seq 10); do swift test -q || break; done", status: $1) },
            { S.search($0, "lifetime", status: $1) },
        ]
        let now = { Date().timeIntervalSince1970 * 1000 }
        for (index, call) in calls.enumerated() {
            let id = "p\(index)", message = "mp\(index)", at = now()
            print("TOOL_SECTIONS call \(index)")
            await store.externalEvent(event("message.created", ["runId": .string("live"), "message": S.message(message, at: at, [call(id, "running")], status: "streaming")]))
            try? await Task.sleep(for: .milliseconds(1_400))
            await store.externalEvent(event("message.updated", ["runId": .string("live"), "message": S.message(message, at: at, [call(id, "completed")])]))
            try? await Task.sleep(for: .milliseconds(500))
        }
        print("TOOL_SECTIONS words")
        await store.externalEvent(event("message.created", ["runId": .string("live"), "message": S.message("mw", at: now(), [S.text("Ten runs in a row pass. Reads now hold eviction until they finish.")])]))
        guard finish else { return }
        try? await Task.sleep(for: .seconds(3))
        print("TOOL_SECTIONS finished")
        await store.externalEvent(event("run.finished", ["run": .object([
            "id": .string("live"), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(started), "endedAt": .number(now()),
        ])]))
    }
}
#endif
