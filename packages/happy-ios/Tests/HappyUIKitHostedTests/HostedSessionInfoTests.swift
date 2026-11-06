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

/// A socket always on its way: the account's own status stays
/// "connecting", for a test to say it's live instead.
private struct ForeverConnecting: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        try await Task.sleep(for: .seconds(3_600))
        throw URLError(.timedOut)
    }
}

/// Session info as the chat's title opens it, over a store holding the
/// session, in a window of a real scene: its groups must be on screen, and
/// a long session's (an agent state of hundreds of requests, megabytes of
/// raw JSON in Debug) must open without holding the main thread.
@MainActor
final class HostedSessionInfoTests: XCTestCase {
    private static let sessionId = "info-session"
    /// 2026-10-16 09:00 UTC.
    private static let base: Int64 = 1_792_141_200_000

    private func signedIn(agentState: JSONValue, sessionRecord: SessionRecord? = nil, connector: any WebSocketConnector = NoSockets()) async throws -> (AccountController, AccountSession) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: connector
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 3, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        let record = sessionRecord ?? Self.session(agentState: agentState)
        try await Task.detached { try store.upsertSessions([record]) }.value
        // Home, under every chat, keeps the account's home feed read.
        let home = Task { for await _ in account.homeFeed.snapshots() {} }
        addTeardownBlock { home.cancel() }
        let read = try await until { account.homeFeed.latest?.sessions.isEmpty == false }
        XCTAssertTrue(read, "home never read the store")
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

    /// A card the screen shows: its section, and the card it is drawn on.
    private struct Group {
        var section: ProfileSection
        var card: SettingsCardView
        var heading: String? { section.heading }
        var titles: [String] { section.rows.map(\.title) }
    }

    /// The groups the screen shows, once the push is over, its load status
    /// aside; none until the first is on screen.
    private func shownGroups(_ info: SessionInfoViewController, in window: UIWindow) -> [Group] {
        guard info.transitionCoordinator == nil, let scroll = subviews(DetailScrollView.self, in: info.view).first,
              scroll.window === window else { return [] }
        var ancestor: UIView? = scroll
        while let view = ancestor {
            guard !view.isHidden, view.alpha > 0 else { return [] }
            ancestor = view.superview
        }
        let groups = info.sections.sections.filter { $0.id != "session-info-load-status" }.compactMap { section in
            info.sections.card(section.id).map { Group(section: section, card: $0) }
        }
        guard let first = groups.first, first.card.superview === scroll, first.card.bounds.height > 0,
              first.card.convert(first.card.bounds, to: window).intersects(window.bounds) else { return [] }
        return groups
    }

    /// Every row's title on the screen's cards.
    private func titles(_ info: SessionInfoViewController) -> [String] {
        info.sections.sections.flatMap { $0.rows.map(\.title) }
    }

