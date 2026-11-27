#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A Happy Cloud server with everything the drawer lists: the shared bot, a
/// personal one, two tasks, a project, a document, a todo list and a
/// calendar, Plugins and Pipelines.
private final class DrawerCloud: AgentTransport, @unchecked Sendable {
    static let health = #"{"ready":true,"capabilities":{"pipelines":true,"plugins":true,"features":true}}"#
    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"me","name":"Robin"},"userSettings":[],
     "projects":[{"id":"p1","name":"happy","status":"active","orderKey":"a","agents":[{"id":"root","workspaceId":"p1","title":"Root chat","status":"idle"}]}],
     "workspaces":[],
     "bots":[
       {"id":"happy","name":"Happy","systemKey":"chief_of_staff","kind":"shared","status":"active","agent":{"id":"bot-agent","workspaceId":"bot-work","status":"idle"}},
       {"id":"research","name":"Research","kind":"personal","status":"active","agent":{"id":"research-agent","workspaceId":"research-work","status":"idle"}}],
     "tasks":[
       {"id":"ship","name":"Ship the cache","status":"active","agent":{"id":"ship-agent","workspaceId":"ship-work","status":"idle"}},
       {"id":"notes","name":"Write the release notes","status":"active","agent":{"id":"notes-agent","workspaceId":"notes-work","status":"idle"}}],
     "taskMemberships":[{"taskId":"ship"},{"taskId":"notes"}],
     "surfaces":[
       {"id":"plan","name":"Launch plan","type":"document","members":[{"userId":"me","orderKey":"a"}]},
       {"id":"groceries","name":"Groceries","type":"todo","members":[{"userId":"me","orderKey":"b"}]},
       {"id":"family","name":"Family","type":"calendar","members":[{"userId":"me","orderKey":"c"}]}],
     "health":\#(health)}
    """#
    static let surfaces = #"""
    {"surfaces":[{"id":"plan","type":"document","name":"Launch plan"},{"id":"spec","type":"document","name":"API spec"},
     {"id":"groceries","type":"todo","name":"Groceries"},{"id":"family","type":"calendar","name":"Family"}]}
    """#

    private let lock = NSLock()
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func answer(_ text: String, _ status: Int = 200) -> HTTP1Response {
            HTTP1Response(status: status, headers: ["content-type": "application/json"], body: Data(text.utf8))
        }
        switch (method, path.split(separator: "?").first.map(String.init) ?? path) {
        case ("GET", "/v0/bootstrap/desktop"): return answer(Self.bootstrap)
        case ("GET", "/v0/health"): return answer(Self.health)
        case ("GET", "/v0/features"): return answer(#"{"features":[{"id":"pipelines","available":true}]}"#)
        case ("GET", "/v0/surfaces"): return answer(Self.surfaces)
        case ("GET", "/v0/plugins"): return answer(#"{"plugins":[{"id":"github","name":"GitHub","kind":"integration","description":"Repositories, issues and pull requests.","version":"1.0.0","tools":[],"auth":{"required":true,"methods":[]}}]}"#)
        case ("GET", "/v0/plugins/installations"): return answer(#"{"installations":[],"canManage":true}"#)
        case ("GET", "/v0/pipelines"): return answer(#"{"pipelines":[]}"#)
        default: return answer("{}", 404)
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        lock.withLock { streams.append(continuation) }
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":false,\"gap\":false}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }

    func reset() async {}
    func close() async {
        let streams = lock.withLock { defer { self.streams = [] }; return self.streams }
        streams.forEach { $0.finish() }
    }
}

/// The iPhone's drawer (Steve): home lists the bots and tasks alone, its
/// face in the bar opens the drawer, and the drawer lists Home, the places
/// and the other Surfaces, Settings at its foot. A place becomes the root
/// with ☰ where back would be; Home comes back as it was; Settings is
/// pushed, with Plugins last in its Agents group. Pictures go to
/// `.context/evidence/todos`.
@MainActor
final class HostedPhoneDrawerTests: HostedTodoCase {
    private struct Rig {
        let context: AppContext
        let session: Session
        let id: String
        let home: AgentHomeViewController
        let shell: ShellViewController
        let navigation: UINavigationController
        let window: UIWindow
    }

    private func rig() async throws -> Rig {
        let cloud = DrawerCloud()
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "phone-drawer",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in cloud })
        await account.agentConnections.setForeground(false)
        let server = HappyCloud.server(named: "drawer-\(UUID().uuidString.prefix(8).lowercased())")
        let connection = try await account.agentConnections.addServer(AgentOrigin(server),
            signIn: ServerSignInRecord(method: HappyCloud.method(server: server), grant: OAuthGrant(clientId: "test"), userId: "me"),
            access: OAuthAccess(token: "test", expiresAt: nil), name: "Studio")
        NetworkPath.shared.force(true)
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let home = AgentHomeViewController(context: context, id: connection.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let shell = ShellViewController(context: context, phone: navigation, splits: false)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: shell)
        window.overrideUserInterfaceStyle = .light
        shell.view.layoutIfNeeded()
        addTeardownBlock { @MainActor [context] in
            _ = context
            window.isHidden = true
            previous?.makeKey()
            await session.engine.stop()
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        await session.engine.start()
        try await wait("home live, its places listed") {
            session.home.live && session.home.rows.contains { $0.targetKind == "pipelines" } && session.home.rows.contains { $0.id == "task:notes" }
        }
        return Rig(context: context, session: session, id: connection.id, home: home, shell: shell, navigation: navigation, window: window)
    }

    private func settled(_ navigation: UINavigationController) async throws {
        try await wait("settled") { navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(450))
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for child in view.subviews {
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    private func drawn(_ list: SidebarList) -> [String] { list.rows.map(\.id) }

    func testHomeTheDrawerAPlaceAndSettings() async throws {
        let rig = try await rig()
        try await settled(rig.navigation)
        let drawer = try XCTUnwrap(PhoneDrawer.of(rig.navigation), "no drawer on the phone's home")

        // Home: the shared bot, the bots, the tasks; no place, project or Surface.
        let homeList = try XCTUnwrap(Self.subview(SidebarList.self, in: rig.home.view))
        try await wait("home's bots and tasks") { self.drawn(homeList).contains("task:notes") }
        XCTAssertEqual(drawn(homeList), ["bot:happy", "direct:bots", "bot:research", "direct:tasks", "task:ship", "task:notes"])
        // The face opens the drawer; the call is the bar's one other button, no settings.
        XCTAssertEqual(rig.home.navigationItem.leftBarButtonItem?.customView?.accessibilityIdentifier, "account-switcher")
        XCTAssertEqual(rig.home.navigationItem.leftBarButtonItem?.customView?.accessibilityLabel, Strings.Drawer.open)
        XCTAssertFalse((rig.home.navigationItem.rightBarButtonItems ?? []).contains { $0.accessibilityIdentifier == "settings" })
        capture(rig.window, "drawer-home")

        // Open: Home lit, then the places in the drawer's order, the
        // calendar under a divider, Settings at the foot.
        drawer.open(animated: false)
        try await wait("the drawer's rows") { self.drawn(drawer.list).contains("surface:family") }
        XCTAssertEqual(drawn(drawer.list).filter { $0 != "direct:feed" }, [
            "drawer:home", "direct:artifacts", "direct:documents", "direct:todos", "direct:plugins", "direct:pipelines",
            Drawer.surfacesId, "surface:family",
        ])
        XCTAssertEqual(drawer.list.selectedRowId, Drawer.homeId)
        XCTAssertEqual(drawn(drawer.foot), [Drawer.settingsId])
        XCTAssertEqual(drawer.progress, 1)
        try await Task.sleep(for: .milliseconds(450))
        capture(rig.window, "drawer-open")
        rig.window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(450))
        capture(rig.window, "drawer-open")
        rig.window.overrideUserInterfaceStyle = .light

        // Documents: the root, in home's place, ☰ where back would be.
        drawer.select(try XCTUnwrap(drawer.list.rows.first { $0.id == "direct:documents" }))
        try await settled(rig.navigation)
        let documents = try XCTUnwrap(rig.navigation.viewControllers.first as? SurfaceListViewController, "\(rig.navigation.viewControllers)")
        XCTAssertEqual(rig.navigation.viewControllers.count, 1)
        XCTAssertEqual(documents.section, .documents)
        XCTAssertEqual(documents.navigationItem.leftBarButtonItem?.accessibilityIdentifier, "drawer-menu")
        XCTAssertTrue(PhoneDrawer.of(rig.navigation) === drawer, "the drawer stays with the stack")
        XCTAssertTrue(rig.shell.agentHome === rig.home, "the home behind Documents")
        XCTAssertEqual(drawer.progress, 0)
        try await wait("the documents") { documents.list.items.filter { $0.kind == .row }.count == 2 }
        try await Task.sleep(for: .milliseconds(300))
        capture(rig.window, "drawer-documents")

        // Opened again over Documents, Documents is lit.
        drawer.open(animated: false)
        XCTAssertEqual(drawer.list.selectedRowId, "direct:documents")
        try await Task.sleep(for: .milliseconds(450))
        capture(rig.window, "drawer-open-documents")

        // A screen pushed over the place: no drawer over it, and back is the place.
        drawer.close(animated: false)
        rig.navigation.pushViewController(UIViewController(), animated: false)
        XCTAssertFalse(drawer.canOpen)
        rig.navigation.popViewController(animated: false)
        XCTAssertTrue(rig.navigation.topViewController === documents)
        XCTAssertTrue(drawer.canOpen)

        // Home again: the same one, as it was.
        drawer.open(animated: false)
        drawer.select(try XCTUnwrap(drawer.list.rows.first { $0.id == Drawer.homeId }))
        try await settled(rig.navigation)
        XCTAssertEqual(rig.navigation.viewControllers.count, 1)
        XCTAssertTrue(rig.navigation.viewControllers.first === rig.home)
        XCTAssertEqual(drawn(homeList), ["bot:happy", "direct:bots", "bot:research", "direct:tasks", "task:ship", "task:notes"])

        // Settings at the foot is pushed over home.
        drawer.open(animated: false)
        drawer.select(try XCTUnwrap(drawer.foot.rows.first))
        try await settled(rig.navigation)
        let settings = try XCTUnwrap(rig.navigation.topViewController as? SettingsViewController)
        XCTAssertEqual(rig.navigation.viewControllers.count, 2)
        // Plugins ends the Agents group, where the server serves them, and opens its page.
        try await wait("Plugins in Settings") { settings.shownRow("plugins") != nil }
        let agents = try XCTUnwrap(settings.shownRowIDs.first { $0.contains("plugins") })
        XCTAssertEqual(agents.last, "plugins")
        XCTAssertEqual(agents.dropLast().last, "usage")
        XCTAssertEqual(settings.shownRow("plugins")?.title, "Plugins")
        settings.tapRow("plugins")
        try await settled(rig.navigation)
        XCTAssertTrue(rig.navigation.topViewController is PluginsViewController)
        rig.navigation.popToRootViewController(animated: false)
        try await settled(rig.navigation)

        // The picture: Settings scrolled to Plugins.
        SettingsViewController.open(context: rig.context, computer: rig.id, reveal: "plugins", from: rig.home)
        try await settled(rig.navigation)
        try await Task.sleep(for: .milliseconds(1200))
        capture(rig.window, "settings-plugins")
    }

    /// Pipelines the drawer made the root goes back to home once the
    /// account no longer has it; the call's home does the same from any place.
    func testHomeComesBackFromAPlace() async throws {
        let rig = try await rig()
        try await settled(rig.navigation)
        let drawer = try XCTUnwrap(PhoneDrawer.of(rig.navigation))
        drawer.open(animated: false)
        drawer.select(try XCTUnwrap(drawer.list.rows.first { $0.id == "direct:todos" }))
        try await settled(rig.navigation)
        XCTAssertTrue(rig.navigation.viewControllers.first is SurfaceListViewController)
        rig.navigation.pushViewController(UIViewController(), animated: false)
        _ = await CallScreens.home(in: rig.shell)
        try await settled(rig.navigation)
        XCTAssertEqual(rig.navigation.viewControllers.count, 1)
        XCTAssertTrue(rig.navigation.viewControllers.first === rig.home)
        XCTAssertEqual(drawer.shownId, Drawer.homeId)
    }

    /// Another root on the stack (another account's home, Start) lets the
    /// drawer go.
    func testAnotherRootLetsTheDrawerGo() async throws {
        let rig = try await rig()
        try await settled(rig.navigation)
        XCTAssertNotNil(PhoneDrawer.of(rig.navigation))
        rig.shell.setStack([UIViewController()], animated: false)
        XCTAssertNil(PhoneDrawer.of(rig.navigation))
        XCTAssertNil(rig.shell.agentHome)
    }
}
#endif
