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
        // A chat is readied before it is pushed (`ChatOpening`).
        let pushed = try await until { navigation.topViewController is ChatViewController }
        XCTAssertTrue(pushed, "the chat was never pushed")
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

    #if DEBUG
    /// The groups are made a few rows a frame, out of sight, and join the
    /// list in one frame, every label in them having drawn its text once.
    func testItsGroupsAreMadeAFewRowsAFrameAndShownTogether() async throws {
        let (controller, _) = try await signedIn(agentState: Self.longAgentState())
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        // Once to warm up, then the open that is checked.
        for attempt in 0..<2 {
            root.push(.sessionInfo(id: Self.sessionId), context: context)
            let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
            let list = try XCTUnwrap(subviews(GroupedListView.self, in: info.view).first)
            var shown: [Int] = []
            let recorder = TickRecorder { _ in shown.append(list.sections.count) }
            let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
            recorder.stop()
            XCTAssertTrue(opened, "session info showed no groups")
            try await Task.sleep(for: .milliseconds(100))
            guard attempt == 1 else {
                navigation.popToRootViewController(animated: false)
                try await Task.sleep(for: .milliseconds(150))
                continue
            }
            let groups = list.sections.count
            XCTAssertEqual(groups, 6, "quick actions, details, metadata, agent state, activity, raw JSON")
            // Never some of the groups: none, then all.
            XCTAssertTrue(Set(shown).isSubset(of: [0, groups]), "\(shown)")
            let steps = info.slices.map(\.steps).reduce(0, +)
            let rows = list.sections.compactMap { $0 as? ItemGroupView }.map(\.rows.count).reduce(0, +)
            // A step starts a group, makes a row or finishes a group.
            XCTAssertGreaterThanOrEqual(steps, rows + 2 * groups, "\(info.slices)")
            XCTAssertGreaterThan(info.slices.count, 1, "made in one frame: \(info.slices)")
            print("SESSIONINFO-SLICES " + info.slices.map { String(format: "%.2f ms × %d", $0.seconds * 1000, $0.steps) }.joined(separator: ", "))
            let labels = list.sections.flatMap { subviews(StyledLabel.self, in: $0) }
            XCTAssertGreaterThan(labels.count, 50)
            XCTAssertEqual(labels.filter { $0.renders != 1 }.map { "\($0.string): \($0.renders)" }, [])
            // Nothing is left out of sight.
            XCTAssertEqual(subviews(ItemGroupView.self, in: info.view).count, groups)
        }
        await controller.signOut()
    }
    #endif

    /// The longest the main thread is busy at a stretch while session info
    /// is pushed and shows its groups, against the same push of an empty
    /// screen with its title: the turn that pushes, and the busiest turn
    /// after it. The first open is the first in the process when the test
    /// runs on its own. Printed, for the record.
    func testHowLongOpeningSessionInfoHoldsTheMainThread() async throws {
        let (controller, _) = try await signedIn(agentState: Self.longAgentState())
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        var lines: [String] = []
        var info: [Opening] = []
        for _ in 0..<8 {
            let watch = BusyWatch()
            let pushed = CACurrentMediaTime()
            root.push(.sessionInfo(id: Self.sessionId), context: context)
            let screen = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
            let opened = try await until { !self.shownGroups(screen, in: window).isEmpty }
            XCTAssertTrue(opened, "session info showed no groups")
            try await Task.sleep(for: .milliseconds(500))
            let opening = Opening(turns: watch.stop(), pushed: pushed)
            info.append(opening)
            lines.append("session info: \(opening)")
            #if DEBUG
            lines.append("  making " + screen.slices.map { String(format: "%.2f ms × %d", $0.seconds * 1000, $0.steps) }.joined(separator: ", "))
            #endif
            navigation.popToRootViewController(animated: false)
            try await Task.sleep(for: .milliseconds(150))
        }
        var bare: [Opening] = []
        for _ in 0..<8 {
            let watch = BusyWatch()
            let pushed = CACurrentMediaTime()
            let screen = UIViewController()
            screen.followsTextSize()
            screen.view.backgroundColor = UIColor(Palette.groupedBackground)
            screen.setPlainHeaderTitle("Session info screen")
            navigation.pushViewController(screen, animated: true)
            try await Task.sleep(for: .milliseconds(1000))
            let opening = Opening(turns: watch.stop(), pushed: pushed)
            bare.append(opening)
            lines.append("empty screen: \(opening)")
            navigation.popToRootViewController(animated: false)
            try await Task.sleep(for: .milliseconds(150))
        }
        for (name, openings) in [("session info", info), ("empty screen", bare)] {
            lines.append("\(name): push turn \(Self.summary(openings.map(\.push))); busiest after it \(Self.summary(openings.map(\.busiestAfter)))")
        }
        for line in lines { print("SESSIONINFO-OPEN \(line)") }
        await controller.signOut()
    }

    /// The main thread's turns while a screen opens, from the push.
    private struct Opening: CustomStringConvertible {
        var turns: [(start: CFTimeInterval, length: CFTimeInterval)]
        var pushed: CFTimeInterval

        /// The turn the push was made in, in ms.
        var push: Double {
            (turns.first { $0.start <= pushed && $0.start + $0.length >= pushed }?.length ?? 0) * 1000
        }

        /// The busiest turn after that one, in ms.
        var busiestAfter: Double {
            (turns.filter { $0.start > pushed }.map(\.length).max() ?? 0) * 1000
        }

        /// Each turn over 2 ms: when it started after the push, and how long
        /// it ran, in ms.
        var description: String {
            let long = turns.filter { $0.length > 0.002 }.map {
                String(format: "%+.0f: %.1f", ($0.start - pushed) * 1000, $0.length * 1000)
            }
            return String(format: "push turn %.1f ms, busiest after it %.1f ms; turns over 2 ms [%@]", push, busiestAfter, long.joined(separator: ", "))
        }
    }

    /// First, then the median and slowest of the rest.
    private static func summary(_ values: [Double]) -> String {
        let rest = values.dropFirst().sorted()
        return String(format: "first %.2f ms, then median %.2f ms, slowest %.2f ms", values.first ?? 0, rest.isEmpty ? 0 : rest[rest.count / 2], rest.last ?? 0)
    }
}

/// How long each turn of the main run loop is busy, from waking to going to
/// sleep again, layout and drawing included.
@MainActor
private final class BusyWatch {
    private var turns: [(start: CFTimeInterval, length: CFTimeInterval)] = []
    private var woke = CACurrentMediaTime()
    private var observers: [CFRunLoopObserver] = []

    init() {
        let wake = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.woke = CACurrentMediaTime() }
        }
        let sleep = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.turns.append((self.woke, CACurrentMediaTime() - self.woke))
            }
        }
        observers = [wake, sleep].compactMap { $0 }
        for observer in observers { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }

    /// Stops watching; every turn: when it woke, and how long it ran.
    func stop() -> [(start: CFTimeInterval, length: CFTimeInterval)] {
        for observer in observers { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observers = []
        return turns
    }
}
#endif
