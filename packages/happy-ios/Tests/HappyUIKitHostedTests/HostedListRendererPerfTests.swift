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

private struct ListPerfOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ListPerfNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// The legacy home and the legacy chat under the gym's frame meter. Prints
/// `LIST_PERF <screen> <renderer> run=N …`. Only with `HAPPY_LIST_PERF=1`
/// (`TEST_RUNNER_HAPPY_LIST_PERF=1` to xcodebuild), one test a process
/// (`-only-testing`): each takes over a minute and installs the meter.
@MainActor
final class HostedListRendererPerfTests: XCTestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        guard ProcessInfo.processInfo.environment["HAPPY_LIST_PERF"] == "1" else { throw XCTSkip("HAPPY_LIST_PERF is not 1") }
        LegacyFonts.registerBundledFonts()
        setenv("HAPPY_GYM_METER", "1", 1)
    }

    private func account() async throws -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ListPerfOffline(), connector: ListPerfNoSocket()
        )
        try await controller.signIn(Credentials(token: "list-perf", secret: Data(repeating: 41, count: 32)))
        return controller
    }

    private static func find(_ view: UIView, _ match: (UIView) -> Bool) -> UIView? {
        if match(view) { return view }
        for child in view.subviews { if let found = find(child, match) { return found } }
        return nil
    }

    private func run(_ label: String, window: UIWindow, scroll: UIView, script: String) async throws {
        GymFrameMeter.installIfAsked(in: window)
        // One window a process: run each test on its own (`-only-testing`).
        let meter = try XCTUnwrap(GymFrameMeter.shared)
        let button = try XCTUnwrap(Self.find(window) { $0.accessibilityIdentifier == "gym-meter" })
        scroll.accessibilityIdentifier = "transcript"
        setenv("HAPPY_GYM_SCRIPT", script, 1)
        for run in 0..<3 {
            meter.perform(NSSelectorFromString("runScript"))
            let deadline = ContinuousClock.now + .seconds(90)
            try await Task.sleep(for: .milliseconds(300))
            while button.accessibilityValue?.contains("scripting=1") == true, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            print("LIST_PERF \(label) run=\(run) \(button.accessibilityValue ?? "")")
        }
    }

    // MARK: Legacy home

    func testLegacyHome() async throws {
        let controller = try await account()
        let session = try XCTUnwrap(controller.session)
        let store = session.store
        try await Task.detached {
            try SeededAccount.seed(store)
            guard let template = try store.sessions().first else { return }
            try store.upsertSessions((0..<1000).map { index in
                var row = template
                row.id = "stress-\(index)"
                row.createdAt += Int64(index)
                var metadata = row.metadata?.objectValue ?? [:]
                metadata["lastMeaningfulMessageAt"] = .number(Double(SeededAccount.base + Int64(index)))
                metadata["summary"] = .object(["text": .string("Session \(index)")])
                row.metadata = .object(metadata)
                return row
            })
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        }.value
        let context = AppContext(account: controller, variant: .preview, version: "perf")
        let scene = try await hostedActiveScene()
        let root = LegacyHomeViewController(context: context, session: session)
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let start = ContinuousClock.now
        var list: SessionListViewController?
        while ContinuousClock.now < start + .seconds(20) {
            list = root.children.compactMap { $0 as? SessionListViewController }.first
            if let list, list.textEnvironment != nil, list.model.rows.count > 900 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let sessions = try XCTUnwrap(list)
        try await Task.sleep(for: .milliseconds(800))
        let scroll = try XCTUnwrap((sessions.view as? HomeUltraListView)?.list)
        try await run("home UltraList", window: window, scroll: scroll, script: "down*3 up*3 dragdown*2 dragup*2")
        await controller.signOut()
    }

    /// The seeded legacy home, light and dark, into `HAPPY_PREVIEW_DIR`.
    private func screens(grouping: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { throw XCTSkip("no HAPPY_PREVIEW_DIR") }
        for style in [UIUserInterfaceStyle.light, .dark] {
            let controller = try await account()
            let session = try XCTUnwrap(controller.session)
            let store = session.store
            try await Task.detached {
                try SeededAccount.seed(store)
                try store.addPendingSettings(["sessionListGrouping": .string(grouping)])
            }.value
            let context = AppContext(account: controller, variant: .preview, version: "perf")
            let scene = try await hostedActiveScene()
            let root = LegacyHomeViewController(context: context, session: session)
            let navigation = UINavigationController(rootViewController: root)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            let window = hostedKeyWindow(in: scene, root: navigation)
            window.overrideUserInterfaceStyle = style
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(2500))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let name = "home-\(grouping)-UltraList-\(style == .dark ? "dark" : "light").png"
            try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
            window.isHidden = true
            await controller.signOut()
        }
    }

    func testLegacyHomeScreens() async throws {
        for grouping in ["flat", "project"] { try await screens(grouping: grouping) }
    }

    // MARK: Legacy chat

    func testLegacyChat() async throws {
        let controller = try await account()
        let session = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .preview, version: "perf")
        let chat = LegacyChatViewController(context: context, session: session, sessionId: FixtureScenarios.prefix + "long")
        let home = UIViewController()
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.pushViewController(chat, animated: false)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let start = ContinuousClock.now
        var list: ChatListView?
        while ContinuousClock.now < start + .seconds(30) {
            list = Self.find(chat.view) { $0 is ChatListView } as? ChatListView
            if let list, list.isDisplayReady, list.plans.count > 20 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let rows = try XCTUnwrap(list)
        try await Task.sleep(for: .milliseconds(1000))
        try await run("chat UltraList", window: window, scroll: rows.ultra.list, script: "up*4 down*4 dragup*2 dragdown*2")
        navigation.popToRootViewController(animated: false)
        await controller.signOut()
    }

    // MARK: Agent chat

    /// 160 finished turns on agent `a`: a request, a command, a read and
    /// three paragraphs of answer each.
    private actor PerfComputer: AgentTransport {
        static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

        static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
            .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
        }

        static let runs: [JSONValue] = (0..<160).map { index in
            let answer = (0..<3).map { paragraph in
                "Paragraph \(paragraph) of answer \(index): the cache keeps **every** entry it read, `Cache.swift` evicts the oldest past its limit, and the test now waits for the write before it reads the file back."
            }.joined(separator: "\n\n")
            let blocks: [JSONValue] = [
                text("I'll run the tests first."),
                .object(["type": .string("tool_call"), "id": .string("\(index)-1"), "name": .string("exec_command"), "status": .string("completed"),
                         "presentation": .object(["type": .string("exec_command"), "command": .string("pnpm test --filter happy-ios")])]),
                text(answer),
            ]
            return .object(["id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000),
                            "reason": .string("completed"), "messages": .array([
                                message("u\(index)", role: "user", [text("Turn \(index): fix the failing cache test")]),
                                message("m\(index)", role: "agent", blocks),
                            ])])
        }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
            let value: JSONValue
            if path.contains("/agents/a/messages?") {
                value = .object(["hasMore": .bool(false), "runs": .array(Self.runs)])
            } else if path.hasSuffix("/agents/a/bootstrap") {
                value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
            } else {
                value = .object([:])
            }
            return .init(status: 200, body: try JSONEncoder().encode(value))
        }

        func close() {}
    }

    func testAgentChat() async throws {
        let computer = PerfComputer()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ListPerfOffline(), connector: ListPerfNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"perf-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        defer { Session.forget(pairing.id) }
        let context = AppContext(account: controller, variant: .preview, version: "perf")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "Cache", spaceId: nil, intro: nil)
        let navigation = UINavigationController(rootViewController: chat)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let start = ContinuousClock.now
        while ContinuousClock.now < start + .seconds(30), chat.plans.count < 300 {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertGreaterThanOrEqual(chat.plans.count, 300, "the turns never came in")
        try await Task.sleep(for: .milliseconds(1000))
        let transcript = try XCTUnwrap(Self.find(chat.view) { $0 is AgentChatUltraList } as? AgentChatUltraList)
        try await run("agent UltraList", window: window, scroll: transcript.list, script: "up*4 down*4 dragup*2 dragdown*2")
        try? await controller.agentConnections.remove(pairing.id)
    }
}
#endif
