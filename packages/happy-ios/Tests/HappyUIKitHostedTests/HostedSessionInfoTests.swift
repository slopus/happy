#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

/// Session info as the chat's avatar opens it, over a store holding the
/// session, in a window of a real scene: its groups must be on screen, and
/// a long session's (an agent state of hundreds of requests, megabytes of
/// raw JSON in Debug) must open without holding the main thread.
@MainActor
final class HostedSessionInfoTests: XCTestCase {
    private static let sessionId = "info-session"
    /// 2026-10-16 09:00 UTC.
    private static let base: Int64 = 1_792_141_200_000

    private func signedIn(agentState: JSONValue) async throws -> (AccountController, AccountSession) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 3, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        let record = Self.session(agentState: agentState)
        try await Task.detached { try store.upsertSessions([record]) }.value
        return (controller, account)
    }

    private static func session(agentState: JSONValue) -> SessionRecord {
        SessionRecord(
            id: sessionId, seq: 3, createdAt: base, updatedAt: base + 30_000,
            active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000), projectId: nil,
            metadataVersion: 1, metadataCipher: "test",
            metadata: .object([
                "path": .string("/Users/test/happy"), "host": .string("test-mac"), "homeDir": .string("/Users/test"),
                "machineId": .string("test-mac"), "flavor": .string("claude"), "version": .string("1.0.0"),
                "os": .string("darwin"), "summary": .object(["text": .string("Session info screen"), "updatedAt": .number(Double(base))]),
                "claudeSessionId": .string("claude-info-session"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: agentState,
            dataKeyCipher: nil, decryptable: true
        )
    }

    /// A long session's agent state: every permission it was asked, with
    /// the arguments (a Write's whole file): about 1 MB of JSON.
    private static func longAgentState(requests: Int = 300, argumentBytes: Int = 3000) -> JSONValue {
        let body = String(repeating: "let value = compute(input) // line of a file the agent wrote\n", count: max(1, argumentBytes / 60))
        var completed: [String: JSONValue] = [:]
        for index in 0..<requests {
            completed["toolu_\(index)"] = .object([
                "tool": .string(index.isMultiple(of: 2) ? "Write" : "Edit"),
                "arguments": .object([
                    "file_path": .string("/Users/test/happy/Sources/File\(index).swift"),
                    "content": .string(body),
                ]),
                "createdAt": .number(Double(base + Int64(index) * 1000)),
                "completedAt": .number(Double(base + Int64(index) * 1000 + 500)),
                "status": .string("approved"),
            ])
        }
        return .object(["controlledByUser": .bool(false), "requests": .object([:]), "completedRequests": .object(completed)])
    }

    private func hosted() async throws -> (UIWindow, UINavigationController, UIViewController) {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let root = UIViewController()
        root.view.backgroundColor = .systemBackground
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (window, navigation, root)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func subviews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { child in (child as? T).map { [$0] } ?? subviews(type, in: child) }
    }

    /// The groups the screen shows, once the push is over.
    private func shownGroups(_ info: SessionInfoViewController, in window: UIWindow) -> [ItemGroupView] {
        guard info.transitionCoordinator == nil, let list = subviews(GroupedListView.self, in: info.view).first else { return [] }
        return list.sections.compactMap { $0 as? ItemGroupView }
    }

    func testTheAvatarOpensSessionInfoWithItsGroupsOnScreen() async throws {
        let (controller, _) = try await signedIn(agentState: .object(["controlledByUser": .bool(false)]))
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        root.push(.session(id: Self.sessionId), context: context)
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        var avatar: ChatHeaderAvatarControl? {
            chat.navigationItem.rightBarButtonItems?.compactMap { $0.customView as? ChatHeaderAvatarControl }.first
        }
        // In the bar once the chat is loaded, shown once its record is in.
        let shown = try await until { chat.transitionCoordinator == nil && avatar.map { !$0.isHidden && $0.window != nil } == true }
        XCTAssertTrue(shown, "the avatar never showed")
        try XCTUnwrap(avatar).sendActions(for: .touchUpInside)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(opened, "session info showed no groups")
        info.view.layoutIfNeeded()
        let groups = shownGroups(info, in: window)
        let screen = window.bounds
        for (index, group) in groups.enumerated() {
            let frame = group.convert(group.bounds, to: window)
            XCTAssertGreaterThan(frame.width, 0, "group \(index)")
            XCTAssertGreaterThan(frame.height, 0, "group \(index)")
            XCTAssertFalse(group.rows.isEmpty, "group \(index)")
            for (row, view) in group.rows.enumerated() {
                XCTAssertGreaterThan(view.bounds.height, 0, "group \(index) row \(row)")
            }
        }
        // The first group sits under the bar, on screen.
        let first = try XCTUnwrap(groups.first)
        let firstFrame = first.convert(first.bounds, to: window)
        XCTAssertTrue(screen.contains(firstFrame.origin), "\(firstFrame)")
        XCTAssertGreaterThanOrEqual(firstFrame.minY, navigation.navigationBar.frame.maxY - 1)
        XCTAssertEqual(info.title, "Session info screen")
        await controller.signOut()
    }

    func testALongSessionsInfoOpensWithoutHoldingTheMainThread() async throws {
        let (controller, _) = try await signedIn(agentState: Self.longAgentState())
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        var ticks: [CFTimeInterval] = []
        let recorder = TickRecorder { ticks.append($0) }
        defer { recorder.stop() }
        let started = CACurrentMediaTime()
        root.push(.sessionInfo(id: Self.sessionId), context: context)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
        let openedAfter = CACurrentMediaTime() - started
        XCTAssertTrue(opened, "session info showed no groups")
        XCTAssertLessThan(openedAfter, 2, "groups took \(openedAfter) s")
        #if DEBUG
        // "Raw JSON (Dev Mode)": the agent state twice (on its own and in
        // the session), laid out off the main thread.
        let blocks = subviews(CodeBlockView.self, in: info.view)
        XCTAssertEqual(blocks.count, 3)
        let measured = try await until(seconds: 20) { blocks.allSatisfy { $0.bounds.height > 1000 || $0.code.utf16.count < 10_000 } }
        XCTAssertTrue(measured, "the raw JSON was never laid out")
        let list = try XCTUnwrap(subviews(GroupedListView.self, in: info.view).first)
        // Below the screen: at most the first pieces within a screen of
        // it are drawn, and nothing of the last block.
        for block in blocks { XCTAssertLessThanOrEqual(block.drawnPieces.count, 4, "\(block.drawnPieces)") }
        XCTAssertEqual(blocks.last?.drawnPieces, [])
        // Scrolled into the agent state's block, only what is near is drawn.
        let long = try XCTUnwrap(blocks.max { $0.bounds.height < $1.bounds.height })
        let middle = long.convert(CGPoint(x: 0, y: long.bounds.midY), to: list)
        list.contentOffset = CGPoint(x: 0, y: middle.y - list.bounds.height / 2)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(long.drawnPieces.isEmpty)
        XCTAssertLessThanOrEqual(long.drawnPieces.count, 8, "\(long.drawnPieces)")
        #endif
        try await Task.sleep(for: .milliseconds(300))
        recorder.stop()
        let gaps = zip(ticks, ticks.dropFirst()).map { $1 - $0 }
        let longest = gaps.max() ?? .infinity
        // Frames the main thread made late, and by how much in all.
        let late = gaps.filter { $0 > 0.025 }
        print(String(
            format: "SESSIONINFO groups after %.0f ms; longest main-thread frame gap %.0f ms; %d late frames, %.0f ms late in all, over %d frames",
            openedAfter * 1000, longest * 1000, late.count, late.map { $0 - 1.0 / 60 }.reduce(0, +) * 1000, ticks.count
        ))
        XCTAssertLessThan(longest, 0.25, "the main thread was held \(longest) s")
        await controller.signOut()
    }
}
#endif
