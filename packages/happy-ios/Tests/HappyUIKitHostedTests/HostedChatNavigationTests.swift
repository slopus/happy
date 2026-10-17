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

/// The chat reached as the app reaches it, over a store holding real
/// sessions (`SeededAccount`): pushed from a list, its worktree strip
/// switching chats in place. Hosted, so the screens are in a window of a
/// real scene, under a real navigation bar, and every frame of a
/// transition is sampled. Navigation starts with a shell; once deferred
/// content is ready, its geometry remains stable.
@MainActor
final class HostedChatNavigationTests: XCTestCase {
    func testPushInstallsOnlyTheShellBeforeReturning() async throws {
        let (controller, _) = try await signedIn()
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (_, navigation, root) = try await hosted()
        root.push(.session(id: "seeded-tab-4"), context: context)
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController,
                                 "navigation must start synchronously, before any readiness callback")
        XCTAssertFalse(chat.contentInstalled)
        XCTAssertEqual(chat.navigationItem.title, "Scroll indicator")
        XCTAssertNil(Self.subview(ChatListView.self, in: chat.view))
        XCTAssertNil(Self.subview(AgentInputCardView.self, in: chat.view))
        let ready = try await until { chat.contentInstalled && chat.openingReport != nil }
        XCTAssertTrue(ready)
        XCTAssertNotNil(Self.subview(AgentInputCardView.self, in: chat.view))
        XCTAssertEqual(chat.navigationItem.title, "chat-nav")
        print("CHATCONSTRUCTION milliseconds \(chat.constructionStageSeconds.map { $0 * 1000 })")
        await controller.signOut()
    }

    func testPopBeforeTheFirstFrameCancelsContentConstruction() async throws {
        let (controller, _) = try await signedIn()
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (_, navigation, root) = try await hosted()
        root.push(.session(id: "seeded-tab-4"), context: context, animated: false)
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        navigation.popViewController(animated: false)
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertFalse(chat.contentInstalled)
        XCTAssertNil(Self.subview(AgentInputCardView.self, in: chat.view))
        XCTAssertNil(chat.openingReport)
        await controller.signOut()
    }

    func testAccountChangeCancelsContentForTheOldAccount() async throws {
        let (controller, _) = try await signedIn()
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (_, navigation, root) = try await hosted()
        root.push(.session(id: "seeded-tab-4"), context: context, animated: false)
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        await controller.signOut()
        let completedStages = chat.constructionStageSeconds.count
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(chat.constructionStageSeconds.count, completedStages,
                       "no additional views may be constructed for a signed-out account")
    }

    func testUpdatesDuringConstructionAndAfterReadinessReachTheHeader() async throws {
        let (controller, account) = try await signedIn()
        let store = account.store
        try await Task.detached {
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        }.value
        let flat = try await until {
            account.homeFeed.latest.map { AccountSettings($0.settings).sessionListGrouping == .flat } == true
        }
        XCTAssertTrue(flat)
        let record = try XCTUnwrap(account.homeFeed.latest?.sessions.first { $0.id == "seeded-tab-4" })
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (_, navigation, root) = try await hosted()
        root.push(.session(id: record.id), context: context)
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        for (version, title) in [(2, "Changed while opening"), (3, "Changed after opening")] {
            var metadata = record.metadata?.objectValue ?? [:]
            metadata["summary"] = .object(["text": .string(title), "updatedAt": .number(Double(version))])
            let payload = VersionedPayload(version: version, cipher: "updated", value: JSONValue.object(metadata))
            _ = try await Task.detached {
                try store.applySessionUpdate(id: record.id, metadata: payload, agentState: nil, projectId: nil)
            }.value
            let updated = try await until { chat.navigationItem.title == title && chat.openingReport != nil }
            XCTAssertTrue(updated, "the newest session must survive deferred construction and remain observed")
        }
        await controller.signOut()
    }
    private func signedIn() async throws -> (AccountController, AccountSession) {
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
        try await Task.detached { try SeededAccount.seed(store) }.value
        // Home, under every chat, keeps the account's home feed read.
        let home = Task { for await _ in account.homeFeed.snapshots() {} }
        addTeardownBlock { home.cancel() }
        return (controller, account)
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
        // Lets the home feed land once, as home would have.
        try await Task.sleep(for: .milliseconds(300))
        return (window, navigation, root)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    /// The chat on top once `action` put a new one there.
    private func shown(after action: () -> Void, in navigation: UINavigationController) async throws -> ChatViewController {
        let before = navigation.topViewController
        action()
        let arrived = try await until { navigation.topViewController !== before && navigation.topViewController is ChatViewController }
        XCTAssertTrue(arrived, "no chat was shown")
        return try XCTUnwrap(navigation.topViewController as? ChatViewController)
    }

    private func settled(_ chat: ChatViewController, in navigation: UINavigationController) async throws {
        let done = try await until { navigation.transitionCoordinator == nil && chat.view.window != nil }
        XCTAssertTrue(done)
        try await Task.sleep(for: .milliseconds(300))
    }

    /// The header, the status line and the strip were drawn from the home
    /// snapshot (`ChatServices.seed`): never waited for, and the store's
    /// own answer, the same, changed nothing.
    private static func assertSeeded(_ chat: ChatViewController, _ report: ChatOpening.Report, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(report.arrivals["session"], "\(label): waited for the record", file: file, line: line)
        XCTAssertNil(report.arrivals["checkout"], "\(label): waited for the checkout", file: file, line: line)
        XCTAssertEqual(chat.sessionUpdates, 0, "\(label): the store's record changed the screen", file: file, line: line)
    }

    // MARK: A push

    func testAPushedChatDoesNotMoveAfterItsContentIsReady() async throws {
        let (controller, _) = try await signedIn()
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (_, navigation, root) = try await hosted()
        let sampler = ChatFrameSampler(navigation: navigation)
        let chat = try await shown(after: { root.push(.session(id: "seeded-tab-4"), context: context) }, in: navigation)
        try await settled(chat, in: navigation)
        let sampled = try await until { sampler.frames.filter { $0.chat === chat && $0.inWindow && $0.ready }.count >= 12 }
        XCTAssertTrue(sampled, "sample the ready chat across enough display frames")
        sampler.stop()
        let report = try XCTUnwrap(chat.openingReport)
        print(String(format: "OPENING push ready after %.1f ms, missing %@", report.elapsed * 1000, report.missing.description))
        Self.assertStill(sampler.frames, report: report, "push")
        Self.assertSeeded(chat, report, "push")
        // The header is whole: the capsule and the avatar, the strip.
        let last = try XCTUnwrap(sampler.frames.last)
        XCTAssertGreaterThan(last.title.width, 40, "the title capsule")
        XCTAssertTrue(last.avatar, "the avatar")
        XCTAssertNotNil(last.strip, "the strip")
        XCTAssertGreaterThan(last.rows, 0)
        await controller.signOut()
    }

    // MARK: A tab switch

    func testATabSwitchShowsTheChatAsAFreshOpenWould() async throws {
        let (controller, _) = try await signedIn()
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (_, navigation, root) = try await hosted()
        let first = try await shown(after: { root.push(.session(id: "seeded-tab-4"), context: context) }, in: navigation)
        try await settled(first, in: navigation)

        let sampler = ChatFrameSampler(navigation: navigation)
        let strip = try XCTUnwrap(Self.subview(ChatWorktreeTabStrip.self, in: first.view))
        let switched = try await shown(after: { strip.onSelect?("seeded-tab-3") }, in: navigation)
        try await settled(switched, in: navigation)
        let sampled = try await until { sampler.frames.filter { $0.chat === switched && $0.inWindow && $0.ready }.count >= 12 }
        XCTAssertTrue(sampled, "sample the ready tab across enough display frames")
        sampler.stop()
        let report = try XCTUnwrap(switched.openingReport)
        print(String(format: "OPENING switch ready after %.1f ms, missing %@", report.elapsed * 1000, report.missing.description))
        XCTAssertEqual(navigation.viewControllers.count, 2, "a switch replaces the chat, it pushes nothing")
        Self.assertStill(sampler.frames.filter { $0.chat === switched }, report: report, "switch")
        Self.assertSeeded(switched, report, "switch")
        let afterSwitch = try XCTUnwrap(sampler.frames.last)

        // The same chat opened afresh from the list.
        navigation.popToRootViewController(animated: false)
        let fresh = try await shown(after: { root.push(.session(id: "seeded-tab-3"), context: context) }, in: navigation)
        try await settled(fresh, in: navigation)
        let freshFrames = ChatFrameSampler(navigation: navigation)
        try await Task.sleep(for: .milliseconds(100))
        freshFrames.stop()
        let opened = try XCTUnwrap(freshFrames.frames.last)
        XCTAssertEqual(afterSwitch.title, opened.title, "header")
        XCTAssertEqual(afterSwitch.avatar, opened.avatar, "avatar")
        XCTAssertEqual(afterSwitch.strip, opened.strip, "strip")
        XCTAssertEqual(afterSwitch.list, opened.list, "list")
        XCTAssertEqual(afterSwitch.insets, opened.insets, "list insets")
        XCTAssertEqual(afterSwitch.dock, opened.dock, "dock")
        XCTAssertEqual(afterSwitch.card, opened.card, "composer")
        XCTAssertEqual(afterSwitch.rows, opened.rows, "rows")
        await controller.signOut()
    }

    // MARK: Rows past the cap

    /// A chat whose rows are slower than the cap (a 6 MB agent state, read
    /// with every change of the chat) is shown without them at the cap,
    /// and they land in place: nothing else moves, nothing animates.
    func testRowsPastTheCapLandWithoutMovingAnythingElse() async throws {
        let (controller, account) = try await signedIn()
        let store = account.store
        let state = Self.longAgentState(requests: 2000, argumentBytes: 3000)
        _ = try await Task.detached {
            try store.applySessionUpdate(
                id: "seeded-tab-2", metadata: nil,
                agentState: VersionedPayload(version: 5, cipher: "harness", value: state), projectId: nil
            )
        }.value
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (_, navigation, root) = try await hosted()
        let sampler = ChatFrameSampler(navigation: navigation)
        let chat = try await shown(after: { root.push(.session(id: "seeded-tab-2"), context: context) }, in: navigation)
        try await settled(chat, in: navigation)
        let landed = try await until(seconds: 10) { (sampler.frames.last?.rows ?? 0) > 0 }
        XCTAssertTrue(landed, "the rows never came")
        try await Task.sleep(for: .milliseconds(300))
        sampler.stop()
        let report = try XCTUnwrap(chat.openingReport)
        print(String(format: "OPENING late rows: shown after %.1f ms, missing %@", report.elapsed * 1000, report.missing.description))
        XCTAssertTrue(report.hitCap, "the rows came within the cap: make the agent state larger")
        XCTAssertTrue(report.missing.contains("rows"))
        XCTAssertTrue(Set(report.missing).isSubset(of: ChatOpening.mayComeLate), "only the rows may be late: \(report.missing)")
        let shown = sampler.frames.drop { !$0.inWindow }
        print("OPENING late rows: insets \(shown.first.map { "\($0.insets)" } ?? "-") → \(shown.last.map { "\($0.insets)" } ?? "-"), rows \(shown.first?.rows ?? 0) → \(shown.last?.rows ?? 0)")
        // Readiness is diagnostic; it no longer delays navigation.
        XCTAssertNotNil(chat.parent)
        Self.assertStill(sampler.frames, report: report, "late rows")
        Self.assertSeeded(chat, report, "late rows")
        await controller.signOut()
    }

    // MARK: Time to open

    /// A long session's agent state: every permission it was asked, with
    /// the arguments (a Write's whole file).
    private static func longAgentState(requests: Int, argumentBytes: Int) -> JSONValue {
        let body = String(repeating: "let value = compute(input) // line of a file the agent wrote\n", count: max(1, argumentBytes / 60))
        var completed: [String: JSONValue] = [:]
        for index in 0..<requests {
            completed["toolu_\(index)"] = .object([
                "tool": .string(index.isMultiple(of: 2) ? "Write" : "Edit"),
                "arguments": .object([
                    "file_path": .string("/Users/harness/happy/packages/happy-ios/Sources/File\(index).swift"),
                    "content": .string(body),
                ]),
                "createdAt": .number(Double(SeededAccount.base + Int64(index) * 1000)),
                "completedAt": .number(Double(SeededAccount.base + Int64(index) * 1000 + 500)),
                "status": .string("approved"),
            ])
        }
        return .object(["controlledByUser": .bool(false), "requests": .object([:]), "completedRequests": .object(completed)])
    }

    /// How long a chat takes to be whole, pushed from a list and switched
    /// to: a short one, one with a 1 MB agent state, one of 300 messages.
    /// Printed for the timing log; most tries must be in within the cap.
    func testHowLongAChatTakesToOpen() async throws {
        let (controller, account) = try await signedIn()
        let store = account.store
        let state = Self.longAgentState(requests: 300, argumentBytes: 3000)
        _ = try await Task.detached {
            try store.applySessionUpdate(
                id: "seeded-tab-2", metadata: nil,
                agentState: VersionedPayload(version: 5, cipher: "harness", value: state), projectId: nil
            )
        }.value
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (_, navigation, root) = try await hosted()
        var lines: [String] = []
        var capHits = 0
        var tries = 0
        for (name, id) in [("short", "seeded-tab-4"), ("long agent state", "seeded-tab-2"), ("300 messages", "seeded-main")] {
            var times: [Double] = []
            for _ in 0..<10 {
                var ticks: [CFTimeInterval] = []
                let recorder = TickRecorder { ticks.append($0) }
                let chat = try await shown(after: { root.push(.session(id: id), context: context) }, in: navigation)
                recorder.stop()
                try await settled(chat, in: navigation)
                let report = try XCTUnwrap(chat.openingReport)
                let gap = zip(ticks, ticks.dropFirst()).map { $1 - $0 }.max() ?? 0
                lines.append(String(format: "%@ longest main-thread gap while readying %.0f ms", name, gap * 1000))
                times.append(report.elapsed * 1000)
                if report.hitCap {
                    capHits += 1
                    lines.append("\(name): cap hit, missing \(report.missing)")
                }
                lines.append("\(name) arrivals " + Self.arrivals(report))
                Self.assertSeeded(chat, report, name)
                tries += 1
                navigation.popToRootViewController(animated: false)
                try await Task.sleep(for: .milliseconds(100))
            }
            lines.append(Self.summary("push \(name)", times))
        }
        // Switches between two tabs, back and forth.
        let first = try await shown(after: { root.push(.session(id: "seeded-tab-4"), context: context) }, in: navigation)
        try await settled(first, in: navigation)
        var times: [Double] = []
        for index in 0..<10 {
            let current = try XCTUnwrap(navigation.topViewController as? ChatViewController)
            let strip = try XCTUnwrap(Self.subview(ChatWorktreeTabStrip.self, in: current.view))
            let next = try await shown(after: { strip.onSelect?(index.isMultiple(of: 2) ? "seeded-tab-3" : "seeded-tab-4") }, in: navigation)
            try await settled(next, in: navigation)
            let report = try XCTUnwrap(next.openingReport)
            times.append(report.elapsed * 1000)
            if report.hitCap {
                capHits += 1
                lines.append("switch: cap hit, missing \(report.missing)")
            }
            lines.append("switch arrivals " + Self.arrivals(report))
            Self.assertSeeded(next, report, "switch")
            tries += 1
        }
        lines.append(Self.summary("switch", times))
        lines.append("cap hit \(capHits) of \(tries)")
        for line in lines { print("OPENING \(line)") }
        XCTAssertLessThan(capHits, tries / 4, lines.joined(separator: "\n"))
        await controller.signOut()
    }

    private static func arrivals(_ report: ChatOpening.Report) -> String {
        report.arrivals.sorted { $0.value < $1.value }.map { String(format: "%@ %.0f", $0.key, $0.value * 1000) }.joined(separator: ", ")
            + String(format: " → shown %.0f", report.elapsed * 1000)
    }

    private static func summary(_ name: String, _ times: [Double]) -> String {
        let sorted = times.sorted()
        let median = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
        return String(
            format: "%@: median %.2f ms, slowest %.2f ms, first %.2f ms (%@)",
            name, median, sorted.last ?? 0, times.first ?? 0, times.map { String(format: "%.1f", $0) }.joined(separator: " ")
        )
    }

    // MARK: Checks

    /// Every frame from the chat's first in the window: nothing in it moves
    /// or animates. Past the cap only the rows may land late.
    private static func assertStill(_ frames: [ChatFrame], report: ChatOpening.Report, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let shown = frames.drop { !$0.inWindow || !$0.ready }
        guard let first = shown.first else {
            XCTFail("\(label): the chat was never in the window", file: file, line: line)
            return
        }
        XCTAssertGreaterThan(shown.count, 10, "\(label): too few frames sampled", file: file, line: line)
        for frame in shown {
            let at = String(format: "%@ at %.0f ms", label, (frame.time - first.time) * 1000)
            XCTAssertEqual(frame.animating, [], "\(at): animating", file: file, line: line)
            XCTAssertEqual(frame.title.size, first.title.size, "\(at): header", file: file, line: line)
            XCTAssertEqual(frame.avatar, first.avatar, "\(at): avatar", file: file, line: line)
            XCTAssertEqual(frame.strip, first.strip, "\(at): strip", file: file, line: line)
            XCTAssertEqual(frame.list, first.list, "\(at): list", file: file, line: line)
            XCTAssertEqual(frame.dock, first.dock, "\(at): dock", file: file, line: line)
            XCTAssertEqual(frame.card, first.card, "\(at): composer", file: file, line: line)
            XCTAssertEqual(frame.composerShown, first.composerShown, "\(at): composer shown", file: file, line: line)
            if !report.hitCap {
                XCTAssertEqual(frame.insets, first.insets, "\(at): list insets", file: file, line: line)
                XCTAssertEqual(frame.rows, first.rows, "\(at): rows", file: file, line: line)
                XCTAssertEqual(frame.row, first.row, "\(at): first visible row", file: file, line: line)
            }
        }
    }

    static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }
}

