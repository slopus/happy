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

/// What the machine was asked to spawn.
private final class SpawnLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [SpawnSessionOptions] = []
    var spawned: [SpawnSessionOptions] { lock.withLock { stored } }
    func add(_ options: SpawnSessionOptions) { lock.withLock { stored.append(options) } }
}

/// The machine: a spawn writes the new session's row, as sync would, and
/// answers with its id; or refuses.
private struct ComposeMachine: HomeOps {
    let store: LocalStore
    let refuses: Bool
    var log: SpawnLog?

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        log?.add(options)
        if refuses { return .error(errorMessage: "The machine said no") }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: HostedComposeTests.newSessionId, seq: 0, createdAt: now, updatedAt: now,
            active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": .string(options.agent ?? "claude"), "version": .string("1.2.6"),
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

    /// A second computer, Studio Mac, with a chat in a folder of its own.
    nonisolated static let studio = "studio-mac"
    nonisolated static let studioFolder = "/Users/harness/Developer/site"

    /// Happy Agent beside the seeded computer's Happy CLI, making tasks and
    /// bots.
    nonisolated static let happyAgent = "harness-happy-agent"

    private nonisolated static func seedHappyAgent(_ store: LocalStore) throws {
        guard var machine = try store.machines().first else { return }
        machine.id = happyAgent
        machine.createdAt += 1
        machine.metadata = .object([
            "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
            "machineKind": .string("rig"), "siblingMachineId": .string(SeededAccount.machineId),
            "capabilities": .object(["newSession": .bool(true), "bots": .bool(true), "tasks": .bool(true), "worktrees": .bool(false)]),
            "defaults": .object(["providerId": .string("codex"), "modelId": .string("gpt"), "permissionMode": .string("auto")]),
            "models": .array([
                .object(["providerId": .string("codex"), "id": .string("gpt"), "name": .string("GPT"), "providerName": .string("OpenAI"),
                         "thinkingLevels": .array([.string("medium"), .string("high")]), "defaultThinkingLevel": .string("medium")]),
                .object(["providerId": .string("claude"), "id": .string("opus"), "name": .string("Opus"), "providerName": .string("Anthropic"),
                         "thinkingLevels": .array([.string("low"), .string("max")]), "defaultThinkingLevel": .string("low")]),
            ]),
            "operatingModes": .array([
                .object(["code": .string("auto"), "value": .string("Auto")]),
                .object(["code": .string("read_only"), "value": .string("Read only")]),
            ]),
        ])
        try store.upsertMachine(machine)
    }

    private nonisolated static func seedLegacy(_ store: LocalStore, secondMachine: Bool, happyAgent: Bool = false) throws {
        try SeededAccount.seed(store)
        try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        if happyAgent { try seedHappyAgent(store) }
        guard secondMachine, let initialMachine = try store.machines().first,
              let template = try store.sessions().first else { return }
        var machine = initialMachine
        machine.id = studio
        machine.createdAt -= 1
        var metadata = machine.metadata?.objectValue ?? [:]
        metadata["displayName"] = .string("Studio Mac")
        metadata["host"] = .string("studio-mac")
        machine.metadata = .object(metadata)
        try store.upsertMachine(machine)
        var row = template
        row.id = "studio-site"
        var fields = row.metadata?.objectValue ?? [:]
        fields["machineId"] = .string(studio)
        fields["host"] = .string("studio-mac")
        fields["path"] = .string(studioFolder)
        fields["summary"] = .object(["text": .string("Landing page")])
        row.metadata = .object(fields)
        try store.upsertSessions([row])
    }

