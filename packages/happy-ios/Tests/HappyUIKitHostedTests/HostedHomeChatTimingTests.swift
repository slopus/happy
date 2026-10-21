#if canImport(UIKit)
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct HomeTapOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct HomeTapNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Each timing scenario runs as the first chat in a fresh test process on
/// both revisions. Selects through Home's real table delegate, and samples
/// presentation geometry: merely installing a destination is not a frame.
@MainActor
final class HostedHomeChatTimingTests: XCTestCase {
    func testColdShortHomeSelection() async throws { try await measure(id: "seeded-tab-4", heavy: false) }
    func testColdHeavyHomeSelection() async throws { try await measure(id: "seeded-tab-2", heavy: true) }

    private func wait(_ condition: () -> Bool) async throws {
        let limit = ContinuousClock.now + .seconds(15)
        while !condition(), ContinuousClock.now < limit { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition())
    }

    private func measure(id: String, heavy: Bool) async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: HomeTapOffline(), connector: HomeTapNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 3, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
            if heavy {
                let body = String(repeating: "let value = compute(input) // file content\n", count: 70)
                let completed = Dictionary(uniqueKeysWithValues: (0..<300).map { index in
                    ("toolu_\(index)", JSONValue.object([
                        "tool": .string("Write"), "arguments": .object(["content": .string(body)]),
                        "createdAt": .number(Double(SeededAccount.base)), "status": .string("approved")
                    ]))
                })
                _ = try store.applySessionUpdate(id: id, metadata: nil,
                    agentState: VersionedPayload(version: 5, cipher: "harness", value: .object([
                        "requests": .object([:]), "completedRequests": .object(completed)
                    ])), projectId: nil)
            }
        }.value
        let context = AppContext(account: controller, variant: .preview, version: "timing")
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let root = HomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true; original?.makeKey() }
        window.layoutIfNeeded()
        var list: SessionListViewController?
        try await wait {
            list = root.children.compactMap { $0 as? SessionListViewController }.first
            return list?.model.index(ofSession: id) != nil && list?.textEnvironment != nil
        }
        let sessions = try XCTUnwrap(list)
        let table = try XCTUnwrap(sessions.view as? UITableView)
        let path = IndexPath(row: try XCTUnwrap(sessions.model.index(ofSession: id)), section: 0)
        table.scrollToRow(at: path, at: .middle, animated: false)
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))

        var firstMovement: CFTimeInterval?
        var completed: CFTimeInterval?
        var samples = 0
        var times: [CFTimeInterval] = []
        var positions: [CGFloat] = []
        let frames = HomeTapFrames {
            times.append(CACurrentMediaTime())
            guard let chat = navigation.topViewController as? ChatViewController,
                  chat.isViewLoaded, chat.view.window != nil else { return }
            let x = chat.view.layer.presentation()?.convert(.zero, to: window.layer.presentation()).x
            if let x { positions.append(x) }
            if let x, x > 0.5, x < window.bounds.width - 0.5, firstMovement == nil {
                firstMovement = CACurrentMediaTime()
            }
            samples += 1
            if navigation.transitionCoordinator == nil { completed = CACurrentMediaTime() }
        }
        let busy = HomeTapBusyWatch()
        let tapped = CACurrentMediaTime()
        sessions.tableView(table, didSelectRowAt: path)
        let returned = CACurrentMediaTime()
        try await wait { completed != nil }
        frames.stop()
        let longest = busy.stop()
        XCTAssertNotNil(firstMovement, "must observe the moving presentation layer")
        print("HOMEPOSITIONS \(positions.prefix(12))")
        let gaps = zip(times, times.dropFirst()).map { $1 - $0 }
        print(String(format: "HOMETAP %@ dispatch %.2f firstMovement %.2f end %.2f frames %d longestMain %.2f frameGap %.2f",
                     heavy ? "heavy" : "short", (returned - tapped) * 1000,
                     ((firstMovement ?? tapped) - tapped) * 1000, ((completed ?? tapped) - tapped) * 1000, samples,
                     longest * 1000, (gaps.max() ?? 0) * 1000))
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        try await wait { chat.openingReport != nil }
        if let optional = Mirror(reflecting: chat).children.first(where: { $0.label == "construction" })?.value,
           let construction = Mirror(reflecting: optional).children.first?.value,
           let stages = Mirror(reflecting: construction).children.first(where: { $0.label == "stageSeconds" })?.value as? [Double] {
            print("HOMESTAGES ms \(stages.map { String(format: "%.2f", $0 * 1000) }.joined(separator: ","))")
        }
        XCTAssertNotNil(chat.navigationItem.title)
        navigation.popToRootViewController(animated: false)
        await controller.signOut()
        withExtendedLifetime(window) {}
    }
}

@MainActor
private final class HomeTapFrames: NSObject {
    private var link: CADisplayLink?
    private let body: () -> Void
    init(_ body: @escaping () -> Void) {
        self.body = body
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }
    @objc private func tick() { body() }
    func stop() { link?.invalidate(); link = nil }
}

@MainActor
private final class HomeTapBusyWatch {
    private var woke = CACurrentMediaTime()
    private var longest: CFTimeInterval = 0
    private var observers: [CFRunLoopObserver] = []
    init() {
        let wake = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.woke = CACurrentMediaTime() }
        }
        let sleep = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.longest = max(self.longest, CACurrentMediaTime() - self.woke)
            }
        }
        observers = [wake, sleep].compactMap { $0 }
        for observer in observers { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }
    func stop() -> CFTimeInterval {
        for observer in observers { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observers = []
        return longest
    }
}
#endif
