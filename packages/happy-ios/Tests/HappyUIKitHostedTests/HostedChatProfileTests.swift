#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct ProfileNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ProfileNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct ProfileUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// A chat's profile wears the avatar the same chat wears elsewhere: the
/// agent chat's, its home row's placeholder (not a glyph tile); the legacy
/// session's, the one home's row and the chat's header draw. With Animated
/// Avatars on it moves as its shader, and holds still with them off or
/// under Reduce Motion. The legacy profile is the agent's design: the same
/// head, its rows on Settings' cards. Light and dark pictures of both go to
/// HAPPY_PREVIEW_DIR, tagged HAPPY_SHOT_TAG.
@MainActor
final class HostedChatProfileTests: XCTestCase {
    private static let sessionId = "profile-session"
    /// 2026-10-16 09:00 UTC.
    private static let base: Int64 = 1_792_141_200_000

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: LiveAvatars.key)
        AvatarShaderRenderer.holdsStill = nil
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: LiveAvatars.key)
        AvatarShaderRenderer.holdsStill = nil
        super.tearDown()
    }

    @discardableResult
    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let end = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func subviews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { child in ((child as? T).map { [$0] } ?? []) + subviews(type, in: child) }
    }

    private func keep(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    private func window(_ root: UIViewController) async throws -> UIWindow {
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: root)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            original?.makeKey()
        }
        window.layoutIfNeeded()
        return window
    }

    private func navigation() -> UINavigationController {
        let root = UIViewController()
        root.view.backgroundColor = .systemBackground
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        return navigation
    }

    // MARK: Fixtures

    private func controller() -> AccountController {
        AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in ProfileUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ProfileNoNetwork(), connector: ProfileNoSockets()
        )
    }

    /// Home's rows: a bot whose placeholder its own ID picks, and a
    /// project's session drawn without a mark.
    private static let desktop = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],
     "projects":[{"id":"p1","name":"happy","status":"active","orderKey":"a","avatar":{"kind":"home"},
        "agents":[{"id":"agent-session","workspaceId":"p1","title":"Fix the build","status":"idle"}]}],
     "workspaces":[],
     "bots":[{"id":"bot-research","name":"Research","status":"active","agent":{"id":"agent-bot","workspaceId":"r","status":"idle"}}],
     "surfaces":[]}
    """#

    /// An agent connection whose home lists `desktop`'s rows.
    private func agentSession(_ controller: AccountController) async throws -> (Session, [Row]) {
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"profile","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.desktop.utf8))
        var home = HomeSnapshot()
        home.loaded = true
        home.allRows = SidebarRows.make(desktop, settings: [:])
        home.rows = Rows.visible(home.allRows)
        // After the engine's own first snapshot, which would replace it.
        let engine = session.engine
        var first = await engine.snapshots().makeAsyncIterator()
        _ = await first.next()
        try await Task.sleep(for: .milliseconds(100))
        session.receive(home: home)
        return (session, home.allRows)
    }

    private static func record() -> SessionRecord {
        SessionRecord(
            id: sessionId, seq: 3, createdAt: base, updatedAt: base + 30_000,
            active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000), projectId: nil,
            metadataVersion: 1, metadataCipher: "test",
            metadata: .object([
                "path": .string("/Users/test/happy"), "host": .string("test-mac"), "homeDir": .string("/Users/test"),
                "machineId": .string("test-mac"), "flavor": .string("claude"), "version": .string("1.0.0"),
                "os": .string("darwin"), "summary": .object(["text": .string("Session info screen"), "updatedAt": .number(Double(base))]),
                "claudeSessionId": .string("claude-info-session"), "gitBranch": .string("main"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
    }

    /// A legacy account holding `record()`, home's feed read.
    private func legacyAccount(_ controller: AccountController) async throws -> AccountSession {
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 9, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        let record = Self.record()
        try await Task.detached { try store.upsertSessions([record]) }.value
        let home = Task { for await _ in account.homeFeed.snapshots() {} }
        addTeardownBlock { home.cancel() }
        let read = try await until { account.homeFeed.latest?.sessions.isEmpty == false }
        XCTAssertTrue(read, "home never read the store")
        return account
    }

    private func live(in view: UIView) -> LiveAvatarView? { subviews(LiveAvatarView.self, in: view).first }

    // MARK: The agent chat's profile

    /// The profile finds its chat's row among home's own rows and wears its
    /// placeholder, the bot's, which home's row draws; a project's session,
    /// drawn on home without a mark, wears its agent's.
    func testTheAgentProfileWearsItsHomeRowsPlaceholder() async throws {
        let controller = controller()
        let (session, rows) = try await agentSession(controller)
        LiveAvatars.isEnabled = true
        _ = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")

        // Home's row for the bot, drawn by home's own row view.
        let homeRow = try XCTUnwrap(rows.first { $0.agentId == "agent-bot" })
        let holder = UIViewController()
        let window = try await window(holder)
        let rowView = RowView(frame: CGRect(x: 0, y: 120, width: window.bounds.width, height: 52))
        rowView.images = session.images
        rowView.configure(homeRow)
        holder.view.addSubview(rowView)
        rowView.layoutIfNeeded()
        let homeLive = try XCTUnwrap(live(in: rowView), "home's row isn't a live placeholder")
        rowView.removeFromSuperview()

        for (agentId, seed, title) in [("agent-bot", "bot-research", "Research"), ("agent-session", "agent-session", "Fix the build")] {
            let navigation = navigation()
            window.rootViewController = navigation
            let profile = SessionDetailViewController(session: session, agentId: agentId, title: title, spaceId: nil)
            navigation.pushViewController(profile, animated: false)
            window.layoutIfNeeded()
            XCTAssertEqual(profile.header.avatar, .mark(.placeholder(seed: seed)), agentId)
            XCTAssertEqual(profile.header.name.text, title)
            let still = try await until { self.live(in: profile.header.mark) != nil }
            XCTAssertTrue(still, "\(agentId): no live placeholder on the profile")
            let profileLive = try XCTUnwrap(live(in: profile.header.mark))
            XCTAssertEqual(profileLive.index, AvatarPlaceholder.index(seed: seed), agentId)
            if agentId == "agent-bot" {
                XCTAssertEqual(profileLive.index, homeLive.index, "the profile's placeholder isn't home's row's")
                XCTAssertEqual(profile.header.subtitle.text, Strings.bot)
                // Not the agent's own ID's, which it wore when it missed its row.
                XCTAssertNotEqual(profile.header.avatar, .mark(.placeholder(seed: agentId)))
            }
        }
    }

    /// Animated Avatars on, the profile's placeholder moves; off, it is a
    /// still picture; under Reduce Motion it is drawn once and holds.
    func testTheAgentProfilesAvatarMovesOnlyWithAnimatedAvatars() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        let controller = controller()
        let (session, _) = try await agentSession(controller)
        let navigation = navigation()
        let window = try await window(navigation)
        let profile = SessionDetailViewController(session: session, agentId: "agent-bot", title: "Research", spaceId: nil)
        navigation.pushViewController(profile, animated: false)
        window.layoutIfNeeded()
        try await assertMovesOnlyWhenOn(profile.header.mark, renderer: renderer)
    }

    // MARK: The legacy session's profile

    /// The legacy profile's avatar is home's row's and the chat header's:
    /// one seed, one placeholder.
    func testTheLegacyProfileWearsHomesAndTheHeadersPlaceholder() async throws {
        let controller = controller()
        let account = try await legacyAccount(controller)
        let context = AppContext(account: controller, variant: .development, version: "test")
        LiveAvatars.isEnabled = true
        _ = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")

        // Home's row, as home works it out.
        let list = SessionList(try XCTUnwrap(account.homeFeed.latest))
        let homeSeed = try XCTUnwrap(list.items.lazy.compactMap { item -> String? in
            if case .session(let row) = item, row.id == Self.sessionId { return row.avatar.seed }
            return nil
        }.first)

        let navigation = navigation()
        let window = try await window(navigation)
        navigation.topViewController?.push(.session(id: Self.sessionId), context: context)
        let pushed = try await until { navigation.topViewController is LegacyChatViewController }
        XCTAssertTrue(pushed, "the chat was never pushed")
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let headerReady = try await until { chat.transitionCoordinator == nil && chat.avatarControl.content != nil }
        XCTAssertTrue(headerReady, "the chat's header never had its avatar")
        let headerSeed = try XCTUnwrap(chat.avatarControl.content?.avatar.seed)

        let title = try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderView)
        title.onOpen?()
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        window.layoutIfNeeded()
        guard case .session(let content)? = info.header.avatar else { return XCTFail("the profile has no session avatar") }
        XCTAssertEqual(content.avatar.seed, homeSeed)
        XCTAssertEqual(content.avatar.seed, headerSeed)
        let index = AvatarPlaceholder.index(seed: homeSeed)
        XCTAssertEqual(AvatarPlaceholder.index(seed: content.avatar.seed), index)
        let avatar = try XCTUnwrap(info.header.sessionAvatar)
        let moving = try await until { self.live(in: avatar) != nil }
        XCTAssertTrue(moving, "no live placeholder on the legacy profile")
        XCTAssertEqual(live(in: avatar)?.index, index)
        XCTAssertEqual(avatar.frame.size, CGSize(width: ProfileHeaderLayout.Metrics.mark, height: ProfileHeaderLayout.Metrics.mark))
        await controller.signOut()
    }

    func testTheLegacyProfilesAvatarMovesOnlyWithAnimatedAvatars() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        let controller = controller()
        let account = try await legacyAccount(controller)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let navigation = navigation()
        let window = try await window(navigation)
        let info = SessionInfoViewController(context: context, session: account, sessionId: Self.sessionId)
        navigation.pushViewController(info, animated: false)
        window.layoutIfNeeded()
        let avatar = try XCTUnwrap(info.header.sessionAvatar)
        try await assertMovesOnlyWhenOn(avatar, renderer: renderer)
        await controller.signOut()
    }

    /// The legacy profile is the agent's: the same head (the avatar, the
    /// name, what it is and its status), its tiles, and every row it had,
    /// on Settings' cards; the permission mode from the chat under it.
    func testTheLegacyProfileHasTheSharedHeadAndEveryRow() async throws {
        let controller = controller()
        let account = try await legacyAccount(controller)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let navigation = navigation()
        let window = try await window(navigation)
        navigation.topViewController?.push(.session(id: Self.sessionId), context: context)
        try await until { navigation.topViewController is LegacyChatViewController }
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        try await until { chat.transitionCoordinator == nil && chat.contentInstalled }
        try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderView).onOpen?()
        let info = try XCTUnwrap(navigation.topViewController as? SessionInfoViewController)
        let opened = try await until { info.transitionCoordinator == nil && info.sections.card("details")?.window != nil }
        XCTAssertTrue(opened, "the legacy profile showed no cards")
        info.view.layoutIfNeeded()

        // The head: `ProfileHeaderView`, at `ProfileHeaderLayout`'s frames,
        // in the page's readable column (the whole width on a phone).
        let width = ChatColumn(rowWidth: info.view.bounds.width, maxContentWidth: ContentWidth.maxWidth).width
        let head = ProfileHeaderLayout(width: width, nameHeight: info.header.nameHeight, nameWidth: info.header.nameWidth, subtitleHeight: info.header.subtitleHeight)
        XCTAssertEqual(info.header.sessionAvatar?.frame, head.mark)
        XCTAssertEqual(info.header.name.frame, head.name)
        XCTAssertEqual(info.header.subtitle.frame, head.subtitle)
        XCTAssertEqual(info.header.name.text, "Session info screen")
        XCTAssertEqual(info.header.subtitle.text, Strings.Composer.online)
        XCTAssertTrue(info.header.pencil.isHidden, "a legacy session isn't renamed here")
        let tiles = subviews(DetailTileView.self, in: info.view).filter { !$0.isHidden }
        XCTAssertEqual(tiles.map(\.accessibilityLabel), [Strings.model, Strings.started])

        typealias S = Strings.SessionDetail
        let cards = info.sections.sections
        XCTAssertEqual(cards.map(\.id), ["controls", "quick-actions", "details", "metadata", "agent-state", "activity", "raw-0", "raw-1", "raw-2"])
        let titles = cards.flatMap { $0.rows.map(\.title) }
        for title in [
            Strings.ChatActions.permissionMode,
            Strings.FilesDetail.changes, S.viewMachine, S.archiveSession, S.deleteSession,
            S.happySessionId, S.claudeCodeSessionId, S.connectionStatus, S.created, S.lastUpdated, S.sequence,
            S.host, S.path, Strings.ChatActions.branch, S.cliVersion, S.operatingSystem, S.aiProvider, S.copyMetadata, S.copyMetadataAndLogs,
            S.controlledByUser, S.thinking, S.rawAgentState, S.rawMetadata, S.rawSession,
        ] {
            XCTAssertTrue(titles.contains(title), "no \(title) row")
        }
        // Branch right after Path, as before.
        let metadata = try XCTUnwrap(cards.first { $0.id == "metadata" }).rows.map(\.title)
        XCTAssertEqual(metadata.firstIndex(of: Strings.ChatActions.branch), metadata.firstIndex(of: S.path).map { $0 + 1 })
        XCTAssertEqual(cards.first { $0.id == "metadata" }?.rows.first { $0.title == Strings.ChatActions.branch }?.subtitle, "main")
        XCTAssertEqual(cards.map(\.heading), [nil, S.quickActions, nil, S.metadata, S.agentState, S.activity, S.rawJSON, nil, nil])
        // Each on Settings' card, the rows Settings' rows, in the scroll.
        for section in cards {
            let card = try XCTUnwrap(info.sections.card(section.id))
            XCTAssertEqual(subviews(SettingsCardView.RowView.self, in: card).count, section.rows.count, section.id)
        }
        // The permission mode is the chat's pull-down.
        let permission = try XCTUnwrap(subviews(MenuRowButton.self, in: info.view).first { $0.accessibilityIdentifier == "profile-permission-mode" })
        XCTAssertTrue(permission.showsMenuAsPrimaryAction)
        // Retry and Copy diagnostics stay in the bar, for a body that never shows.
        XCTAssertNotNil(info.navigationItem.rightBarButtonItem?.menu)
        await controller.signOut()
    }

    // MARK: Pictures

    /// Both profiles, light and dark, side by side in the attachments and
    /// HAPPY_PREVIEW_DIR.
    func testShots() async throws {
        let controller = controller()
        let account = try await legacyAccount(controller)
        let (session, _) = try await agentSession(controller)
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let tag = ProcessInfo.processInfo.environment["HAPPY_SHOT_TAG"] ?? "after"
        for (style, name) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            let agentNavigation = navigation()
            let agentWindow = try await window(agentNavigation)
            agentWindow.overrideUserInterfaceStyle = style
            agentNavigation.pushViewController(SessionDetailViewController(session: session, agentId: "agent-bot", title: "Research", spaceId: nil), animated: false)
            agentWindow.layoutIfNeeded()
            try await Task.sleep(for: .seconds(1))
            keep(agentWindow, "profile-agent-\(tag)-\(name)")
            agentWindow.isHidden = true

            let legacyNavigation = navigation()
            let legacyWindow = try await window(legacyNavigation)
            legacyWindow.overrideUserInterfaceStyle = style
            legacyNavigation.pushViewController(SessionInfoViewController(context: context, session: account, sessionId: Self.sessionId), animated: false)
            legacyWindow.layoutIfNeeded()
            try await Task.sleep(for: .seconds(2))
            keep(legacyWindow, "profile-legacy-\(tag)-\(name)")
            legacyWindow.isHidden = true
        }
        await controller.signOut()
    }

    // MARK: Moving

    private func assertMovesOnlyWhenOn(_ view: UIView, renderer: AvatarShaderRenderer, file: StaticString = #filePath, line: UInt = #line) async throws {
        // Off: a still picture.
        XCTAssertFalse(LiveAvatars.isEnabled)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(live(in: view), "moving with Animated Avatars off", file: file, line: line)

        // On: its shader over the still picture, frame after frame.
        LiveAvatars.isEnabled = true
        let made = try await until { self.live(in: view) != nil }
        XCTAssertTrue(made, "no live placeholder with Animated Avatars on", file: file, line: line)
        let live = try XCTUnwrap(self.live(in: view))
        let drawn = try await until { live.drawn && !live.isHidden }
        XCTAssertTrue(drawn, "never drawn", file: file, line: line)
        var presented = renderer.presented
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertGreaterThan(renderer.presented - presented, 4, "it isn't moving", file: file, line: line)

        // Reduce Motion: drawn once, then held.
        AvatarShaderRenderer.holdsStill = true
        try await until { live.drawn }
        try await Task.sleep(for: .milliseconds(200))
        presented = renderer.presented
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(renderer.presented, presented, "it moves under Reduce Motion", file: file, line: line)
        XCTAssertFalse(live.isHidden, "under Reduce Motion it shows its held frame", file: file, line: line)
        AvatarShaderRenderer.holdsStill = nil

        // Off again: gone, the still picture stays.
        LiveAvatars.isEnabled = false
        XCTAssertNil(self.live(in: view), file: file, line: line)
    }
}
#endif