    private func legacyHome(refuses: Bool = false, secondMachine: Bool = false, happyAgent: Bool = false, log: SpawnLog? = nil) async throws -> (LegacyHomeViewController, UINavigationController, UIWindow, AccountSession, AppContext) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ComposeOffline(), connector: ComposeNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached { [store, secondMachine, happyAgent] in
            try HostedComposeTests.seedLegacy(store, secondMachine: secondMachine, happyAgent: happyAgent)
        }.value
        // The last place picked: the seeded machine's project, in Claude.
        let drafts = NewSessionDraftStore.shared(for: controller.localSettings)
        drafts.setMachineId(SeededAccount.machineId)
        drafts.setPath(SeededAccount.project)
        drafts.setInput("")
        if happyAgent { drafts.pickAgentType(.claude) }
        LegacyComposeStart.makeStarter = { account in
            SessionStarter(environment: .init(
                ops: ComposeMachine(store: account.store, refuses: refuses, log: log),
                sessionOps: ComposeSessionOps(),
                sender: account.sender,
                metadataTransport: account.realtime,
                saveInitialModes: { [sender = account.sender] in try await sender.saveInitialModes(sessionId: $0, patch: $1) },
                refreshSessions: {},
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
        // Empty, the header is Back alone.
        assertHeader(of: chat, shown: false)
        card.setText("Fix the header shadow", selection: NSRange(location: 21, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)

        try await until { !chat.isComposing }
        // The name and Compose came in with the send.
        assertHeader(of: chat, shown: true)
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
        // The start said what it was doing in the header; refused, it is
        // the empty chat's again.
        try await until { (chat.navigationItem.titleView as? ChatHeaderView)?.capsule.alpha == 0 }
        assertHeader(of: chat, shown: false)
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
        assertHeader(of: open, shown: true)
        assertHeader(of: empty, shown: false)
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

    /// One computer: folder and harness are visible, and model picks
    /// before the first send reach the spawn on that computer.
    func testLegacyOneMachinePicksFolderHarnessAndModelBeforeFirstSend() async throws {
        let log = SpawnLog()
        let (home, navigation, window, account, _) = try await legacyHome(log: log)
        defer { window.isHidden = true }
        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let card = try await composerCard(in: chat)
        let panel = try XCTUnwrap(Self.subview(NewWorkPanel.self, in: chat.view))
        let start = try XCTUnwrap(chat.composeStart)
        try await until { panel.folder.title.contains("happy") }
        XCTAssertEqual(start.kinds, [.session])
        XCTAssertFalse(panel.kind.isHidden, "Session | Bot | Task always show")
        XCTAssertEqual(start.enabledKinds, [.session], "Happy CLI alone makes sessions")
        XCTAssertEqual((0..<3).map(panel.kind.isEnabledForSegment), [true, false, false], "Bot and Task show disabled")
        XCTAssertFalse(panel.machine.isHidden, "the computer shows, with whether it answers")
        XCTAssertFalse(panel.folder.isHidden)
        XCTAssertFalse(panel.harness.isHidden)
        XCTAssertGreaterThan(panel.harness.frame.minY, panel.folder.frame.maxY)
        assertCentred(panel, in: chat)
        keep(window, "legacy-new-work-one-machine")

        XCTAssertNotNil(card.configuration.model?.menu, "the model must be pickable before a session exists")
        XCTAssertNotNil(card.configuration.permission?.menu)
        let harnesses = Self.actions(start.harnessMenuElements())
        try XCTUnwrap(harnesses.first { $0.title == "Codex" }).performWithSender(nil, target: nil)
        try await until { panel.harness.title == "Codex" }
        let model = try XCTUnwrap(start.composer.choices.modelOptions.first { $0.key != "default" && !$0.isDisabled })
        card.delegate?.agentInputCard(card, didSelect: model.key, in: .model)
        try await until { card.configuration.model?.menu?.selectedKey == model.key }
        XCTAssertEqual(start.drafts.draft.agentType, .codex)
        XCTAssertEqual(start.drafts.draft.pickedAgentType, .codex)
        XCTAssertEqual(start.drafts.draft.modelMode, model.key)
        keep(window, "legacy-new-work-codex-model")

        // Its folders, newest first: the worktree and the project.
        let folders = Self.actions(start.folderMenuElements())
        XCTAssertTrue(folders.contains { $0.title.contains("chat-nav") }, "\(folders.map(\.title))")
        XCTAssertTrue(folders.contains { $0.title.contains("happy") && !$0.title.contains("chat-nav") }, "\(folders.map(\.title))")
        let worktree = try XCTUnwrap(folders.first { $0.title.contains("chat-nav") })
        worktree.performWithSender(nil, target: nil)
        try await until { panel.folder.title.contains("chat-nav") }

        card.setText("Tidy the strip", selection: NSRange(location: 14, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertEqual(log.spawned.map(\.machineId), [SeededAccount.machineId])
        XCTAssertEqual(log.spawned.map(\.directory), [SeededAccount.worktree], "the folder picked isn't where it started")
        XCTAssertEqual(log.spawned.map(\.agent), ["codex"])
        XCTAssertEqual(log.spawned.map(\.modelMode), [model.key])
        let store = account.store
        let outbox = try await Task.detached { try store.pendingOutbox() }.value
        let first = try XCTUnwrap(outbox.first { $0.sessionId == Self.newSessionId && $0.kind == .message })
        XCTAssertEqual(first.payload["meta"]?["model"]?.stringValue, model.key, "the first message used a different model")
        try await until { panel.isHidden }
    }

    /// Two computers: the computer is asked too, and the folders follow
    /// it: another computer lists its own, starts in its newest, and the
    /// session starts there.
    func testLegacyTwoMachinesAskTheMachineAndTheFoldersFollowIt() async throws {
        let log = SpawnLog()
        let (home, navigation, window, _, _) = try await legacyHome(secondMachine: true, log: log)
        defer { window.isHidden = true }
        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let card = try await composerCard(in: chat)
        let panel = try XCTUnwrap(Self.subview(NewWorkPanel.self, in: chat.view))
        let start = try XCTUnwrap(chat.composeStart)
        try await until { panel.machine.title == "Harness Mac" }
        XCTAssertTrue(panel.folder.title.contains("happy"))
        XCTAssertLessThan(panel.machine.frame.maxY, panel.folder.frame.minY, "the computer is over its folder")
        assertCentred(panel, in: chat)
        keep(window, "legacy-new-work-two-machines")

        let machines = Self.actions(start.machineMenuElements())
        XCTAssertEqual(Set(machines.map(\.title)), ["Harness Mac", "Studio Mac"])
        XCTAssertFalse(Self.actions(start.folderMenuElements()).contains { $0.title.contains("site") }, "another computer's folder was offered")
        try XCTUnwrap(machines.first { $0.title == "Studio Mac" }).performWithSender(nil, target: nil)
        try await until { panel.machine.title == "Studio Mac" && panel.folder.title.contains("site") }
        let folders = Self.actions(start.folderMenuElements()).map(\.title)
        XCTAssertTrue(folders.contains { $0.contains("site") }, "\(folders)")
        XCTAssertFalse(folders.contains { $0.contains("chat-nav") }, "the first computer's folders stayed: \(folders)")
        keep(window, "legacy-new-work-studio")

        card.setText("Ship the landing page", selection: NSRange(location: 21, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.studio], "it started on the other computer")
        XCTAssertEqual(log.spawned.map(\.directory), [Self.studioFolder])
    }

    /// Picks a segment of the panel's Session | Bot | Task as a tap does.
    private func pick(_ kind: HomeDockKind, in panel: NewWorkPanel) throws {
        panel.kind.selectedSegmentIndex = try XCTUnwrap(panel.sessionKinds.firstIndex(of: kind))
        panel.kind.sendActions(for: .valueChanged)
    }

    /// Happy Agent beside the computer's Happy CLI: Session | Bot | Task
    /// heads the empty chat. A task asks the computer alone, takes Happy
    /// Agent's model as picked in the composer, and its first message is
    /// the text sent.
    func testLegacyTaskOnAComputerWithHappyAgent() async throws {
        let log = SpawnLog()
        let (home, navigation, window, account, _) = try await legacyHome(happyAgent: true, log: log)
        defer { window.isHidden = true }
        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let card = try await composerCard(in: chat)
        let panel = try XCTUnwrap(Self.subview(NewWorkPanel.self, in: chat.view))
        let start = try XCTUnwrap(chat.composeStart)
        try await until { start.kinds == [.session, .bot, .task] }
        XCTAssertEqual(panel.sessionKinds, [.session, .bot, .task])
        XCTAssertEqual(start.drafts.draft.agentType, .claude)
        XCTAssertFalse(panel.folder.isHidden)
        assertCentred(panel, in: chat)
        keep(window, "legacy-new-work-kinds")

        try pick(.task, in: panel)
        try await until { panel.folder.isHidden && start.drafts.draft.agentType == .rig }
        XCTAssertTrue(start.drafts.createsTask)
        XCTAssertFalse(panel.machine.isHidden, "a task lives on a computer: it is shown")
        XCTAssertTrue(panel.harness.isHidden)
        try await until { card.configuration.placeholder == "What should this task do?" }
        try await until { card.configuration.model?.menu?.selectedKey == "codex:gpt" }
        card.delegate?.agentInputCard(card, didSelect: "claude:opus", in: .model)
        try await until { card.configuration.model?.menu?.selectedKey == "claude:opus" }
        assertCentred(panel, in: chat)
        keep(window, "legacy-new-work-task")

        card.setText("Fix the login redirect", selection: NSRange(location: 22, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.happyAgent])
        XCTAssertEqual(log.spawned.map(\.agent), ["rig"])
        XCTAssertEqual(log.spawned.map(\.providerId), ["claude"])
        XCTAssertEqual(log.spawned.map(\.modelId), ["opus"])
        XCTAssertEqual(log.spawned.map(\.happyAgentTarget), [.object(["kind": .string("task")])])
        let store = account.store
        let outbox = try await Task.detached { try store.pendingOutbox() }.value
        let first = try XCTUnwrap(outbox.first { $0.sessionId == Self.newSessionId && $0.kind == .message })
        XCTAssertEqual(first.payload["content"]?["text"]?.stringValue, "Fix the login redirect")
        XCTAssertFalse(start.drafts.createsTask, "the next compose offers a session")
        try await until { panel.isHidden }
    }

    /// A bot needs its name: without one the name field asks for it in
    /// place (no alert), and the text stays;
    /// named, it is made on Happy Agent and opens, wearing no face.
    func testLegacyBotNeedsItsNameAndTakesTheFirstMessage() async throws {
        let log = SpawnLog()
        let (home, navigation, window, account, _) = try await legacyHome(happyAgent: true, log: log)
        defer { window.isHidden = true }
        home.compose()
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let card = try await composerCard(in: chat)
        let panel = try XCTUnwrap(Self.subview(NewWorkPanel.self, in: chat.view))
        let start = try XCTUnwrap(chat.composeStart)
        try await until { start.kinds.contains(.bot) }
        try pick(.bot, in: panel)
        try await until { panel.sessionKind == .bot && start.drafts.draft.agentType == .rig }
        XCTAssertTrue(panel.folder.isHidden)
        XCTAssertEqual(panel.name.placeholder, "Name your bot")
        assertCentred(panel, in: chat)
        keep(window, "legacy-new-work-bot")

        card.setText("Plan the release", selection: NSRange(location: 16, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { panel.name.isFirstResponder }
        XCTAssertNil(chat.presentedViewController, "asked in place, not in an alert")
        XCTAssertEqual(panel.validation, "Give the bot a name")
        XCTAssertEqual(panel.name.attributedPlaceholder?.string, "Give the bot a name")
        XCTAssertTrue(chat.isComposing)
        XCTAssertEqual(card.text, "Plan the release", "the text stays to send again")
        XCTAssertTrue(log.spawned.isEmpty)

        panel.name.text = "Release\nCaptain"
        panel.name.sendActions(for: .editingChanged)
        XCTAssertEqual(start.drafts.botName, "Release Captain")
        XCTAssertEqual(panel.name.text, "Release Captain")
        let composerView = try XCTUnwrap(Self.subview(SessionComposerView.self, in: chat.view))
        try await until { !composerView.sending }
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertNil(chat.presentedViewController, "no face to offer again")
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.happyAgent])
        XCTAssertEqual(log.spawned.map(\.happyAgentTarget), [.object(["kind": .string("bot"), "name": .string("Release Captain")])])
        let store = account.store
        let outbox = try await Task.detached { try store.pendingOutbox() }.value
        let first = try XCTUnwrap(outbox.first { $0.sessionId == Self.newSessionId && $0.kind == .message })
        XCTAssertEqual(first.payload["content"]?["text"]?.stringValue, "Plan the release", "the bot's first message")
        XCTAssertFalse(start.drafts.createsBot)
        XCTAssertEqual(start.drafts.botName, "")
    }

    /// The panel's middle is the middle of the room between the bar and
    /// the composer.
    private func assertCentred(_ panel: NewWorkPanel, in chat: LegacyChatViewController, line: UInt = #line) {
        chat.view.layoutIfNeeded()
        let bar = chat.navigationController?.navigationBar.frame.maxY ?? chat.view.safeAreaInsets.top
        let composer = Self.subview(AgentInputCardView.self, in: chat.view)?.convert(CGPoint.zero, to: chat.view).y ?? chat.view.bounds.maxY
        XCTAssertGreaterThan(panel.frame.minY, bar, line: line)
        XCTAssertLessThan(panel.frame.maxY, composer, line: line)
        XCTAssertEqual(panel.frame.midY, (bar + composer) / 2, accuracy: 30, "\(panel.frame) between \(bar) and \(composer)", line: line)
    }

    private static func actions(_ elements: [UIMenuElement]) -> [UIAction] {
        elements.flatMap { element -> [UIAction] in
            if let action = element as? UIAction { return [action] }
            if let menu = element as? UIMenu { return actions(menu.children) }
            return []
        }
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
        // The bar lists right to left: Settings, then the call.
        XCTAssertEqual(home.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["settings", "voice-call"])
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
        assertHeader(of: newWork, shown: false)
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
        let other = ChatViewController(session: session, agentId: "agent-other", title: "Header shadow", spaceId: "other", intro: nil)
        navigation.pushViewController(other, animated: false)
        window.layoutIfNeeded()
        assertHeader(of: other, shown: true)
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

    /// A conversation's header: Back alone while it is empty
    /// (`ConversationHeader`), its name and Compose once it has a message.
    private func assertHeader(of chat: UIViewController, shown: Bool, file: StaticString = #filePath, line: UInt = #line) {
        let item = chat.navigationItem
        let title = item.titleView as? ChatHeaderView
        XCTAssertEqual(title?.capsule.alpha, shown ? 1 : 0, "the name's capsule", file: file, line: line)
        XCTAssertEqual(title?.accessibilityElementsHidden, !shown, file: file, line: line)
        XCTAssertEqual(item.rightBarButtonItems?.compactMap(\.accessibilityIdentifier) ?? [], shown ? ["compose"] : [], "Compose", file: file, line: line)
    }

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
