#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct ComposeOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ComposeNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct ComposeUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// The machine: a spawn writes the new session's row, as sync would, and
/// answers with its id; or refuses.
private struct ComposeMachine: HomeOps {
    let store: LocalStore
    let refuses: Bool

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        if refuses { return .error(errorMessage: "The machine said no") }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: HostedComposeTests.newSessionId, seq: 0, createdAt: now, updatedAt: now,
            active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": .string("claude"), "version": .string("1.0.0"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
        try? await Task.detached { [store] in try store.upsertSessions([record]) }.value
        return .success(sessionId: HostedComposeTests.newSessionId)
    }
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult { .error(errorMessage: "") }
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult { .error(errorMessage: "") }
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { try! JSONDecoder().decode(MachineOperationResult.self, from: Data(#"{"success":true}"#.utf8)) }
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse { throw URLError(.cannotConnectToHost) }
}

private struct ComposeSessionOps: HomeSessionOps {
    func sessionKill(sessionId: String) async throws -> SessionKillResponse { throw URLError(.cannotConnectToHost) }
    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
    func archive(sessionId: String) async throws {}
    func ensureSessionReady(sessionId: String) async throws {}
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { throw URLError(.cannotConnectToHost) }
}

/// Compose on both homes and in both chats. Home has no text input of its
/// own; compose opens an empty chat over it; compose in a chat puts an
/// empty chat in its place, Back still leading home; the first send makes
/// the session and the same screen becomes its chat. With
/// `HAPPY_PREVIEW_DIR` set, it writes what each step showed.
@MainActor
final class HostedComposeTests: XCTestCase {
    nonisolated static let newSessionId = "compose-new-session"

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() {
        LegacyComposeStart.makeStarter = { SessionStarter.make(for: $0) }
        super.tearDown()
    }

    // MARK: Legacy

    private func legacyHome(refuses: Bool = false) async throws -> (LegacyHomeViewController, UINavigationController, UIWindow, AccountSession, AppContext) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ComposeOffline(), connector: ComposeNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        }.value
        // The last place picked: the seeded machine's project.
        let drafts = NewSessionDraftStore.shared(for: controller.localSettings)
        drafts.setMachineId(SeededAccount.machineId)
        drafts.setPath(SeededAccount.project)
        drafts.setInput("")
        LegacyComposeStart.makeStarter = { account in
            SessionStarter(environment: .init(
                ops: ComposeMachine(store: account.store, refuses: refuses),
                sessionOps: ComposeSessionOps(),
                sender: account.sender,
                metadataTransport: account.realtime,
                refreshSessions: {},
                paintBotFace: { _ in throw URLError(.cannotConnectToHost) },
                attachmentPlan: { [sender = account.sender] message, sessionId in try await sender.attachmentPlan(for: message, sessionId: sessionId) },
                spawnRequests: account.spawnRequests
            ))
        }
        let context = AppContext(account: controller, variant: .production, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = .light
        window.layoutIfNeeded()
        try await until { home.children.contains { $0 is SessionListViewController } && home.canCompose }
        return (home, navigation, window, account, context)
    }

    func testLegacyHomeHasNoInputAndComposeOpensEmptyChat() async throws {
        let (home, navigation, window, _, _) = try await legacyHome()
        defer { window.isHidden = true }
        XCTAssertNil(Self.subview(HomeDockView.self, in: home.view), "home has no dock")
        XCTAssertNil(Self.subview(UITextView.self, in: home.view), "nothing is typed on home")
        keep(window, "legacy-home")

        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertTrue(chat.isComposing)
        try await until { Self.subview(AgentInputCardView.self, in: chat.view)?.textView.isFirstResponder == true }
        try await Task.sleep(for: .milliseconds(400))
        keep(window, "legacy-empty-chat")

        // Back: home, and the empty chat is gone.
        navigation.popViewController(animated: true)
        try await settle(navigation)
        XCTAssertTrue(navigation.topViewController === home)
    }

    func testLegacyFirstSendBecomesTheChatInPlace() async throws {
        let (home, navigation, window, account, context) = try await legacyHome()
        defer { window.isHidden = true }
        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let card = try await composerCard(in: chat)
        let composer = try XCTUnwrap(Self.subview(SessionComposerView.self, in: chat.view))
        card.setText("Fix the header shadow", selection: NSRange(location: 21, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)

        try await until { !chat.isComposing }
        // The same screen and composer, now the session's; nothing pushed.
        XCTAssertTrue(navigation.topViewController === chat)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertEqual(chat.chatId, Self.newSessionId)
        XCTAssertTrue(Self.subview(SessionComposerView.self, in: chat.view) === composer)
        try await until { card.text.isEmpty }
        // The first message waits in the new session's outbox.
        let store = account.store
        try await until {
            (try? store.pendingOutbox().contains { $0.sessionId == Self.newSessionId }) == true
        }
        XCTAssertEqual(NewSessionDraftStore.shared(for: context.account.localSettings).draft.input, "")
        try await Task.sleep(for: .milliseconds(600))
        keep(window, "legacy-after-first-send")
    }

    func testLegacyRefusedStartKeepsTheText() async throws {
        let (home, navigation, window, _, _) = try await legacyHome(refuses: true)
        defer { window.isHidden = true }
        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let card = try await composerCard(in: chat)
        card.setText("Try again later", selection: NSRange(location: 15, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { chat.presentedViewController is UIAlertController }
        keep(window, "legacy-start-refused")
        chat.presentedViewController?.dismiss(animated: false)
        XCTAssertTrue(chat.isComposing, "still the empty chat")
        XCTAssertEqual(card.text, "Try again later", "the text stays to send again")
        XCTAssertTrue(navigation.topViewController === chat)
    }

    func testLegacyComposeInAChatReplacesItKeepingBackHome() async throws {
        let (home, navigation, window, _, context) = try await legacyHome()
        defer { window.isHidden = true }
        home.push(.session(id: "seeded-tab-4"), context: context)
        try await settle(navigation)
        let open = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        try await Task.sleep(for: .milliseconds(500))
        keep(window, "legacy-chat-before-compose")

        open.compose()
        // Frames of the replacement as it slides in.
        for frame in 0..<6 {
            keep(window, "legacy-replace-\(frame)", afterUpdates: false)
            try await Task.sleep(for: .milliseconds(70))
        }
        try await settle(navigation)
        let empty = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        XCTAssertFalse(empty === open)
        XCTAssertTrue(empty.isComposing)
        XCTAssertEqual(navigation.viewControllers.count, 2, "the stack grows no deeper")
        XCTAssertTrue(navigation.viewControllers.first === home)
        XCTAssertNil(open.parent, "the chat it replaced has gone")

        // Compose again on the empty chat: nothing new.
        empty.compose()
        try await settle(navigation)
        XCTAssertTrue(navigation.topViewController === empty)

        navigation.popViewController(animated: true)
        try await settle(navigation)
        XCTAssertTrue(navigation.topViewController === home, "Back leads home")
        // Home is as it was: no input, and no room kept at its foot for
        // one. This is what the dock that used to fade in there left
        // behind (HostedHomeDockFadeTests, which went with it).
        home.view.layoutIfNeeded()
        XCTAssertNil(Self.subview(HomeDockView.self, in: home.view), "home grew a dock on the way back")
        XCTAssertNil(Self.subview(AgentInputCardView.self, in: home.view), "home grew an input on the way back")
    }

    // MARK: Main

    func testAgentHomeComposeOpensNewWorkAndChatComposeReplaces() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in ComposeUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ComposeOffline(), connector: ComposeNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"compose-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Personal MacBook Pro"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: computer.id)
        let navigation = UINavigationController(rootViewController: home)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        XCTAssertNil(Self.subview(AgentInputCardView.self, in: home.view), "home has no composer")
        XCTAssertNil(Self.subview(UITextView.self, in: home.view), "nothing is typed on home")
        XCTAssertEqual(home.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["settings"])
        XCTAssertTrue(home.toolbarItems?.contains { $0.accessibilityIdentifier == "compose" } == true)
        XCTAssertFalse(navigation.isToolbarHidden)
        // iOS 26 moves the field into its floating toolbar; the owning
        // UISearchBar and UIToolbar wrappers can have zero frames.
        let field = home.search.bar.searchTextField
        let toolbarFrame = field.convert(field.bounds, to: window)
        XCTAssertGreaterThan(toolbarFrame.minY, window.bounds.midY)
        let selector = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        let name = try XCTUnwrap(Self.subview(StyledLabel.self, in: selector))
        XCTAssertEqual(name.string, "Personal MacBook Pro")
        XCTAssertEqual(name.numberOfLines, 1)
        XCTAssertGreaterThanOrEqual(name.bounds.width, name.sizeThatFits(CGSize(width: 1_000, height: 100)).width)
        XCTAssertGreaterThan(home.view.safeAreaInsets.bottom, 40, "the list reserves room for the bottom toolbar")
        keep(window, "main-home")

        home.search.begin()
        try await until { home.search.isActive && home.search.bar.searchTextField.isFirstResponder }
        try await Task.sleep(for: .milliseconds(400))
        let fieldFrame = field.convert(field.bounds, to: window)
        XCTAssertGreaterThan(fieldFrame.minY, navigation.navigationBar.frame.maxY + 80, "active search remains below the header")
        keep(window, "main-home-bottom-search")
        home.search.end()
        try await until { !home.search.isActive && !home.search.bar.searchTextField.isFirstResponder }
        try await Task.sleep(for: .milliseconds(400))

        home.compose()
        try await until { navigation.topViewController is ChatViewController && navigation.transitionCoordinator == nil }
        let newWork = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertTrue(navigation.isToolbarHidden, "home actions leave with home")
        try await until { Self.subview(AgentInputCardView.self, in: newWork.view)?.textView.isFirstResponder == true }
        try await Task.sleep(for: .milliseconds(400))
        keep(window, "main-new-work")

        // Compose on new work standing empty: it is the one, so it stays.
        newWork.compose()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(navigation.topViewController === newWork)
        XCTAssertEqual(navigation.viewControllers.count, 2)

        // From another conversation: the empty new work takes its place.
        navigation.popViewController(animated: false)
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let other = ChatViewController(session: session, agentId: "agent-other", title: "Header shadow", spaceId: "other", seedling: nil)
        navigation.pushViewController(other, animated: false)
        window.layoutIfNeeded()
        other.compose()
        for frame in 0..<6 {
            try await Task.sleep(for: .milliseconds(70))
            keep(window, "main-replace-\(frame)", afterUpdates: false)
        }
        try await until { navigation.topViewController !== other && navigation.transitionCoordinator == nil }
        XCTAssertTrue(navigation.topViewController is ChatViewController)
        XCTAssertEqual(navigation.viewControllers.count, 2, "the stack grows no deeper")
        XCTAssertTrue(navigation.viewControllers.first === home)
        navigation.popViewController(animated: true)
        try await until { navigation.topViewController === home && navigation.transitionCoordinator == nil }
        XCTAssertFalse(navigation.isToolbarHidden, "Back restores home's native toolbar")
    }

    // MARK: Helpers

    private func composerCard(in chat: LegacyChatViewController) async throws -> AgentInputCardView {
        try await until { chat.contentInstalled && Self.subview(AgentInputCardView.self, in: chat.view) != nil }
        let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view))
        try await until { card.textView.isFirstResponder }
        return card
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "timed out", file: file, line: line)
    }

    private func settle(_ navigation: UINavigationController) async throws {
        try await until { navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(50))
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

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for child in view.subviews {
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }
}
#endif
