#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct SeedNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct SeedNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct SeedUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// One person, one placeholder: the person without a picture wears the
/// same one on the Profile page and its Settings row, the tasks they made
/// and those tasks' profiles. In a team it is
/// the one their team user ID picks, as other members' phones draw them;
/// outside a team, their computer's seed as theirs.
@MainActor
final class HostedPersonSeedTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: LiveAvatars.key)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: LiveAvatars.key)
        super.tearDown()
    }

    @discardableResult
    private func until(_ condition: () -> Bool) async throws -> Bool {
        let end = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func subviews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { child in ((child as? T).map { [$0] } ?? []) + subviews(type, in: child) }
    }

    private func live(in view: UIView) -> LiveAvatarView? { subviews(LiveAvatarView.self, in: view).first }

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

    /// Steve signed in without a picture, and a task he made.
    private static func desktop(team: Bool) -> String {
        #"""
        {"cursor":"c1","profile":{"userId":\#(team ? #""u-steve""# : "null")},"userSettings":[],
         "projects":[],"workspaces":[],"bots":[],
         "tasks":[{"id":"mine","name":"Ship the notes","ownerUserId":\#(team ? #""u-steve""# : "null"),"agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}}],
         "taskMemberships":[{"taskId":"mine"}],
         "surfaces":[]}
        """#
    }

    /// A paired computer whose home is `desktop(team:)`.
    private func session(team: Bool) async throws -> Session {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in SeedUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SeedNoNetwork(), connector: SeedNoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"steves-mac","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
            withExtendedLifetime(controller) {}
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        // The Profile page is open before home is read: its seed follows.
        _ = session.profile
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.desktop(team: team).utf8))
        var home = HomeSnapshot()
        home.loaded = true
        home.allRows = SidebarRows.make(desktop, settings: [:])
        home.rows = Rows.visible(home.allRows)
        home.userId = desktop.profile?.userId
        // After the engine's own first snapshot, which would replace it.
        var first = await session.engine.snapshots().makeAsyncIterator()
        _ = await first.next()
        try await Task.sleep(for: .milliseconds(100))
        session.receive(home: home)
        return session
    }


    func testInATeamThePersonIsTheirTeamUserEverywhere() async throws {
        LiveAvatars.isEnabled = true
        _ = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        let session = try await session(team: true)
        let person = AvatarPlaceholder.index(seed: "u-steve")

        // The Profile page, and Settings' Profile row, which shows its picture.
        XCTAssertEqual(session.personSeed, "u-steve")
        XCTAssertEqual(session.profile.placeholderSeed, "u-steve")
        let page = ProfileViewController(source: session.profile)
        let navigation = UINavigationController(rootViewController: page)
        let window = try await window(navigation)
        let expected = await AvatarPlaceholderImages.image(seed: "u-steve", side: ProfileLayout.Metrics.avatar)
        let shown = try await until { page.shownAvatar === expected }
        XCTAssertTrue(shown, "the Profile page isn't the team user's placeholder")
        XCTAssertTrue(session.profile.placeholder === expected, "Settings' Profile row isn't the team user's placeholder")
        let pageLive = try await until { self.live(in: page.view) != nil }
        XCTAssertTrue(pageLive)
        XCTAssertEqual(live(in: page.view)?.index, person, "Profile page")

        // The task he made, on home: its author's face.
        let row = try XCTUnwrap(session.home.allRows.first { $0.agentId == "mine-agent" })
        XCTAssertEqual(row.mark, .placeholder(seed: "u-steve"))
        let rowView = RowView(frame: CGRect(x: 0, y: 120, width: window.bounds.width, height: 52))
        rowView.images = session.images
        rowView.configure(row)
        page.view.addSubview(rowView)
        rowView.layoutIfNeeded()
        XCTAssertEqual(live(in: rowView)?.index, person, "the task's home row")
        rowView.removeFromSuperview()

        // That task's profile.
        let profile = SessionDetailViewController(session: session, agentId: "mine-agent", title: "Ship the notes", spaceId: nil)
        navigation.pushViewController(profile, animated: false)
        window.layoutIfNeeded()
        XCTAssertEqual(profile.header.avatar, .mark(.placeholder(seed: "u-steve")))
        let profileLive = try await until { self.live(in: profile.header.mark) != nil }
        XCTAssertTrue(profileLive)
        XCTAssertEqual(live(in: profile.header.mark)?.index, person, "the task's profile")
    }

    /// Outside a team the person is their computer's seed as theirs, on
    /// the Profile page; a task keeps its own.
    func testOutsideATeamThePersonIsTheirComputersSeed() async throws {
        let session = try await session(team: false)
        let seed = "person:agent:steves-mac"
        XCTAssertEqual(session.personSeed, seed)
        XCTAssertEqual(session.profile.placeholderSeed, seed)
        let row = try XCTUnwrap(session.home.allRows.first { $0.agentId == "mine-agent" })
        XCTAssertNotEqual(row.mark, .placeholder(seed: seed), "a task outside a team wears the person")
    }

    /// The seed follows the computer: joining a team turns the open
    /// Profile page to the team user's placeholder.
    func testTheProfilePageFollowsTheTeamUser() async throws {
        let session = try await session(team: false)
        let page = ProfileViewController(source: session.profile)
        _ = try await window(UINavigationController(rootViewController: page))
        let before = await AvatarPlaceholderImages.image(seed: "person:agent:steves-mac", side: ProfileLayout.Metrics.avatar)
        let first = try await until { page.shownAvatar === before }
        XCTAssertTrue(first)
        var home = session.home
        home.userId = "u-steve"
        session.receive(home: home)
        let after = await AvatarPlaceholderImages.image(seed: "u-steve", side: ProfileLayout.Metrics.avatar)
        let turned = try await until { page.shownAvatar === after }
        XCTAssertTrue(turned, "the page kept the computer's placeholder")
    }
}
#endif
