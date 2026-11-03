#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct AgentToolsHTTP: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct AgentToolsSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `tools`, whose one finished turn ran a call of each kind
/// its screen draws: an exploration, a command, edits, a plan, a search,
/// an MCP tool the reviewer let through and a command that failed. Its
/// workspace, `w`, has three changed files against `origin/main`.
private struct AgentToolsComputer: AgentTransport {
    private static let run = #"""
    {"id":"r1","status":"completed","startedAt":1000,"endedAt":95000,"reason":"completed","messages":[
     {"id":"u1","role":"user","createdAt":1,"metadata":{},"content":[{"type":"text","text":"The cache test is flaky. Find out why, fix it and file an issue for the follow-up."}]},
     {"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[
      {"type":"text","text":"Let me look at the cache and its test first."},
      {"type":"tool_call","id":"t-explore","name":"exec_command","status":"completed","presentation":{"type":"exploration","operations":[
        {"kind":"list","target":"Sources/Cache"},{"kind":"read","name":"Sources/Cache/Store.swift"},{"kind":"search","command":"rg -n evict Sources","query":"evict","path":"Sources"},{"kind":"read","name":"Tests/CacheTests/StoreTests.swift"}]}},
      {"type":"tool_call","id":"t-bash","name":"exec_command","status":"completed","presentation":{"type":"exec_command","command":"swift test --filter StoreTests 2>&1 | tail -12",
        "output":"Building for debugging...\n[12/12] Linking HappyCachePackageTests\nTest Suite 'StoreTests' started.\nTest Case 'StoreTests.testEvictsOldest' passed (0.004 seconds).\nTest Case 'StoreTests.testKeepsWhatItRead' started.\nStoreTests.swift:41: error: XCTAssertEqual failed: (\"2\") is not equal to (\"3\")\nTest Case 'StoreTests.testKeepsWhatItRead' failed (0.011 seconds).\nTest Case 'StoreTests.testReloadsChangedFile' passed (0.002 seconds).\nExecuted 3 tests, with 1 failure (0 unexpected) in 0.017 seconds"}},
      {"type":"tool_call","id":"t-plan","name":"update_plan","status":"completed","arguments":{"explanation":"The test races the eviction timer.","plan":[
        {"step":"Reproduce the failure","status":"completed"},{"step":"Make eviction wait for the read","status":"in_progress"},{"step":"Run the suite ten times","status":"pending"},{"step":"File the follow-up issue","status":"pending"}]},"result":{"output":"Plan updated"}},
      {"type":"tool_call","id":"t-edit","name":"apply_patch","status":"completed","presentation":{"type":"file_diff","files":[
        {"path":"Sources/Cache/Store.swift","kind":"update","added":6,"deleted":3,"language":"swift","hunks":[
          {"oldStart":38,"newStart":38,"lines":[
            {"kind":"context","text":"    func read(_ key: Key) async throws -> Entry {"},
            {"kind":"context","text":"        if let entry = entries[key], !entry.isStale {"},
            {"kind":"delete","text":"            entry.touched = clock.now"},
            {"kind":"delete","text":"            return entry"},
            {"kind":"add","text":"            // A read keeps the entry until the eviction after it."},
            {"kind":"add","text":"            entries[key]?.touched = clock.now"},
            {"kind":"add","text":"            pending.remove(key)"},
            {"kind":"add","text":"            return entries[key] ?? entry"},
            {"kind":"context","text":"        }"},
            {"kind":"context","text":"        let entry = try await load(key)"}]},
          {"oldStart":71,"newStart":73,"lines":[
            {"kind":"context","text":"    private func evict() {"},
            {"kind":"delete","text":"        let cutoff = clock.now - lifetime"},
            {"kind":"add","text":"        let cutoff = clock.now.advanced(by: -lifetime)"},
            {"kind":"add","text":"        guard pending.isEmpty else { return schedule() }"},
            {"kind":"context","text":"        entries = entries.filter { $0.value.touched >= cutoff }"},
            {"kind":"context","text":"    }"}]}]},
        {"path":"Tests/CacheTests/StoreTests.swift","kind":"update","added":2,"deleted":1,"language":"swift","hunks":[
          {"oldStart":36,"newStart":36,"lines":[
            {"kind":"context","text":"    func testKeepsWhatItRead() async throws {"},
            {"kind":"delete","text":"        let store = Store(lifetime: .milliseconds(5))"},
            {"kind":"add","text":"        let clock = TestClock()"},
            {"kind":"add","text":"        let store = Store(lifetime: .milliseconds(5), clock: clock)"},
            {"kind":"context","text":"        _ = try await store.read(\"a\")"}]}]}]}},
      {"type":"tool_call","id":"t-test","name":"exec_command","status":"completed","presentation":{"type":"exec_command","command":"for i in $(seq 10); do swift test --filter StoreTests -q || break; done","output":"Executed 3 tests, with 0 failures\n(10 runs)"}},
      {"type":"tool_call","id":"t-search","name":"web_search","status":"completed","presentation":{"type":"search","target":"web","query":"swift TestClock advance eviction timer","sources":[
        {"title":"swift-clocks: TestClock","url":"https://github.com/pointfreeco/swift-clocks"},{"title":"Clock | Apple Developer Documentation","url":"https://developer.apple.com/documentation/swift/clock"}]}},
      {"type":"tool_call","id":"t-mcp","name":"mcp__linear__create_issue","status":"completed","elevated":false,
        "review":{"outcome":"allowed","reason":"Creates one issue in the team's tracker, which the person asked for.","risk":"low","userAuthorization":"high"},
        "arguments":{"team":"CACHE","title":"Move the eviction timer onto the injected clock","priority":2,"labels":["flaky-test","cache"],"description":"StoreTests.testKeepsWhatItRead raced the real eviction timer. The fix makes reads hold eviction; the timer itself should use the injected clock too."},
        "result":{"output":"{\"id\":\"CACHE-142\",\"url\":\"https://linear.app/happy/issue/CACHE-142\",\"state\":\"Todo\"}"}},
      {"type":"tool_call","id":"t-push","name":"exec_command","status":"failed","presentation":{"type":"exec_command","command":"git push origin HEAD","output":"To github.com:happy/cache.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'github.com:happy/cache.git'"}},
      {"type":"text","text":"The test raced the eviction timer: a read could land just after the cutoff was taken. Reads now hold eviction until they finish, and the test drives a TestClock. Ten runs in a row pass. I filed CACHE-142 for moving the timer itself onto the injected clock. The push was rejected because main moved; I left the commit for you to rebase."}]}]}
    """#

    private static let git = #"""
    {"git":{"facts":{"branch":"fix/cache-eviction","detached":false,"head":"4be1c0d","upstream":"origin/fix/cache-eviction","ahead":1,"behind":0},
     "comparison":"ready","base":"origin/main","changedFiles":3,"insertions":14,"deletions":4,"countsExact":true,"conflicted":false,
     "files":[{"path":"Sources/Cache/Store.swift","status":"modified","staged":false,"unstaged":true,"binary":false,"insertions":6,"deletions":3},
              {"path":"Tests/CacheTests/StoreTests.swift","status":"modified","staged":false,"unstaged":true,"binary":false,"insertions":2,"deletions":1},
              {"path":"Sources/Cache/TestClock.swift","status":"untracked","staged":false,"unstaged":true,"binary":false,"insertions":6,"deletions":0}],
     "filesTruncated":false,"scannedAt":1}}
    """#

    private static let before: [String: String] = [
        "Sources/Cache/Store.swift": """
        import Foundation

        actor Store {
            func read(_ key: Key) async throws -> Entry {
                if let entry = entries[key], !entry.isStale {
                    entry.touched = clock.now
                    return entry
                }
                let entry = try await load(key)
                entries[key] = entry
                return entry
            }

            private func evict() {
                let cutoff = clock.now - lifetime
                entries = entries.filter { $0.value.touched >= cutoff }
            }
        }

        """,
        "Tests/CacheTests/StoreTests.swift": """
        final class StoreTests: XCTestCase {
            func testKeepsWhatItRead() async throws {
                let store = Store(lifetime: .milliseconds(5))
                _ = try await store.read("a")
            }
        }

        """,
    ]

    private static let after: [String: String] = [
        "Sources/Cache/Store.swift": """
        import Foundation

        actor Store {
            func read(_ key: Key) async throws -> Entry {
                if let entry = entries[key], !entry.isStale {
                    // A read keeps the entry until the eviction after it.
                    entries[key]?.touched = clock.now
                    pending.remove(key)
                    return entries[key] ?? entry
                }
                let entry = try await load(key)
                entries[key] = entry
                return entry
            }

            private func evict() {
                let cutoff = clock.now.advanced(by: -lifetime)
                guard pending.isEmpty else { return schedule() }
                entries = entries.filter { $0.value.touched >= cutoff }
            }
        }

        """,
        "Tests/CacheTests/StoreTests.swift": """
        final class StoreTests: XCTestCase {
            func testKeepsWhatItRead() async throws {
                let clock = TestClock()
                let store = Store(lifetime: .milliseconds(5), clock: clock)
                _ = try await store.read("a")
            }
        }

        """,
        "Sources/Cache/TestClock.swift": """
        /// A clock the tests move by hand.
        final class TestClock: Clock {
            private(set) var now = Instant()
            func advance(by duration: Duration) { now = now.advanced(by: duration) }
        }

        """,
    ]

    private static func query(_ path: String, _ name: String) -> String? {
        URLComponents(string: "http://x" + path)?.queryItems?.first { $0.name == name }?.value
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let data: Data
        if path.contains("/agents/tools/messages?") {
            data = Data(#"{"hasMore":false,"runs":["#.utf8) + Data(Self.run.utf8) + Data("]}".utf8)
        } else if path.hasSuffix("/agents/tools/bootstrap") {
            data = Data(#"{"agent":{"id":"tools","workspaceId":"w","status":"idle"},"pending":[],"slashCommands":[]}"#.utf8)
        } else if path.hasSuffix("/workspaces/w/git") {
            data = Data(Self.git.utf8)
        } else if path.contains("/workspaces/w/file?"), let file = Self.query(path, "path"), let text = Self.after[file] {
            data = try JSONEncoder().encode(["content": Data(text.utf8).base64EncodedString(), "hash": "h"])
        } else if path.contains("/workspaces/w/file-revision?") {
            guard let file = Self.query(path, "path"), let text = Self.before[file] else {
                return HTTP1Response(status: 404, body: Data(#"{"error":"missing"}"#.utf8))
            }
            data = try JSONEncoder().encode(["content": Data(text.utf8).base64EncodedString()])
        } else {
            throw URLError(.cannotConnectToHost)
        }
        return HTTP1Response(status: 200, body: data)
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }

    func reset() async {}
    func close() async {}
}

/// A Happy Agent conversation's tool calls and changes (`-screen
/// agentTools`): the chat with its turn's traces open, and with `-open`
/// one screen over it: `bash`, `edit`, `file` (the edit's first file
/// alone), `plan`, `mcp`, `failed`, `search` or `changes`.
@MainActor
final class AgentToolsHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/agent-tools",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in AgentToolsComputer() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: AgentToolsHTTP(), connector: AgentToolsSockets()
        )
        self.account = account
        do {
            await account.agentConnections.setForeground(false)
            let connection = try await account.agentConnections.add(.init(address: "agent-tools", port: 1, deviceID: UUID().uuidString, deviceToken: "fixture"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "agent-tools")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            let chat = ChatViewController(session: session, agentId: "tools", title: "Flaky cache test", spaceId: nil, intro: nil)
            navigation.pushViewController(chat, animated: false)
            try? await Task.sleep(for: .seconds(1.5))
            chat.act(.toggleTurn("r1"))
            guard let index = arguments.firstIndex(of: "-open"), arguments.indices.contains(index + 1) else { return }
            try? await Task.sleep(for: .seconds(1))
            switch arguments[index + 1] {
            case "changes":
                navigation.pushViewController(WorkspaceChangesViewController(session: session, workspaceId: "w"), animated: false)
            case "file":
                chat.act(.openMessage("t-edit"))
                try? await Task.sleep(for: .seconds(1))
                (navigation.topViewController as? AgentToolViewController)?.perform(.openMessageFile(id: "t-edit", file: "Sources/Cache/Store.swift"))
            case let name:
                let ids = ["bash": "t-bash", "edit": "t-edit", "plan": "t-plan", "mcp": "t-mcp", "failed": "t-push", "search": "t-search", "explore": "t-explore"]
                chat.act(.openMessage(ids[name] ?? name))
            }
        } catch {
            print("AGENT_TOOLS error: \(error)")
        }
    }
}
#endif
