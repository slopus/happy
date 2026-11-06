#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyCrypto
@testable import HappyUI
import UIKit
import XCTest

/// The network these tests run on: refused at once while the accounts are
/// set up, then a black hole that never answers, as on a train or with a
/// dead server. A request there waits, deaf even to cancellation, until
/// the test lets go of it at its end.
private final class Network: @unchecked Sendable {
    private let lock = NSLock()
    private var holes = false
    private var sent: [HTTPRequest] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []
    var blackHole: Bool {
        get { lock.withLock { holes } }
        set { lock.withLock { holes = newValue } }
    }
    var requests: [HTTPRequest] { lock.withLock { sent } }
    func record(_ request: HTTPRequest) { lock.withLock { sent.append(request) } }

    /// Waits in a black hole; refused otherwise.
    func wait() async throws {
        await hold()
        throw URLError(.notConnectedToInternet)
    }

    /// Returns only once `release` is called, while a black hole.
    func hold() async {
        await withCheckedContinuation { continuation in
            let held = lock.withLock {
                if holes { waiting.append(continuation) }
                return holes
            }
            if !held { continuation.resume() }
        }
    }

    /// The end of the test: everything held goes, refused.
    func release() {
        let held = lock.withLock {
            holes = false
            defer { waiting = [] }
            return waiting
        }
        held.forEach { $0.resume() }
    }
}

private struct HTTP: HTTPTransport {
    let network: Network
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        network.record(request)
        try await network.wait()
        throw URLError(.notConnectedToInternet)
    }
}

private struct Sockets: WebSocketConnector {
    let network: Network
    func connect(to url: URL) async throws -> WebSocketConnection {
        try await network.wait()
        throw URLError(.notConnectedToInternet)
    }
}

private struct Agent: AgentTransport {
    let network: Network
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await network.wait()
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        try await network.wait()
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// What stays on the phone between two launches: the Keychain, the
/// per-account device settings and the account folders.
@MainActor
private final class Phone {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("instant-signout-\(UUID().uuidString)", isDirectory: true)
    let shared = InMemoryCredentialStore()
    lazy var own = InMemoryAccountCredentialStore(sharedStore: shared)
    let agents = InMemoryAgentConnectionCredentialStore()
    let unregisters = InMemoryPushUnregisterStore()
    var settings: [String: InMemoryKeyValueStore] = [:]
    let network = Network()