    func testTheTitleOpensSessionInfoWithItsGroupsOnScreen() async throws {
        let (controller, account) = try await signedIn(agentState: .object(["controlledByUser": .bool(false)]))
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        root.push(.session(id: Self.sessionId), context: context)
        // A chat is readied before it is pushed (`ChatOpening`).
        let pushed = try await until { navigation.topViewController is LegacyChatViewController }
        XCTAssertTrue(pushed, "the chat was never pushed")
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        // The title capsule opens it: in the bar from the push, opening
        // once the chat's record is in.
        let title = try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderView)
        let shown = try await until { chat.transitionCoordinator == nil && chat.contentInstalled && title.window != nil }
        XCTAssertTrue(shown, "the title never showed")
        // Back, the name, and Compose: no More, no debug fixtures.
        XCTAssertEqual(chat.navigationItem.rightBarButtonItems?.map(\.accessibilityIdentifier), ["compose"])
        XCTAssertNil(chat.navigationItem.leftBarButtonItems)
        for (style, name) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .seconds(1))
            keep(window, "hosted-legacy-chat-header-\(name)")
        }
        window.overrideUserInterfaceStyle = .unspecified
        title.onOpen?()
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(opened, "session info showed no groups")
        info.view.layoutIfNeeded()
        let groups = shownGroups(info, in: window)
        let screen = window.bounds
        for (index, group) in groups.enumerated() {
            let frame = group.card.convert(group.card.bounds, to: window)
            XCTAssertGreaterThan(frame.width, 0, "group \(index)")
            XCTAssertGreaterThan(frame.height, 0, "group \(index)")
            XCTAssertFalse(group.section.rows.isEmpty, "group \(index)")
            let rows = subviews(SettingsCardView.RowView.self, in: group.card)
            XCTAssertEqual(rows.count, group.section.rows.count, "group \(index)")
            for (row, view) in rows.enumerated() {
                XCTAssertGreaterThan(view.bounds.height, 0, "group \(index) row \(row)")
            }
        }
        // The head sits under the bar, the first group on screen under it.
        let name = info.header.name.convert(info.header.name.bounds, to: window)
        XCTAssertGreaterThanOrEqual(name.minY, navigation.navigationBar.frame.maxY - 1)
        let first = try XCTUnwrap(groups.first)
        let firstFrame = first.card.convert(first.card.bounds, to: window)
        XCTAssertTrue(screen.contains(firstFrame.origin), "\(firstFrame)")
        XCTAssertGreaterThan(firstFrame.minY, name.maxY)
        XCTAssertEqual(info.header.name.text, "Session info screen")

        // The chat's permission mode, once in its header's More menu, is a
        // row here: the current mode as its value, a native menu of all of
        // them, and a pick kept as the composer keeps one.
        func permissionRow() -> MenuRowButton? {
            subviews(MenuRowButton.self, in: info.view).first { $0.accessibilityIdentifier == "profile-permission-mode" }
        }
        let rowShown = try await until { permissionRow() != nil }
        XCTAssertTrue(rowShown, "no permission mode on the session's info")
        let row = try XCTUnwrap(permissionRow())
        XCTAssertTrue(row.showsMenuAsPrimaryAction)
        XCTAssertGreaterThan(row.bounds.height, 40)
        XCTAssertGreaterThan(row.bounds.width, 300)
        for (style, name) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .seconds(1))
            keep(window, "legacy-info-permission-\(name)")
        }
        window.overrideUserInterfaceStyle = .unspecified
        let menu = try XCTUnwrap(row.menuFor?())
        XCTAssertEqual(menu.identifier.rawValue, "chat-permissions")
        let actions = menu.children.compactMap { $0 as? UIAction }
        // Every mode the chat's composer offers, none dropped.
        let offered = try XCTUnwrap(chat.permissionChoice).menu.sections.flatMap(\.options).map(\.key)
        XCTAssertEqual(actions.compactMap(\.accessibilityIdentifier), offered)
        XCTAssertTrue(offered.contains("plan"))
        let plan = try XCTUnwrap(actions.first { $0.accessibilityIdentifier == "plan" })
        XCTAssertEqual(plan.state, .off)
        let button = UIButton(type: .system)
        button.addAction(plan, for: .touchUpInside)
        button.sendActions(for: .touchUpInside)
        let store = account.store
        let sessionId = Self.sessionId
        var stored: String?
        for _ in 0..<300 where stored != "plan" {
            stored = try await Task.detached { try store.composerState(sessionId: sessionId).values["permissionMode"]?.stringValue }.value
            if stored != "plan" { try await Task.sleep(for: .milliseconds(10)) }
        }
        XCTAssertEqual(stored, "plan", "the pick isn't kept as the composer's")
        let ticked = try XCTUnwrap(row.menuFor?()).children.compactMap { $0 as? UIAction }.filter { $0.state == .on }.compactMap(\.accessibilityIdentifier)
        XCTAssertEqual(ticked, ["plan"])
        XCTAssertEqual(row.accessibilityValue, plan.title, "the row shows the pick")
        await controller.signOut()
    }

    /// The legacy chat's header is the agent chat's: its name and its
    /// session's status on one glass capsule, in the bar from the push's
    /// first layout, nothing measured first; the status is nowhere else.
    func testTheLegacyChatHasItsCapsuleFromThePushesFirstLayout() async throws {
        let (controller, account) = try await signedIn(agentState: .object(["controlledByUser": .bool(false)]), connector: ForeverConnecting())
        let context = AppContext(account: controller, variant: .development, version: "test")
        // No socket here: the account's link is told it's live, or the
        // chat would say "connecting…" where the session's status goes.
        let link = LegacyLink.link(for: account)
        // The socket's own "connecting" has come.
        try await Task.sleep(for: .milliseconds(300))
        link.receive(status: .connected)
        link.receive(catchingUp: false)
        let live = try await until { link.indicator.shown == .online }
        XCTAssertTrue(live, "the link never came back live")
        for (style, name) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            let (window, navigation, _) = try await hosted()
            window.overrideUserInterfaceStyle = style
            let chat = LegacyChatViewController(context: context, session: account, sessionId: Self.sessionId)
            navigation.pushViewController(chat, animated: true)
            window.layoutIfNeeded()
            // The first layout pass of the push.
            let header = try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderView, "a plain title at the push's start")
            XCTAssertNotNil(header.window, "the capsule isn't in the bar as the push starts")
            XCTAssertTrue(header.capsule.effect is UIGlassEffect)
            XCTAssertGreaterThan(header.capsule.bounds.width, 100)
            XCTAssertEqual(header.titleView.text, "Session info screen")
            let status = try XCTUnwrap(Self.allViews(UILabel.self, in: header.capsule.contentView).first { $0.accessibilityIdentifier == "chat-status" })
            XCTAssertEqual(status.text, Strings.Composer.online, "the status isn't the capsule's subtitle")
            // Dynamic colours are never equal as objects: compare them resolved.
            let traits = header.traitCollection
            XCTAssertEqual(header.statusColor.resolvedColor(with: traits), UIColor(Palette.sessionStatusOnline).resolvedColor(with: traits))
            // Mid-push: the capsule is already there.
            try await Task.sleep(for: .milliseconds(150))
            keep(window, "legacy-chat-mid-push-\(name)", afterUpdates: false)
            let settled = try await until { chat.transitionCoordinator == nil && chat.contentInstalled }
            XCTAssertTrue(settled)
            XCTAssertTrue(chat.navigationItem.titleView === header, "the capsule was swapped once the chat was built")
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertEqual(status.text, Strings.Composer.online)
            // Not over the composer as well: the status is the header's.
            let elsewhere = Self.allViews(UILabel.self, in: chat.view).filter {
                !$0.isHidden && $0.alpha > 0 && $0.window != nil && $0.text == Strings.Composer.online
            }
            XCTAssertEqual(elsewhere, [], "the status still shows outside the capsule")
            keep(window, "legacy-chat-header-\(name)")
            window.isHidden = true
        }
        await controller.signOut()
    }

    /// Every legacy screen goes back with the chevron alone in its glass
    /// circle: never "Back" nor the screen behind's title.
    func testEveryLegacyScreenGoesBackWithTheChevronAlone() async throws {
        let (controller, account) = try await signedIn(agentState: .object(["controlledByUser": .bool(false)]))
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        // One stack on an iPad too: the main panel's back buttons are the
        // same delegate's (`ShellViewController`).
        let shell = ShellViewController(context: context, phone: navigation, splits: false)
        let window = hostedKeyWindow(in: scene, root: shell)
        defer { window.isHidden = true; hostWindow?.makeKey() }
        window.layoutIfNeeded()
        let routes: [Route] = [
            .session(id: Self.sessionId), .sessionInfo(id: Self.sessionId), .sessionChanges(id: Self.sessionId),
            .machine(id: "test-mac"), .settings, .settingsAppearance, .settingsLanguage, .settingsVoice,
        ]
        for route in routes {
            let top = try XCTUnwrap(navigation.topViewController)
            let count = navigation.viewControllers.count
            top.push(route, context: context, animated: false)
            let pushed = try await until(seconds: 10) { navigation.viewControllers.count == count + 1 && navigation.transitionCoordinator == nil }
            XCTAssertTrue(pushed, "\(route) was never pushed")
            try await Task.sleep(for: .milliseconds(300))
            navigation.navigationBar.layoutIfNeeded()
            for below in navigation.viewControllers.dropLast() {
                XCTAssertEqual(below.navigationItem.backButtonDisplayMode, .minimal, "\(type(of: below)) under \(route)")
                XCTAssertNil(below.navigationItem.backButtonTitle, "\(type(of: below)) under \(route)")
            }
            // Words by the chevron, at the bar's leading edge: the top's own
            // centred title may well be the screen behind's.
            let behind = navigation.viewControllers.dropLast().last
            let words = Self.allViews(UILabel.self, in: navigation.navigationBar).filter {
                !$0.isHidden && $0.alpha > 0 && [Strings.Common.back, behind?.navigationItem.title, behind?.title].contains($0.text)
                    && $0.text?.isEmpty == false && $0.convert($0.bounds, to: navigation.navigationBar).minX < 100
            }
            XCTAssertEqual(words.compactMap(\.text), [], "words by the chevron on \(route)")
            if case .sessionInfo = route {
                for (style, name) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
                    window.overrideUserInterfaceStyle = style
                    try await Task.sleep(for: .seconds(1))
                    keep(window, "legacy-info-back-\(name)")
                }
                window.overrideUserInterfaceStyle = .unspecified
            }
        }
        await controller.signOut()
    }

    private static func allViews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { child in ((child as? T).map { [$0] } ?? []) + allViews(type, in: child) }
    }

    private func keep(_ window: UIWindow, _ name: String, afterUpdates: Bool = true) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: afterUpdates)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    /// Sync may keep changing visible metadata while the first groups are
    /// being made. Opening must finish before that stream becomes quiet.
    func testLiveStoreUpdatesCannotKeepTheFirstGroupsHidden() async throws {
        let state: JSONValue = .object(["controlledByUser": .bool(false)])
        let (controller, account) = try await signedIn(agentState: state)
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (window, navigation, root) = try await hosted()
        let store = account.store
        let liveRecord = Self.session(agentState: state)
        let updates = Task.detached {
            var record = liveRecord
            for index in 1...300 {
                guard !Task.isCancelled else { return }
                var metadata = record.metadata?.objectValue ?? [:]
                metadata["host"] = .string("live-mac-\(index)")
                record.metadata = .object(metadata)
                record.metadataVersion += 1
                record.updatedAt += 1
                record.seq += 1
                try store.upsertSessions([record])
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        defer { updates.cancel() }
        root.push(.sessionInfo(id: Self.sessionId), context: context)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let opened = try await until(seconds: 2) { !self.shownGroups(info, in: window).isEmpty }
        print("SESSIONINFO-LIVE visible groups during writes: \(self.shownGroups(info, in: window).count)")
        if !opened {
            let values = Dictionary(uniqueKeysWithValues: Mirror(reflecting: info).children.compactMap { child in
                child.label.map { ($0, child.value) }
            })
            let pipeline = values["pipeline"] as? ApplyPipeline<SessionInfoInput, SessionInfoFrame?, SessionInfoUpdate>
            let frame = values["frame"] as? SessionInfoFrame
            let queue = values["queue"] as? [SessionInfoSection]
            let scroll = try XCTUnwrap(subviews(DetailScrollView.self, in: info.view).first)
            print("SESSIONINFO-LIVE applies=\(String(describing: pipeline?.counts)) model=\(frame?.model != nil) queue=\(String(describing: queue)) window=\(scroll.window != nil) bounds=\(scroll.bounds) hidden=\(scroll.isHidden) sections=\(info.sections.sections.count)")
        }
        // The navigation bar can finish its title fade after the push ends.
        try await Task.sleep(for: .milliseconds(500))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "Session details during live store updates"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertTrue(opened, "live updates kept every group hidden")
        updates.cancel()
        _ = try? await updates.value
        let latest = await account.sessionDetails.current(sessionId: Self.sessionId)
        let host = try XCTUnwrap(latest?.session?.metadata?["host"]?.stringValue)
        let reconciled = try await until {
            self.shownGroups(info, in: window).flatMap(\.section.rows).contains { $0.subtitle == host }
        }
        XCTAssertTrue(reconciled, "the group did not catch up to the last store snapshot")
        await controller.signOut()
    }

    func testAControllerPreparedBeforeWindowAttachmentStillShowsItsGroups() async throws {
        let (controller, account) = try await signedIn(agentState: .object([:]))
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let info = SessionInfoViewController(context: context, session: account, sessionId: Self.sessionId)
        info.loadViewIfNeeded()
        info.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        info.view.layoutIfNeeded()
        // Its first snapshot and display callback arrive while off-window.
        try await Task.sleep(for: .milliseconds(200))
        let (window, navigation, _) = try await hosted()
        navigation.pushViewController(info, animated: true)
        let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(opened, "off-window preparation lost the group's display callback")
        await controller.signOut()
    }

    func testHappyAgentAndBotDetailsShowVisibleGroups() async throws {
        for bot in [false, true] {
            var record = Self.session(agentState: .null)
            var metadata = record.metadata?.objectValue ?? [:]
            metadata["client"] = .object(["id": .string("rig"), "name": .string("Happy Agent"), "version": .string("1.0")])
            metadata["provider"] = .object(["id": .string("openai"), "name": .string("OpenAI"), "kind": .string("codex")])
            metadata["currentModelProviderId"] = .string("openai")
            metadata["currentModelCode"] = .string("gpt-6.1-sol")
            metadata["git"] = .object(["insertions": .number(12), "deletions": .number(3), "changedFiles": .number(2)])
            metadata["activity"] = .object([
                "subagents": .object(["running": .number(2), "queued": .number(1)]),
                "workflows": .object(["running": .number(1)]),
                "processes": .object(["running": .number(3)]),
                "tasks": .object(["pending": .number(2), "inProgress": .number(1)]),
            ])
            if bot { metadata["bot"] = .object(["name": .string("Test bot")]) }
            record.metadata = .object(metadata)
            let (controller, _) = try await signedIn(agentState: .null, sessionRecord: record)
            let context = AppContext(account: controller, variant: .preview, version: "test")
            let (window, navigation, root) = try await hosted()
            root.push(.sessionInfo(id: Self.sessionId), context: context)
            let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
            let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
            XCTAssertTrue(opened, "Happy Agent details showed no visible groups (bot: \(bot))")
            let titles = shownGroups(info, in: window).flatMap(\.titles)
            XCTAssertEqual(titles.contains(Strings.SessionDetail.deleteSession), !bot)
            await controller.signOut()
        }
    }

    func testDeletionCancelsUnshownGroupsAndAReplacementSnapshotCanOpenAgain() async throws {
        let (controller, account) = try await signedIn(agentState: .object([:]))
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (window, navigation, root) = try await hosted()
        root.push(.sessionInfo(id: Self.sessionId), context: context)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let scroll = try XCTUnwrap(subviews(DetailScrollView.self, in: info.view).first)
        let started = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(started, "the first groups never showed")
        let store = account.store
        let id = Self.sessionId
        let base = Self.base
        try await Task.detached {
            try store.setCursor(.sessionsChangedSince, base)
            try store.deleteSession(id: id)
        }.value
        let deleted = try await until { !self.subviews(DetailMessageView.self, in: info.view).isEmpty }
        XCTAssertTrue(deleted, "\"Session deleted\" never showed")
        XCTAssertTrue(scroll.isHidden)
        XCTAssertTrue(info.sections.sections.isEmpty)
        XCTAssertTrue(subviews(SettingsCardView.self, in: scroll).isEmpty, "the deleted session's cards stayed")

        let replacement = Self.session(agentState: .object([:]))
        try await Task.detached { try store.upsertSessions([replacement]) }.value
        let reopened = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(reopened, "the replacement snapshot did not show its groups")
        XCTAssertFalse(scroll.isHidden)
        XCTAssertTrue(subviews(DetailMessageView.self, in: info.view).isEmpty)
        XCTAssertEqual(subviews(SettingsCardView.self, in: scroll).count, info.sections.sections.count)
        await controller.signOut()
    }

    func testASectionRemovedDuringConstructionStaysRemovedAndCanReturn() async throws {
        let (controller, account) = try await signedIn(agentState: .object([:]))
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let (window, navigation, root) = try await hosted()
        root.push(.sessionInfo(id: Self.sessionId), context: context)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let started = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(started)
        let store = account.store
        var withoutMetadata = Self.session(agentState: .object([:]))
        withoutMetadata.metadata = nil
        withoutMetadata.metadataVersion = 2
        let removed = withoutMetadata
        try await Task.detached { try store.upsertSessions([removed]) }.value
        let opened = try await until {
            let groups = self.shownGroups(info, in: window)
            return !groups.isEmpty && !groups.contains { $0.heading == Strings.SessionDetail.metadata }
        }
        XCTAssertTrue(opened)
        XCTAssertFalse(shownGroups(info, in: window).contains { $0.heading == Strings.SessionDetail.metadata })

        var withMetadata = Self.session(agentState: .object([:]))
        withMetadata.metadataVersion = 3
        let restored = withMetadata
        try await Task.detached { try store.upsertSessions([restored]) }.value
        let returned = try await until {
            self.shownGroups(info, in: window).contains { $0.heading == Strings.SessionDetail.metadata }
        }
        XCTAssertTrue(returned)
        await controller.signOut()
    }

    /// The head has the name and avatar home shows as the screen is
    /// pushed, before its own snapshot is read; that snapshot, holding the
    /// same session, then changes neither. The bar has no title: the name
    /// is the head's, as on the agent chat's profile.
    func testTheNameIsInTheHeadAsItIsPushedAndTheSessionsOwnSnapshotChangesNothing() async throws {
        let (controller, _) = try await signedIn(agentState: .object(["controlledByUser": .bool(false)]))
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        root.push(.sessionInfo(id: Self.sessionId), context: context)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        // Loaded as the push's transition starts; loaded now, before the
        // session's own snapshot can have reached the main thread, it has
        // the name and the avatar and none of the groups.
        info.loadViewIfNeeded()
        XCTAssertEqual(info.header.name.text, "Session info screen")
        guard case .session(let seeded)? = info.header.avatar else { return XCTFail("no avatar from the first frame") }
        XCTAssertEqual(seeded.avatar.seed, "test-mac:/Users/test/happy")
        XCTAssertNil(info.navigationItem.titleView)
        XCTAssertNil(info.title)
        XCTAssertTrue(info.sections.sections.allSatisfy { $0.id == "session-info-load-status" })

        // The session's own snapshot is in once its groups are shown.
        let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
        XCTAssertTrue(opened, "session info showed no groups")
        XCTAssertEqual(info.header.name.text, "Session info screen")
        guard case .session(let read)? = info.header.avatar else { return XCTFail("the avatar went") }
        XCTAssertEqual(read.avatar.seed, seeded.avatar.seed)
        XCTAssertEqual(AvatarPlaceholder.index(seed: read.avatar.seed), AvatarPlaceholder.index(seed: seeded.avatar.seed))
        XCTAssertNil(info.navigationItem.titleView)
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
        let list = try XCTUnwrap(subviews(DetailScrollView.self, in: info.view).first)
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
        XCTAssertLessThan(longest, TestTime.budget(0.25), "the main thread was held \(longest) s")
        await controller.signOut()
    }

    #if DEBUG
    /// Its groups join the screen together, never some of them, and stay
    /// the same cards as the session changes under them.
    func testItsGroupsAreShownTogether() async throws {
        let (controller, _) = try await signedIn(agentState: Self.longAgentState())
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, root) = try await hosted()
        root.push(.sessionInfo(id: Self.sessionId), context: context)
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        var shown: [Int] = []
        let recorder = TickRecorder { _ in
            shown.append(info.sections.sections.filter { $0.id != "session-info-load-status" }.count)
        }
        let opened = try await until { !self.shownGroups(info, in: window).isEmpty }
        recorder.stop()
        XCTAssertTrue(opened, "session info showed no groups")
        let ids = info.sections.sections.map(\.id)
        XCTAssertEqual(ids, ["quick-actions", "details", "metadata", "agent-state", "activity", "raw-0", "raw-1", "raw-2"])
        // Never some of the groups: none, then all.
        XCTAssertTrue(Set(shown).isSubset(of: [0, ids.count]), "\(shown)")
        XCTAssertEqual(subviews(SettingsCardView.self, in: info.view).count, ids.count)
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
