#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct NavigationNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct NavigationNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Measures the production route through a seeded account, including a cold
/// first chat from a bare host. Home's real root is validated separately:
/// it has already initialized UI that the bare host leaves cold. Display-link
/// timestamps approximate presentation; they do not measure touch delivery
/// or prove when pixels reach the physical display.
@MainActor
final class HostedNavigationTimingTests: XCTestCase {
    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        guard condition() else {
            XCTFail("navigation did not settle; application state \(UIApplication.shared.applicationState.rawValue)")
            throw URLError(.timedOut)
        }
    }

    func testHowLongATapTakesToMoveTheScreen() async throws {
        try await measure(fromHome: false)
    }

    func testOpeningChatsFromTheRealHomeRoot() async throws {
        try await measure(fromHome: true)
    }

    private func measure(fromHome: Bool) async throws {
        let idle = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        defer { UIApplication.shared.isIdleTimerDisabled = idle }
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NavigationNoNetwork(), connector: NavigationNoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 3, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached {
            try SeededAccount.seed(store)
            let body = String(repeating: "let value = compute(input) // file content\n", count: 70)
            let completed = Dictionary(uniqueKeysWithValues: (0..<300).map { index in
                ("toolu_\(index)", JSONValue.object([
                    "tool": .string("Write"), "arguments": .object(["content": .string(body)]),
                    "createdAt": .number(Double(SeededAccount.base)), "status": .string("approved")
                ]))
            })
            _ = try store.applySessionUpdate(id: "seeded-tab-2", metadata: nil,
                agentState: VersionedPayload(version: 5, cipher: "harness", value: .object([
                    "controlledByUser": .bool(false), "requests": .object([:]), "completedRequests": .object(completed)
                ])), projectId: nil)
        }.value
        let home = Task { for await _ in account.homeFeed.snapshots() {} }
        defer { home.cancel() }
        try await until { account.homeFeed.latest?.sessions.isEmpty == false }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let homeStarted = CACurrentMediaTime()
        let homeWatch = NavigationBusyWatch()
        let root: UIViewController = fromHome ? HomeViewController(context: context, session: account) : UIViewController()
        root.view.backgroundColor = .systemBackground
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true; hostWindow?.makeKey() }
        window.layoutIfNeeded()
        if fromHome {
            try await until { root.view.subviews.contains { $0 is HomeDockView && !$0.isHidden } }
            window.layoutIfNeeded()
        }
        let homeTurns = homeWatch.stop()
        if fromHome {
            print(String(format: "NAVHOME setup %.1f longest %.1f", (CACurrentMediaTime() - homeStarted) * 1000,
                (homeTurns.map(\.length).max() ?? 0) * 1000))
        }
        try await Task.sleep(for: .milliseconds(300))
        let scenarios: [(String, Route?)] = [
            ("chat short", .session(id: "seeded-tab-4")),
            ("empty", nil), ("chat 1MB state", .session(id: "seeded-tab-2")),
            ("chat 300 messages", .session(id: "seeded-main")),
            ("session info", .sessionInfo(id: "seeded-tab-4")),
            ("settings", .settings), ("appearance", .settingsAppearance)
        ]
        print("NAVROOT \(fromHome ? "Home" : "bare")")
        print("NAVTIME device \(UIDevice.current.model) iOS \(UIDevice.current.systemVersion)")
        let selected = fromHome ? scenarios.filter { $0.0 == "chat short" || $0.0 == "chat 1MB state" } : scenarios
        for (name, route) in selected {
            for attempt in 0..<(fromHome ? 1 : 4) {
                try await until { navigation.topViewController === root && navigation.transitionCoordinator == nil }
                XCTAssertEqual(scene.activationState, .foregroundActive)
                let watch = NavigationBusyWatch()
                var first: CFTimeInterval?
                var end: CFTimeInterval?
                var destination: UIViewController?
                let frames = NavigationFrames { link in
                    guard let top = navigation.topViewController, top !== root,
                          top.isViewLoaded, top.view.window != nil else { return }
                    if destination == nil { destination = top }
                    guard top === destination else { return }
                    if first == nil { first = link.targetTimestamp }
                    if top.transitionCoordinator == nil && navigation.transitionCoordinator == nil { end = link.targetTimestamp }
                }
                let tapped = CACurrentMediaTime()
                if let route { root.push(route, context: context) }
                else {
                    let empty = UIViewController()
                    empty.view.backgroundColor = UIColor(Palette.groupedBackground)
                    empty.setPlainHeaderTitle("Session info screen")
                    navigation.pushViewController(empty, animated: true)
                }
                do { try await until { end != nil } }
                catch { frames.stop(); _ = watch.stop(); throw error }
                frames.stop()
                let turns = watch.stop().filter { $0.start + $0.length >= tapped }
                let ready = (destination as? ChatViewController)?.openingReport
                if fromHome {
                    XCTAssertTrue(destination is ChatViewController)
                    XCTAssertEqual(ready?.missing, [])
                }
                print(String(format: "NAVTIME %@ try %d first %.1f end %.1f longest %.1f ready %.1f missing %@",
                    name, attempt, ((first ?? tapped) - tapped) * 1000, ((end ?? tapped) - tapped) * 1000,
                    (turns.map(\.length).max() ?? 0) * 1000, (ready?.elapsed ?? 0) * 1000,
                    ready?.missing.description ?? "[]"))
                if let chat = destination as? ChatViewController {
                    print(String(format: "NAVBUILD %@ try %d construction %.1f load %.1f layout %.1f",
                        name, attempt, chat.constructionSeconds * 1000, chat.loadingSeconds * 1000, chat.openingLayoutSeconds * 1000))
                }
                navigation.popToRootViewController(animated: false)
                try await until { navigation.topViewController === root && navigation.transitionCoordinator == nil }
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        await controller.signOut()
        withExtendedLifetime(window) {}
    }
}

@MainActor
private final class NavigationFrames: NSObject {
    private var link: CADisplayLink?
    private let body: (CADisplayLink) -> Void
    init(_ body: @escaping (CADisplayLink) -> Void) {
        self.body = body
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }
    @objc private func tick(_ link: CADisplayLink) { body(link) }
    func stop() { link?.invalidate(); link = nil }
}

@MainActor
private final class NavigationBusyWatch {
    private var woke = CACurrentMediaTime()
    private var isAwake = true
    private var turns: [(start: CFTimeInterval, length: CFTimeInterval)] = []
    private var observers: [CFRunLoopObserver] = []
    init() {
        let wake = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { [weak self] _, _ in
            MainActor.assumeIsolated {
                self?.woke = CACurrentMediaTime()
                self?.isAwake = true
            }
        }
        let sleep = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.turns.append((self.woke, CACurrentMediaTime() - self.woke))
                self.isAwake = false
            }
        }
        observers = [wake, sleep].compactMap { $0 }
        for observer in observers { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }
    func stop() -> [(start: CFTimeInterval, length: CFTimeInterval)] {
        // Home can finish setup without yielding once. Include the current
        // partial turn instead of incorrectly reporting zero busy time.
        if isAwake { turns.append((woke, CACurrentMediaTime() - woke)) }
        for observer in observers { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observers = []
        return turns
    }
}
#endif