/// One display frame of the chat on top, every frame in the chat's own
/// coordinates as laid out, so the push's slide doesn't count.
struct ChatFrame {
    weak var chat: ChatViewController?
    var time: CFTimeInterval
    var inWindow: Bool
    var ready: Bool
    /// The title capsule's frame in the bar.
    var title: CGRect
    var avatar: Bool
    var strip: CGRect?
    var list: CGRect
    var insets: UIEdgeInsets
    var rows: Int
    /// The lowest row on screen, in the list's content.
    var row: CGRect?
    var dock: CGRect
    var card: CGRect
    var composerShown: Bool
    /// What has an animation attached, other than the push's own.
    var animating: [String]
}

/// Samples `ChatFrame`s every display frame.
@MainActor
final class ChatFrameSampler: NSObject {
    private let navigation: UINavigationController
    private var link: CADisplayLink?
    private(set) var frames: [ChatFrame] = []

    init(navigation: UINavigationController) {
        self.navigation = navigation
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let chat = navigation.topViewController as? ChatViewController, chat.isViewLoaded else { return }
        let root: UIView = chat.view
        func frame(_ view: UIView?) -> CGRect? {
            guard let view, !view.isHidden, view.window != nil else { return nil }
            return view.convert(view.bounds, to: root)
        }
        let title = chat.navigationItem.titleView
        let avatar = chat.navigationItem.rightBarButtonItems?.compactMap { $0.customView as? ChatHeaderAvatarControl }.first
        let list = HostedChatNavigationTests.subview(ChatListView.self, in: root)
        let dock = HostedChatNavigationTests.subview(ChatDockView.self, in: root)
        let card = HostedChatNavigationTests.subview(AgentInputCardView.self, in: root)
        let composer = HostedChatNavigationTests.subview(SessionComposerView.self, in: root)
        let strip = HostedChatNavigationTests.subview(ChatWorktreeTabStrip.self, in: root)
        let collection = list?.collectionView
        let lowest = collection?.visibleCells.max { $0.frame.minY < $1.frame.minY }
        var animating: [String] = []
        let watched: [(String, UIView?)] = [("strip", strip), ("list", list), ("dock", dock), ("card", card), ("row", lowest), ("title", title)]
        for (name, view) in watched where !(view?.layer.animationKeys() ?? []).isEmpty {
            animating.append(name)
        }
        frames.append(ChatFrame(
            chat: chat,
            time: link.timestamp,
            inWindow: root.window != nil,
            ready: chat.openingReport != nil,
            title: title.flatMap { $0.window == nil ? nil : $0.convert($0.bounds, to: navigation.navigationBar) } ?? .zero,
            avatar: avatar.map { !$0.isHidden && $0.window != nil } ?? false,
            strip: frame(strip),
            list: frame(list) ?? .zero,
            insets: collection?.contentInset ?? .zero,
            rows: collection?.numberOfItems(inSection: 0) ?? 0,
            row: lowest?.frame,
            dock: frame(dock) ?? .zero,
            card: frame(card) ?? .zero,
            composerShown: (card?.alpha ?? 0) > 0 && (composer?.alpha ?? 0) > 0,
            animating: animating
        ))
    }
}
#endif