    /// `killed`: its cleanups stop straight after being written down, as
    /// when the app is killed in the frame after the confirm.
    func launch(killed: Bool = false) -> AccountController {
        let network = network
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: shared, storeDirectory: directory,
            accountCredentialStore: own,
            agentConnectionCredentialStore: agents,
            agentTransport: { _ in Agent(network: network) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: { [unowned self] id in
                if let kept = settings[id] { return kept }
                let made = InMemoryKeyValueStore()
                settings[id] = made
                return made
            },
            transport: HTTP(network: network), connector: Sockets(network: network),
            pushUnregisterStore: unregisters)
        if killed { account.holdRemoval = { await network.hold() } }
        return account
    }
}

/// Signing out of a Happy account and disconnecting an agent are instant:
/// once the person confirms, the account leaves the accounts card, and the
/// next account's home (or the first screen) takes over within a frame or
/// two, on a network that never answers. What is slow (the push token's
/// removal, the socket, the store, the folders, the Keychain) goes on
/// behind it, and a relaunch in the middle finishes it without the
/// account ever coming back.
@MainActor
final class HostedInstantSignOutTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func stack(in window: UIWindow) -> UINavigationController? {
        var queue = [window.rootViewController].compactMap { $0 }
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let navigation = next as? UINavigationController { return navigation }
            queue += next.children
        }
        return nil
    }

    @discardableResult
    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private struct App {
        var phone: Phone
        var account: AccountController
        var coordinator: AppCoordinator
        var navigation: UINavigationController
        var window: UIWindow
        /// The Happy accounts and the agents, in the order added.
        var happy: [AccountSummary.ID]
        var agents: [String]
    }

    /// `happy` Happy accounts and `agents` agents, in a window the
    /// coordinator owns, with `active` the one open. Each Happy account has
    /// a push token registered, as on a phone that allowed notifications.
    private func app(happy: Int, agents: Int, active: (App) -> String) async throws -> App {
        let phone = Phone()
        let account = phone.launch(killed: true)
        await account.restore()
        var happyIDs: [String] = []
        for index in 0..<happy {
            try await account.signIn(Credentials(token: "token-\(index)", secret: Data(repeating: UInt8(40 + index), count: 32)))
            let id = try XCTUnwrap(account.session?.keys.anonID)
            account.localSettings.registeredPushToken = "ExponentPushToken[\(index)]"
            happyIDs.append(id)
        }
        var agentIDs: [String] = []
        for index in 0..<agents {
            try await account.addAgentConnection(JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"instant-signout-\#(index)","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)), name: "Mac \(index + 1)")
            let id = try XCTUnwrap(account.agentConnections.activeID)
            agentIDs.append(id)
            addTeardownBlock { @MainActor in Session.forget(id) }
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        addTeardownBlock { @MainActor in
            phone.network.release()
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
            try? FileManager.default.removeItem(at: phone.directory)
        }
        let navigation = try XCTUnwrap(stack(in: window))
        var app = App(phone: phone, account: account, coordinator: coordinator, navigation: navigation, window: window, happy: happyIDs, agents: agentIDs)
        let wanted = active(app)
        if account.accounts.first(where: \.isActive)?.id != wanted || account.agentConnections.activeID.map({ $0 != wanted }) == true {
            try await account.switchAccount(to: wanted)
        }
        let home = try await until { self.homeAccount(navigation) == wanted }
        XCTAssertTrue(home, "the window never showed \(wanted)'s home: \(navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(600))
        // From here on, nothing answers.
        phone.network.blackHole = true
        app.account = account
        return app
    }

    private func openSettings(_ app: App) async throws -> SettingsViewController {
        let home = try XCTUnwrap(app.navigation.viewControllers.first)
        SettingsViewController.open(context: app.coordinator.context, computer: nil, from: home)
        let settings = try XCTUnwrap(app.navigation.topViewController as? SettingsViewController)
        try await until { app.navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(300))
        return settings
    }

    /// The account the root's home is for; "start" for the first screen.
    private func homeAccount(_ navigation: UINavigationController) -> String? {
        guard let root = navigation.viewControllers.first else { return nil }
        if root is StartViewController { return "start" }
        let fields = Mirror(reflecting: root).children
        if root is LegacyHomeViewController {
            return (fields.first { $0.label == "session" }?.value as? AccountSession)?.keys.anonID
        }
        if root is AgentHomeViewController {
            return fields.first { $0.label == "id" }?.value as? String
        }
        return nil
    }

    /// Sign out or Disconnect as the person does it: the row's action, the
    /// confirmation (read for a moment), its destructive button. Measures
    /// from that button until the account is off the card and, when it was
    /// the one open, `next`'s home (or "start") is the root: in frames drawn
    /// (display ticks, so the first frame after the button is 1), in
    /// milliseconds, and the longest the main thread went without a frame.
    private func signOut(_ id: String, direct: Bool, settings: SettingsViewController, app: App, next: String?) async throws -> Timing {
        settings.remove(id, direct: direct)
        try await until { settings.presentedViewController is UIAlertController }
        let alert = try XCTUnwrap(settings.presentedViewController as? UIAlertController, "no confirmation")
        XCTAssertTrue(app.account.accounts.contains { $0.id == id }, "gone before the confirm")
        try await Task.sleep(for: .milliseconds(400))
        let action = try XCTUnwrap(alert.actions.first { $0.style == .destructive }, "no destructive button")
        // `UIAlertAction` keeps its handler private; a test reaches it by key.
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        let handler = unsafeBitCast(try XCTUnwrap(action.value(forKey: "handler") as AnyObject?), to: Handler.self)
        var start: CFTimeInterval?
        var moved: Double?
        var drawn = 0
        var last = CACurrentMediaTime()
        var longest = 0.0
        let gone = { [unowned self] in
            // Off the card, or the card itself gone with the old root.
            (!settings.shownRowIDs.joined().contains("account:\(id)") || !app.navigation.viewControllers.contains(settings))
                && !app.account.accounts.contains { $0.id == id }
                && (next == nil || self.homeAccount(app.navigation) == next)
        }
        let ticks = TickRecorder { _ in
            let now = CACurrentMediaTime()
            guard let start, moved == nil else { return }
            longest = max(longest, now - max(last, start))
            last = now
            drawn += 1
            if gone() { moved = (now - start) * 1000 }
        }
        defer { ticks.stop() }
        alert.dismiss(animated: false) {
            start = CACurrentMediaTime()
            last = start!
            handler(action)
        }
        try await until(15) { moved != nil }
        let ms = try XCTUnwrap(moved, "the account never left the screen")
        let timing = Timing(frames: drawn, ms: ms, longestGap: longest * 1000)
        print("INSTANT-SIGNOUT \(name): \(timing.frames) frames drawn, \(String(format: "%.1f", ms)) ms, longest main-thread gap \(String(format: "%.1f", timing.longestGap)) ms")
        return timing
    }

    private struct Timing { var frames: Int; var ms: Double; var longestGap: Double }

    /// The first or second frame drawn after the button shows the change, and
    /// nothing waited on the network (the old sign-out sat out the 5 s push
    /// unregister). Building the next home is real main-thread work (about
    /// 15 ms in a Debug simulator), so the milliseconds bound is loose enough
    /// for a loaded machine and far below any network wait.
    private func assertInstant(_ timing: Timing, line: UInt = #line) {
        XCTAssertLessThanOrEqual(Double(timing.frames), HostedTime.budget(2), "frame \(timing.frames) after the button showed it (\(timing.ms) ms)", line: line)
        XCTAssertLessThan(timing.ms, HostedTime.budget(250), "took \(timing.ms) ms", line: line)
    }

    func testSigningOutTheOpenHappyAccountOpensTheNextAtOnce() async throws {
        let app = try await app(happy: 2, agents: 0) { $0.happy[1] }
        let settings = try await openSettings(app)
        let timing = try await signOut(app.happy[1], direct: false, settings: settings, app: app, next: app.happy[0])
        assertInstant(timing)
        XCTAssertEqual(app.account.session?.keys.anonID, app.happy[0])
        try await assertRelaunchForgets(app.happy[1], app: app, opens: app.happy[0], pushToken: "ExponentPushToken[1]")
    }

    func testSigningOutAnotherHappyAccountLeavesTheOpenOne() async throws {
        let app = try await app(happy: 2, agents: 0) { $0.happy[1] }
        let settings = try await openSettings(app)
        let open = try XCTUnwrap(app.account.session)
        let timing = try await signOut(app.happy[0], direct: false, settings: settings, app: app, next: nil)
        assertInstant(timing)
        XCTAssertTrue(app.account.session === open)
        XCTAssertEqual(homeAccount(app.navigation), app.happy[1])
        try await assertRelaunchForgets(app.happy[0], app: app, opens: app.happy[1], pushToken: "ExponentPushToken[0]")
    }

    func testSigningOutTheLastAccountShowsTheFirstScreenAtOnce() async throws {
        let app = try await app(happy: 1, agents: 0) { $0.happy[0] }
        let settings = try await openSettings(app)
        let timing = try await signOut(app.happy[0], direct: false, settings: settings, app: app, next: "start")
        assertInstant(timing)
        try await assertRelaunchForgets(app.happy[0], app: app, opens: nil, pushToken: "ExponentPushToken[0]")
    }

    /// What a used agent keeps offline: a media cache of many files, so
    /// deleting its folder takes a while.
    private func keepMedia(for id: String) async throws {
        let media = try XCTUnwrap(OfflineFile.directory(for: id)).appendingPathComponent("media", isDirectory: true)
        try await Task.detached {
            try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
            let bytes = Data(repeating: 7, count: 64 * 1024)
            for index in 0..<1500 { try bytes.write(to: media.appendingPathComponent("\(index).jpg")) }
        }.value
    }

    func testDisconnectingTheOpenAgentOpensTheNextAtOnce() async throws {
        let app = try await app(happy: 1, agents: 2) { $0.agents[1] }
        try await keepMedia(for: app.agents[1])
        let settings = try await openSettings(app)
        let timing = try await signOut(app.agents[1], direct: true, settings: settings, app: app, next: app.agents[0])
        assertInstant(timing)
        XCTAssertEqual(app.account.agentConnections.activeID, app.agents[0])
        try await assertRelaunchForgets(app.agents[1], app: app, opens: nil)
    }

    func testDisconnectingAnotherAgentLeavesTheOpenOne() async throws {
        let app = try await app(happy: 1, agents: 2) { $0.agents[1] }
        try await keepMedia(for: app.agents[0])
        let settings = try await openSettings(app)
        let timing = try await signOut(app.agents[0], direct: true, settings: settings, app: app, next: nil)
        assertInstant(timing)
        XCTAssertEqual(app.account.agentConnections.activeID, app.agents[1])
        XCTAssertEqual(homeAccount(app.navigation), app.agents[1])
        try await assertRelaunchForgets(app.agents[0], app: app, opens: nil)
    }

    /// The app is killed straight after the confirm (its cleanup held at
    /// the first step), the network still a black hole: the next launch
    /// never lists the account, finishes forgetting it (its Keychain item,
    /// its folder) and, for a Happy account, keeps its push token's removal
    /// waiting for the server.
    private func assertRelaunchForgets(_ id: String, app: App, opens: String?, pushToken: String? = nil, line: UInt = #line) async throws {
        let phone = app.phone
        let folder = AccountSession.accountDirectory(directory: phone.directory, id: id)
        let agentFolder = OfflineFile.directory(for: id)
        func keychainHolds() -> Bool {
            (try? phone.own.ownAccounts()[id]) != nil
                || (try? phone.shared.load()).flatMap { try? AccountKeys(secret: $0.secretData ?? Data()).anonID } == id
                || (try? phone.agents.all()[id]) != nil
        }
        XCTAssertTrue(keychainHolds(), "the cleanup wasn't held: nothing is left for the relaunch to finish", line: line)

        let relaunched = phone.launch()
        await relaunched.restore()
        XCTAssertFalse(relaunched.accounts.contains { $0.id == id }, "the account came back after a relaunch", line: line)
        if let opens { XCTAssertTrue(relaunched.accounts.first(where: \.isActive)?.id == opens || relaunched.agentConnections.activeID == opens, line: line) }
        let forgotten = try await until(10) {
            !keychainHolds()
                && !FileManager.default.fileExists(atPath: folder.path)
                && (agentFolder.map { !FileManager.default.fileExists(atPath: $0.path) } ?? true)
        }
        XCTAssertTrue(forgotten, "the relaunch never finished forgetting \(id)", line: line)
        XCTAssertFalse(relaunched.accounts.contains { $0.id == id }, line: line)
        if let pushToken {
            let asked = try await until(5) { phone.network.requests.contains { $0.method == "DELETE" && $0.url.path == "/v1/push-tokens/\(pushToken)" } }
            XCTAssertTrue(asked, "the push token's removal was never sent", line: line)
            XCTAssertEqual((try? phone.unregisters.all()[id])?.pushToken, pushToken, "the push token's removal isn't kept for when the server answers", line: line)
        }
        phone.network.release()
        await relaunched.session?.stop()
    }
}
#endif
