#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct TargetOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct TargetNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// What the machines were asked to spawn.
private final class TargetSpawns: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [SpawnSessionOptions] = []
    var spawned: [SpawnSessionOptions] { lock.withLock { stored } }
    func add(_ options: SpawnSessionOptions) { lock.withLock { stored.append(options) } }
}

/// The computers: a spawn answers with the new session's id at once and its
/// row reaches the store `syncDelay` later, as sync delivers it after the
/// daemon has replied; with none, never.
private struct TargetMachines: HomeOps {
    let store: LocalStore
    let log: TargetSpawns
    let syncDelay: Duration?

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        log.add(options)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: HostedComposeTargetTests.newSessionId, seq: 0, createdAt: now, updatedAt: now,
            active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.home), "host": .string("Mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(options.machineId), "flavor": .string(options.agent ?? "rig"),
                "client": .object(["id": .string("rig")]),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
        guard let delay = syncDelay else { return .success(sessionId: HostedComposeTargetTests.newSessionId) }
        Task.detached { [store] in
            try? await Task.sleep(for: delay)
            try? store.upsertSessions([record])
        }
        return .success(sessionId: HostedComposeTargetTests.newSessionId)
    }
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult { .error(errorMessage: "") }
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult { .error(errorMessage: "") }
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { try! JSONDecoder().decode(MachineOperationResult.self, from: Data(#"{"success":true}"#.utf8)) }
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse { throw URLError(.cannotConnectToHost) }
}

/// The first message accepted by the daemon's session before its row has
/// reached this phone (the outbox needs the row; the daemon doesn't).
private final class TargetAcceptingSender: ChatSending, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(text: String, sessionId: String)] = []
    var sent: [(text: String, sessionId: String)] { lock.withLock { stored } }
    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        lock.withLock { stored.append((message.text, sessionId)) }
        return "accepted-\(stored.count)"
    }
    func retry(localId: String) async throws {}
    func discard(localId: String) async throws {}
}

/// Every session op succeeds; readiness is the daemon's word, before the
/// row has synced (what a lagging home snapshot looks like to the chat).
private struct TargetSessionOps: HomeSessionOps {
    func sessionKill(sessionId: String) async throws -> SessionKillResponse { throw URLError(.cannotConnectToHost) }
    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
    func archive(sessionId: String) async throws {}
    func ensureSessionReady(sessionId: String) async throws {}
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { ("face-ref", bytes.count) }
}

/// The account in the report: the saved draft names an old computer that
/// went offline days ago (Happy CLI only), and Codex on it. Today's
/// computer runs Happy CLI with Happy Agent beside it, and a server runs
/// Happy Agent alone; both make bots and tasks.
///
/// Laid out at the size of the phone it was reported on (an iPhone 14 Pro,
/// 393 × 852) with the software keyboard up, which the other hosted tests
/// never have. With `HAPPY_PREVIEW_DIR` set it writes what each step showed.
@MainActor
final class HostedComposeTargetTests: XCTestCase {
    nonisolated static let newSessionId = "compose-target-new-session"
    nonisolated static let oldMac = SeededAccount.machineId
    nonisolated static let todaysMac = "cli-macbook-pro-7"
    nonisolated static let todaysAgent = "rig-mac"
    nonisolated static let server = "rig-happy-core"

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() {
        LegacyComposeStart.makeStarter = { SessionStarter.make(for: $0) }
        super.tearDown()
    }

    private nonisolated static func rigMetadata(host: String, displayName: String?, sibling: String?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "host": .string(host), "homeDir": .string(SeededAccount.home), "machineKind": .string("rig"),
            "capabilities": .object(["newSession": .bool(true), "bots": .bool(true), "tasks": .bool(true), "worktrees": .bool(false)]),
            "defaults": .object(["providerId": .string("codex"), "modelId": .string("gpt"), "permissionMode": .string("auto")]),
            "models": .array([
                .object(["providerId": .string("codex"), "id": .string("gpt"), "name": .string("GPT 6.1"), "providerName": .string("OpenAI"),
                         "thinkingLevels": .array([.string("medium"), .string("high")]), "defaultThinkingLevel": .string("high")]),
                .object(["providerId": .string("claude"), "id": .string("opus"), "name": .string("Opus"), "providerName": .string("Anthropic"),
                         "thinkingLevels": .array([.string("low"), .string("max")]), "defaultThinkingLevel": .string("low")]),
            ]),
            "operatingModes": .array([
                .object(["code": .string("auto"), "value": .string("Auto")]),
                .object(["code": .string("read_only"), "value": .string("Read only")]),
            ]),
        ]
        if let displayName { fields["displayName"] = .string(displayName) }
        if let sibling { fields["siblingMachineId"] = .string(sibling) }
        return .object(fields)
    }

    private nonisolated static func seed(_ store: LocalStore) throws {
        try SeededAccount.seed(store)
        try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        guard let template = try store.machines().first else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var old = template
        old.active = false
        old.activeAt = now - 3 * 24 * 3_600_000
        old.metadata = .object([
            "host": .string("MacBook-Pro.local"), "platform": .string("darwin"), "happyCliVersion": .string("1.2.4"),
            "homeDir": .string(SeededAccount.home),
        ])
        // Stored afresh: a merge keeps the newer presence it already has.
        try store.replaceMachines([])
        try store.upsertMachine(old)
        var today = template
        today.id = todaysMac
        today.createdAt += 10
        today.metadata = .object([
            "host": .string("MacBook-Pro-7.local"), "platform": .string("darwin"), "happyCliVersion": .string("1.2.6"),
            "homeDir": .string(SeededAccount.home),
        ])
        try store.upsertMachine(today)
        var agent = template
        agent.id = todaysAgent
        agent.createdAt += 11
        agent.metadata = rigMetadata(host: "Mac", displayName: "Mac — Happy Agent", sibling: todaysMac)
        try store.upsertMachine(agent)
        var server = template
        server.id = Self.server
        server.createdAt += 5
        server.metadata = rigMetadata(host: "happy-core", displayName: nil, sibling: nil)
        try store.upsertMachine(server)
    }

    /// The account's computers as the report has them, each as sync
    /// delivers it: the old Mac, today's Mac (Happy CLI), its Happy Agent,
    /// and the server.
    private nonisolated static func reportedMachines() -> (cli: [MachineRecord], agents: [MachineRecord]) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func machine(_ id: String, createdAt: Int64, active: Bool = true, activeAt: Int64 = now, metadata: JSONValue) -> MachineRecord {
            MachineRecord(
                id: id, seq: 1, createdAt: createdAt, updatedAt: createdAt, active: active, activeAt: activeAt,
                metadataVersion: 1, metadataCipher: "harness", metadata: metadata,
                daemonStateVersion: 1, daemonStateCipher: nil, daemonState: .object(["status": .string("running")]),
                dataKeyCipher: nil, decryptable: true
            )
        }
        let base = SeededAccount.base
        let old = machine(oldMac, createdAt: base, active: false, activeAt: now - 3 * 24 * 3_600_000, metadata: .object([
            "host": .string("MacBook-Pro.local"), "platform": .string("darwin"), "happyCliVersion": .string("1.2.4"), "homeDir": .string(SeededAccount.home),
        ]))
        let today = machine(todaysMac, createdAt: base + 10, metadata: .object([
            "host": .string("MacBook-Pro-7.local"), "platform": .string("darwin"), "happyCliVersion": .string("1.2.6"), "homeDir": .string(SeededAccount.home),
        ]))
        let agent = machine(todaysAgent, createdAt: base + 11, metadata: rigMetadata(host: "Mac", displayName: "Mac — Happy Agent", sibling: todaysMac))
        let server = machine(Self.server, createdAt: base + 5, metadata: rigMetadata(host: "happy-core", displayName: nil, sibling: nil))
        return ([old, today], [agent, server])
    }

    private func reportedAccount(syncDelay: Duration? = .zero, log: TargetSpawns, sender: (any ChatSending)? = nil, seed: (@Sendable (LocalStore) throws -> Void)? = nil) async throws -> (LegacyHomeViewController, UINavigationController, UIWindow, AccountSession) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: TargetOffline(), connector: TargetNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 9, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached { [store] in try (seed ?? HostedComposeTargetTests.seed)(store) }.value
        let drafts = NewSessionDraftStore.shared(for: controller.localSettings)
        drafts.setMachineId(Self.oldMac)
        drafts.setPath(SeededAccount.project)
        drafts.pickAgentType(.codex)
        drafts.setInput("")
        LegacyComposeStart.makeStarter = { account in
            SessionStarter(environment: .init(
                ops: TargetMachines(store: account.store, log: log, syncDelay: syncDelay),
                sessionOps: TargetSessionOps(),
                sender: sender ?? account.sender,
                metadataTransport: account.realtime,
                saveInitialModes: { [sender = account.sender] in try await sender.saveInitialModes(sessionId: $0, patch: $1) },
                refreshSessions: {},
                paintBotFace: { Data("png:\($0)".utf8) },
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
        try await until { (seed != nil || home.children.contains { $0 is SessionListViewController }) && home.canCompose }
        return (home, navigation, window, account)
    }

    /// The empty chat, its keyboard up.
    private func emptyChat(_ home: LegacyHomeViewController, _ navigation: UINavigationController) async throws -> (LegacyChatViewController, AgentInputCardView, NewWorkPanel, LegacyComposeStart) {
        home.compose()
        try await until { navigation.transitionCoordinator == nil && navigation.topViewController is LegacyChatViewController }
        let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        try await until { chat.contentInstalled && Self.subview(AgentInputCardView.self, in: chat.view) != nil }
        let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view))
        try await until { card.textView.isFirstResponder }
        let panel = try XCTUnwrap(Self.subview(NewWorkPanel.self, in: chat.view))
        let start = try XCTUnwrap(chat.composeStart)
        try await until { Self.keyboardHeight(chat) > 200 }
        try await Task.sleep(for: .milliseconds(500))
        return (chat, card, panel, start)
    }

    /// Bot on the reported account: the computer moves to an online Happy
    /// Agent, the name and the computer show above the composer with the
    /// keyboard up, a missing name is asked for in place, and the bot is
    /// made there with the text as its first message.
    func testBotPicksAnOnlineHappyAgentAndShowsItsNameAboveTheKeyboard() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, account) = try await reportedAccount(log: log)
        defer { window.isHidden = true }
        XCTAssertEqual(window.bounds.size, CGSize(width: 393, height: 852), "run on an iPhone 14 Pro")
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        keep(window, "target-0-empty-chat-old-offline-mac")
        XCTAssertEqual(start.kinds, [.session, .bot, .task], "Happy Agent on this account makes both")

        panel.kind.selectedSegmentIndex = try XCTUnwrap(panel.sessionKinds.firstIndex(of: .bot))
        panel.kind.sendActions(for: .valueChanged)
        try await until { panel.sessionKind == .bot }
        try await until { start.drafts.draft.selectedMachineId == Self.todaysMac }
        try await Task.sleep(for: .milliseconds(400))
        chat.view.layoutIfNeeded()
        keep(window, "target-1-bot")
        XCTAssertEqual(start.drafts.draft.agentType, .rig)
        XCTAssertEqual(panel.machine.title, "MacBook-Pro-7.local")
        let composerTop = card.convert(CGPoint.zero, to: chat.view).y
        let bar = try XCTUnwrap(navigation.navigationBar.frame.maxY as CGFloat?)
        XCTAssertFalse(panel.isHidden, "the bot's name and computer are on screen")
        for row in [panel.kind, panel.machine, panel.name] as [UIView] {
            XCTAssertFalse(row.isHidden)
            let frame = row.convert(row.bounds, to: chat.view)
            XCTAssertGreaterThan(frame.minY, bar, "\(row) under the bar")
            XCTAssertLessThan(frame.maxY, composerTop, "\(row) over the composer")
        }
        let machines = Self.actions(start.machineMenuElements()).map(\.title)
        XCTAssertEqual(Set(machines), ["MacBook-Pro-7.local", "happy-core"], "only computers whose Happy Agent makes bots")
        let asked = Self.frames(chat.view).filter { $0.contains(":NewWorkPanel") } + ["panel \(panel.convert(panel.bounds, to: chat.view))"]

        card.setText("yo", selection: NSRange(location: 2, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { panel.name.isFirstResponder }
        XCTAssertNil(chat.presentedViewController, "no alert: the name is asked for in place")
        XCTAssertEqual(panel.validation, "Give the bot a name")
        XCTAssertEqual(panel.name.attributedPlaceholder?.string, "Give the bot a name", "said in the field")
        XCTAssertTrue(chat.isComposing)
        XCTAssertEqual(card.text, "yo")
        XCTAssertTrue(log.spawned.isEmpty)
        try await Task.sleep(for: .milliseconds(400))
        chat.view.layoutIfNeeded()
        keep(window, "target-2-bot-needs-name")
        let refused = Self.frames(chat.view).filter { $0.contains(":NewWorkPanel") } + ["panel \(panel.convert(panel.bounds, to: chat.view))"]
        XCTAssertEqual(refused, asked, "asking for the name moved the panel")

        panel.name.text = "Release Captain"
        panel.name.sendActions(for: .editingChanged)
        XCTAssertNil(panel.validation, "typing takes the reason away")
        let composerView = try XCTUnwrap(Self.subview(SessionComposerView.self, in: chat.view))
        try await until { !composerView.sending }
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.todaysAgent])
        XCTAssertEqual(log.spawned.map(\.happyAgentTarget), [.object(["kind": .string("bot"), "name": .string("Release Captain")])])
        let store = account.store
        try await until { (try? store.pendingOutbox().contains { $0.sessionId == Self.newSessionId && $0.kind == .message }) == true }
        let outbox = try await Task.detached { try store.pendingOutbox() }.value
        let first = try XCTUnwrap(outbox.first { $0.sessionId == Self.newSessionId && $0.kind == .message })
        XCTAssertEqual(first.payload["content"]?["text"]?.stringValue, "yo")
    }

    /// A bigger text size and a few lines typed: the composer grows into
    /// the room the bot's panel had. The note gives way; the kind, the
    /// computer and the name stay over the composer, never a blank gap.
    func testABotAtALargerTextSizeKeepsItsNameAndComputer() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, _) = try await reportedAccount(log: log)
        defer { window.isHidden = true }
        window.traitOverrides.preferredContentSizeCategory = .accessibilityLarge
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        panel.kind.selectedSegmentIndex = try XCTUnwrap(panel.sessionKinds.firstIndex(of: .bot))
        panel.kind.sendActions(for: .valueChanged)
        try await until { panel.sessionKind == .bot && start.drafts.draft.agentType == .rig }
        let text = "yo\nplan the release\nand the notes\nand the store listing"
        card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        try await Task.sleep(for: .milliseconds(600))
        chat.view.layoutIfNeeded()
        keep(window, "target-7-bot-larger-text")
        let composerTop = card.convert(CGPoint.zero, to: chat.view).y
        let bar = navigation.navigationBar.frame.maxY
        print("TEXTSIZE panel hidden=\(panel.isHidden) frame=\(panel.frame) bar=\(bar) composerTop=\(composerTop)")
        XCTAssertFalse(panel.isHidden, "the bot's name and computer are on screen")
        for row in [panel.kind, panel.machine, panel.name] as [UIView] {
            let frame = row.convert(row.bounds, to: chat.view)
            XCTAssertGreaterThan(frame.minY, bar, "\(row) under the bar")
            XCTAssertLessThan(frame.maxY, composerTop, "\(row) over the composer")
        }
    }

    /// The machine answers before its session has synced: the chat that
    /// was just made waits for it with its composer, and never says it was
    /// deleted; once the row arrives it is the chat.
    func testAFreshTaskWaitsForItsRowInsteadOfSayingDeleted() async throws {
        let log = TargetSpawns()
        let sender = TargetAcceptingSender()
        let (home, navigation, window, account) = try await reportedAccount(syncDelay: .milliseconds(1_500), log: log, sender: sender)
        defer { window.isHidden = true }
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        panel.kind.selectedSegmentIndex = try XCTUnwrap(panel.sessionKinds.firstIndex(of: .task))
        panel.kind.sendActions(for: .valueChanged)
        try await until { panel.sessionKind == .task && start.drafts.draft.agentType == .rig }
        card.setText("Fix the login redirect", selection: NSRange(location: 22, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertEqual(chat.chatId, Self.newSessionId)
        XCTAssertTrue(chat.isAwaitingRecord, "made, its row not here yet")
        // The row hasn't synced yet: watched frame by frame.
        var sawDeleted = false
        var kept = false
        let deadline = ContinuousClock.now + .milliseconds(1_100)
        while ContinuousClock.now < deadline {
            chat.view.layoutIfNeeded()
            if Self.showsDeleted(chat) { sawDeleted = true }
            if !kept { keep(window, "target-3-fresh-task-before-sync"); kept = true }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertFalse(sawDeleted, "a session just made is not deleted while its row syncs")
        XCTAssertFalse(Self.subview(ChatDockView.self, in: chat.view)?.isHidden ?? true, "the composer stays")
        try await until { !chat.isAwaitingRecord }
        XCTAssertFalse(Self.showsDeleted(chat))
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.todaysAgent])
        XCTAssertEqual(log.spawned.map(\.happyAgentTarget), [.object(["kind": .string("task")])])
        XCTAssertEqual(sender.sent.map(\.text), ["Fix the login redirect"], "the text is the task's first message")
        XCTAssertEqual(sender.sent.map(\.sessionId), [Self.newSessionId])
        try await Task.sleep(for: .milliseconds(400))
        keep(window, "target-4-fresh-task-after-sync")

        // Seen, then gone from the server: that is deleted, as before.
        try await Self.deleteFreshSession(account.store)
        try await until { Self.showsDeleted(chat) }
        keep(window, "target-4b-real-deletion-still-says-deleted")
    }

    /// Sends a task from the empty chat with the record wait shortened,
    /// and returns once the screen is the new session's chat.
    private func sendTask(_ home: LegacyHomeViewController, _ navigation: UINavigationController, recordWait: Duration) async throws -> LegacyChatViewController {
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        chat.recordWait = recordWait
        panel.kind.selectedSegmentIndex = try XCTUnwrap(panel.sessionKinds.firstIndex(of: .task))
        panel.kind.sendActions(for: .valueChanged)
        try await until { panel.sessionKind == .task && start.drafts.draft.agentType == .rig }
        card.setText("Fix the login redirect", selection: NSRange(location: 22, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !chat.isComposing }
        XCTAssertTrue(chat.isAwaitingRecord)
        return chat
    }

    /// A row that hasn't come by the end of the wait is taken for deleted;
    /// when it comes after all, the chat is the session's.
    func testARowLaterThanTheWaitSaysDeletedUntilItComes() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, _) = try await reportedAccount(syncDelay: .milliseconds(2_500), log: log, sender: TargetAcceptingSender())
        defer { window.isHidden = true }
        let chat = try await sendTask(home, navigation, recordWait: .milliseconds(600))
        XCTAssertFalse(Self.showsDeleted(chat), "waiting, not deleted")
        try await until { !chat.isAwaitingRecord }
        try await until { Self.showsDeleted(chat) }
        try await until { !Self.showsDeleted(chat) }
        XCTAssertEqual(chat.chatId, Self.newSessionId)
    }

    /// The session deleted before its row ever reached the phone, which
    /// then never gets it: the chat waits out the wait, never saying
    /// deleted early, then says it.
    func testADeletionBeforeTheRowWasSeenSaysDeletedOnceTheWaitEnds() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, _) = try await reportedAccount(syncDelay: nil, log: log, sender: TargetAcceptingSender())
        defer { window.isHidden = true }
        let chat = try await sendTask(home, navigation, recordWait: .milliseconds(1_200))
        let deadline = ContinuousClock.now + .milliseconds(800)
        while ContinuousClock.now < deadline {
            chat.view.layoutIfNeeded()
            XCTAssertFalse(Self.showsDeleted(chat), "deleted before the wait ended")
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertTrue(chat.isAwaitingRecord)
        try await until { !chat.isAwaitingRecord }
        try await until { Self.showsDeleted(chat) }
    }

    private nonisolated static func deleteFreshSession(_ store: LocalStore) async throws {
        try await Task.detached { try store.deleteSession(id: HostedComposeTargetTests.newSessionId) }.value
    }

    private static func showsDeleted(_ chat: LegacyChatViewController) -> Bool {
        if chat.navigationItem.title == Strings.SessionDetail.sessionDeleted { return true }
        guard let placeholder = subview(ChatPlaceholderView.self, in: chat.view) else { return false }
        return !placeholder.isHidden && placeholder.content == .deleted
    }

    /// The saved draft's computer is offline: its row says so in the label
    /// at its trailing end, in the warning colour; the menu says why at its
    /// head and lists every computer online first; Send says why in full and
    /// keeps the text. Online again, the label changes in place: the row
    /// keeps its height and its name doesn't move.
    func testAnOfflineComputerIsMarkedInPlaceAndExplainedOnSend() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, _) = try await reportedAccount(log: log)
        defer { window.isHidden = true }
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        let row = panel.machine
        try await until { row.statusText?.hasPrefix("● Offline · ") == true }
        chat.view.layoutIfNeeded()
        XCTAssertEqual(row.title, "MacBook-Pro.local")
        XCTAssertEqual(row.statusText, "● Offline · 3d")
        try assertBalanced(row, "offline")
        let offlineFrame = row.frame
        let offlineName = try XCTUnwrap(row.titleLabel).convert(row.titleLabel!.bounds, to: row)
        let label = row.statusFrame
        XCTAssertFalse(offlineName.intersects(label), "the name never runs under the chip")
        XCTAssertFalse(offlineName.width < row.titleLabel!.intrinsicContentSize.width - 1, "the name isn't cut")
        XCTAssertEqual(offlineFrame.height, NewWorkLayout.Metrics.rowHeight, "no row of its own")
        XCTAssertEqual(panel.folder.frame.minY, offlineFrame.maxY + NewWorkLayout.Metrics.rowGap, "nothing between the computer and its folder")
        keep(window, "target-5-offline-in-row")

        let elements = start.machineMenuElements()
        XCTAssertEqual((elements.first as? UIMenu)?.title, "This computer is offline. Start Happy on it or pick another.", "the menu says why at its head")
        let actions = Self.actions(elements)
        XCTAssertEqual(actions.map(\.title), ["MacBook-Pro-7.local", "happy-core", "MacBook-Pro.local"], "online first")
        XCTAssertEqual(actions.map { $0.subtitle ?? "" }.prefix(2), ["online", "online"])
        XCTAssertTrue(actions.last?.subtitle?.hasPrefix("last seen") == true, "\(actions.last?.subtitle ?? "")")

        card.setText("yo", selection: NSRange(location: 2, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { chat.presentedViewController is UIAlertController }
        XCTAssertEqual((chat.presentedViewController as? UIAlertController)?.message, "This computer is offline. Start Happy on it or pick another.")
        try await Task.sleep(for: .milliseconds(400))
        keep(window, "target-5b-offline-send-explains")
        try await until {
            if let alert = chat.presentedViewController, !alert.isBeingPresented { alert.dismiss(animated: false) }
            return chat.presentedViewController == nil
        }
        XCTAssertTrue(chat.isComposing)
        XCTAssertEqual(card.text, "yo", "the text stays")
        XCTAssertTrue(log.spawned.isEmpty, "nothing was asked of an offline computer")

        try XCTUnwrap(actions.first { $0.title == "MacBook-Pro-7.local" }).performWithSender(nil, target: nil)
        try await until { row.title == "MacBook-Pro-7.local" && row.statusText == "● Online" }
        chat.view.layoutIfNeeded()
        XCTAssertEqual(row.frame, offlineFrame, "the row neither moved nor grew")
        let onlineName = try XCTUnwrap(row.titleLabel).convert(row.titleLabel!.bounds, to: row)
        XCTAssertEqual(onlineName.midX, offlineName.midX, accuracy: 0.5, "the name is centred where it was")
        XCTAssertEqual(onlineName.midY, offlineName.midY, accuracy: 0.5)
        XCTAssertEqual(row.statusFrame.maxX, label.maxX, accuracy: 0.5, "the chip ends where it did")
        XCTAssertEqual(row.statusFrame.midY, label.midY, accuracy: 0.5)
        try assertBalanced(row, "online")
        keep(window, "target-6-online-in-row")
    }

    // MARK: Computers arriving late

    /// The panel's own frame in `view` and each of its rows', with whether
    /// it shows: what a person would see move.
    private static func panelFrames(_ panel: NewWorkPanel, in view: UIView) -> [String] {
        ["panel \(panel.convert(panel.bounds, to: view)) hidden=\(panel.isHidden)"]
            + panel.subviews.map { "\(type(of: $0)) \($0.frame) hidden=\($0.isHidden) alpha=\($0.alpha)" }
    }

    /// The computer row is laid out as any row: its icon and name centred
    /// in it, its content as far in from either end, a row's height. Its
    /// status chip, when it has one, is on its top-right corner, clear of
    /// the name, inside the panel and clear of the kind over it.
    private func assertBalanced(_ row: NewWorkMenuRow, _ what: String, file: StaticString = #filePath, line: UInt = #line) throws {
        row.superview?.layoutIfNeeded()
        row.layoutIfNeeded()
        let name = try XCTUnwrap(row.titleLabel, file: file, line: line)
        let icon = try XCTUnwrap(row.imageView, file: file, line: line)
        XCTAssertEqual(name.frame.midY, row.bounds.midY, accuracy: 0.5, "\(what): the name is centred in the row", file: file, line: line)
        XCTAssertEqual(icon.frame.midY, row.bounds.midY, accuracy: 0.5, "\(what): the icon is centred in the row", file: file, line: line)
        let insets = try XCTUnwrap(row.configuration?.contentInsets, file: file, line: line)
        XCTAssertEqual(insets.leading, insets.trailing, "\(what): the content insets are symmetric", file: file, line: line)
        XCTAssertEqual(insets.top, insets.bottom, "\(what)", file: file, line: line)
        XCTAssertEqual(icon.frame.minX, row.bounds.width - name.frame.maxX, accuracy: 1, "\(what): the content is as far in from either end", file: file, line: line)
        XCTAssertEqual(row.bounds.height, NewWorkLayout.Metrics.rowHeight, "\(what): a row's height", file: file, line: line)
        let plain = NewWorkMenuRow(icon: .ionicons("desktop-outline"))
        plain.title = row.title
        plain.frame = row.bounds
        plain.layoutIfNeeded()
        XCTAssertEqual(name.frame.midY, try XCTUnwrap(plain.titleLabel).frame.midY, accuracy: 0.5, "\(what): where a row without a status puts it", file: file, line: line)
        XCTAssertEqual(name.frame.midX, try XCTUnwrap(plain.titleLabel).frame.midX, accuracy: 0.5, "\(what): where a row without a status puts it", file: file, line: line)
        guard row.statusText != nil, let panel = row.superview as? NewWorkPanel else { return }
        let chip = row.statusFrame
        XCTAssertEqual(chip.midY, 0, accuracy: 0.5, "\(what): the chip is on the row's top edge", file: file, line: line)
        XCTAssertEqual(row.bounds.width - chip.maxX, NewWorkStatusLayout.trailing, accuracy: 0.5, "\(what): at the top-right corner", file: file, line: line)
        XCTAssertEqual(chip.height, NewWorkStatusLayout.height, "\(what)", file: file, line: line)
        XCTAssertFalse(chip.intersects(name.frame), "\(what): the chip is clear of the name", file: file, line: line)
        let inPanel = row.convert(chip, to: panel)
        XCTAssertTrue(panel.bounds.contains(inPanel), "\(what): the chip is inside the panel: \(inPanel) in \(panel.bounds)", file: file, line: line)
        if !panel.kind.isHidden {
            XCTAssertFalse(inPanel.intersects(panel.kind.frame), "\(what): the chip is clear of the kind", file: file, line: line)
        }
        let label = try XCTUnwrap(Self.subview(UILabel.self, in: try XCTUnwrap(Self.chipView(row), file: file, line: line)), file: file, line: line)
        XCTAssertLessThanOrEqual(label.intrinsicContentSize.width, label.bounds.width + 0.5, "\(what): the chip's text is whole", file: file, line: line)
        XCTAssertEqual(label.font.pointSize, NewWorkStatusLayout.fontSize, "\(what)", file: file, line: line)
    }

    private static func chipView(_ row: NewWorkMenuRow) -> UIView? {
        row.subviews.first { $0.accessibilityIdentifier == "new-work-machine-status" }
    }

    /// The report: a big account opened, the computers not in yet, and a
    /// Bot picked on an earlier compose. On main the panel showed neither
    /// the name nor the computer and Send said "Give the bot a name" in an
    /// alert. Here the kind, the computer (loading) and the name show at
    /// once; Send asks for the name in place, then says the computers are
    /// loading; as they arrive (the Happy CLI rows first, Happy Agent's
    /// later) nothing in the panel moves, the bot stays a bot, and once a
    /// Happy Agent that makes bots is in it goes there.
    func testABotWhoseComputersArriveLateShowsItsRowsAndGoesWhereItCan() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, account) = try await reportedAccount(log: log, seed: { store in
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        })
        defer { window.isHidden = true }
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        start.drafts.setCreatesBot(true)
        try await until { panel.sessionKind == .bot }
        try await Task.sleep(for: .milliseconds(400))
        chat.view.layoutIfNeeded()
        keep(window, "late-0-loading")
        XCTAssertFalse(start.composer.choices.machinesSynced)
        XCTAssertFalse(panel.isHidden)
        XCTAssertFalse(panel.kind.isHidden)
        XCTAssertFalse(panel.machine.isHidden)
        XCTAssertFalse(panel.name.superview!.isHidden, "the name field shows")
        XCTAssertEqual(panel.machine.title, "Loading computers…")
        XCTAssertEqual(panel.machine.statusText, "● …")
        try assertBalanced(panel.machine, "loading")
        let loading = Self.panelFrames(panel, in: chat.view)
        let loadingName = panel.machine.titleLabel!.frame

        card.setText("yo", selection: NSRange(location: 2, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { panel.name.isFirstResponder }
        XCTAssertNil(chat.presentedViewController, "the name is asked for in place")
        XCTAssertEqual(panel.validation, "Give the bot a name")
        panel.name.text = "Release Captain"
        panel.name.sendActions(for: .editingChanged)
        let composerView = try XCTUnwrap(Self.subview(SessionComposerView.self, in: chat.view))
        try await until { !composerView.sending }
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { chat.presentedViewController is UIAlertController }
        XCTAssertEqual((chat.presentedViewController as? UIAlertController)?.message, "Your computers are still loading. Try again in a moment.")
        try await Task.sleep(for: .milliseconds(400))
        keep(window, "late-1-send-while-loading")
        try await until {
            if let alert = chat.presentedViewController, !alert.isBeingPresented { alert.dismiss(animated: false) }
            return chat.presentedViewController == nil
        }
        XCTAssertEqual(card.text, "yo", "the text stays")
        XCTAssertTrue(log.spawned.isEmpty)
        try await until { !composerView.sending }

        // Happy CLI's rows arrive first, Happy Agent's not yet.
        let (cli, agents) = Self.reportedMachines()
        let store = account.store
        try await Task.detached { for machine in cli { try store.upsertMachine(machine) } }.value
        try await until { start.composer.choices.machines.count == 2 }
        try await Task.sleep(for: .milliseconds(300))
        chat.view.layoutIfNeeded()
        keep(window, "late-2-happy-cli-only")
        XCTAssertTrue(start.drafts.createsBot, "still a bot: Happy Agent may be on its way")
        XCTAssertEqual(panel.machine.title, "Loading computers…")
        XCTAssertEqual(Self.panelFrames(panel, in: chat.view), loading, "a computer arriving moved the panel")

        // Happy Agent's arrive and the list is whole.
        try await Task.detached {
            for machine in agents { try store.upsertMachine(machine) }
            try store.setCursor(.machinesLastSync, 1)
        }.value
        try await until { panel.machine.title == "MacBook-Pro-7.local" && panel.machine.statusText == "● Online" }
        try await Task.sleep(for: .milliseconds(300))
        chat.view.layoutIfNeeded()
        keep(window, "late-3-arrived")
        XCTAssertTrue(start.drafts.createsBot)
        XCTAssertEqual(start.drafts.draft.selectedMachineId, Self.todaysMac, "it went to the Happy Agent that makes bots")
        XCTAssertEqual(start.drafts.draft.agentType, .rig)
        XCTAssertEqual(Self.panelFrames(panel, in: chat.view), loading, "the computers arriving moved the panel")
        try assertBalanced(panel.machine, "arrived")
        XCTAssertEqual(panel.machine.titleLabel!.frame.midX, loadingName.midX, accuracy: 0.5, "the name is centred where the loading text was")
        XCTAssertEqual(panel.machine.titleLabel!.frame.midY, loadingName.midY, accuracy: 0.5)

        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !log.spawned.isEmpty }
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.todaysAgent])
        XCTAssertEqual(log.spawned.map(\.happyAgentTarget), [.object(["kind": .string("bot"), "name": .string("Release Captain")])])
    }

    /// A session on the same account before its computers are in: the
    /// computer (loading), the folder and the harness show at once, with
    /// the kinds, and fill in where they stand.
    func testASessionShowsItsRowsWhileTheComputersArrive() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, account) = try await reportedAccount(log: log, seed: { store in
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        })
        defer { window.isHidden = true }
        let (chat, _, panel, start) = try await emptyChat(home, navigation)
        chat.view.layoutIfNeeded()
        keep(window, "late-session-0-loading")
        XCTAssertEqual(panel.sessionKind, .session)
        XCTAssertEqual([panel.kind, panel.machine, panel.folder, panel.harness].map(\.isHidden), [false, false, false, false])
        XCTAssertEqual(panel.machine.title, "Loading computers…")
        XCTAssertNotEqual(panel.harness.title, Strings.Home.harnessHelp, "not setup help before anything is known")
        XCTAssertEqual(start.enabledKinds, [.session, .bot, .task], "nothing is known yet: every kind can be picked")
        let loading = Self.panelFrames(panel, in: chat.view)

        let (cli, agents) = Self.reportedMachines()
        let store = account.store
        try await Task.detached {
            for machine in cli + agents { try store.upsertMachine(machine) }
            try store.setCursor(.machinesLastSync, 1)
        }.value
        try await until { panel.machine.title == "MacBook-Pro.local" && panel.machine.statusText?.hasPrefix("● Offline") == true }
        try await Task.sleep(for: .milliseconds(300))
        chat.view.layoutIfNeeded()
        keep(window, "late-session-1-arrived")
        XCTAssertEqual(Self.panelFrames(panel, in: chat.view), loading, "the computers arriving moved the panel")
        XCTAssertEqual(panel.harness.title, "Codex")
        try assertBalanced(panel.machine, "session arrived")
    }

    // MARK: Status never moves anything

    /// Every view in `root`, depth first, with its frame in `root`; a text
    /// field's own insides are its text and placeholder, not the panel's
    /// layout, so the field is listed and not entered. The computer's
    /// status chip is laid over the row, as wide as what it says, and is
    /// checked on its own (`assertBalanced`).
    private static func frames(_ root: UIView) -> [String] {
        var out: [String] = []
        func walk(_ view: UIView, _ path: String) {
            for (index, child) in view.subviews.enumerated() where child.accessibilityIdentifier != "new-work-machine-status" {
                let here = "\(path)/\(index):\(type(of: child))"
                out.append("\(here) \(child.convert(child.bounds, to: root)) hidden=\(child.isHidden) alpha=\(child.alpha)")
                if !(child is UITextField) { walk(child, here) }
            }
        }
        walk(root, "")
        return out
    }

    /// The panel alone at an iPhone 14 Pro's width: online, offline and
    /// unknown (no status) lay out every view of the panel, the computer
    /// row's own included, at the same frame, for a session and a bot; and
    /// for the bot, a name refused and then typed moves nothing either.
    func testStatusStatesLeaveEveryFrameOfThePanelAlone() async throws {
        let scene = try await hostedActiveScene()
        let host = UIViewController()
        host.view.backgroundColor = .white
        let window = hostedKeyWindow(in: scene, root: host)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true }
        let panel = NewWorkPanel(mode: .session)
        host.view.addSubview(panel)
        panel.showsMachine = true
        panel.machine.title = "MacBook-Pro-7.local"
        panel.folder.title = "~/happy"
        panel.harness.title = "Codex"
        let states: [(String, (text: String, color: UIColor)?)] = [
            ("online", ("● Online", UIColor(Palette.sessionStatusOnline))),
            ("offline", ("● Offline · 2h", UIColor(Palette.warningText))),
            ("unknown", nil),
            ("agent-offline", ("● Agent offline", UIColor(Palette.warningText))),
            ("loading", ("● …", UIColor(Palette.textSecondary))),
        ]
        var chipAnchor: (maxX: CGFloat, midY: CGFloat)?
        for kind in [HomeDockKind.session, .bot] {
            panel.setSessionKinds([.session, .bot, .task], current: kind, botName: "")
            var reference: [String]?
            for (name, status) in states {
                panel.machine.status = status
                panel.place(panel.layout(width: 393, top: 160, bottom: 600))
                window.layoutIfNeeded()
                let frames = Self.frames(panel) + ["panel \(panel.frame)"]
                XCTAssertEqual(panel.machine.statusText, status?.text)
                XCTAssertEqual(Self.chipView(panel.machine)?.isHidden, status == nil, "\(name): a chip only with a status")
                try assertBalanced(panel.machine, "\(kind) \(name)")
                if status != nil {
                    let chip = panel.machine.statusFrame
                    if let chipAnchor {
                        XCTAssertEqual(chip.maxX, chipAnchor.maxX, accuracy: 0.5, "\(kind) \(name): the chip's corner moved")
                        XCTAssertEqual(chip.midY, chipAnchor.midY, accuracy: 0.5, "\(kind) \(name): the chip's corner moved")
                    } else {
                        chipAnchor = (chip.maxX, chip.midY)
                    }
                }
                if let reference {
                    XCTAssertEqual(frames, reference, "\(kind) \(name): a view moved")
                } else {
                    reference = frames
                }
                keep(window, "target-8-row-\(kind)-\(name)")
            }
            if kind == .session {
                // A computer's name too long for the row: cut in the middle,
                // under the chip's line, never under the chip.
                panel.machine.title = "Kirills-MacBook-Pro-with-a-very-long-hostname.local"
                panel.machine.status = states[1].1
                panel.place(panel.layout(width: 393, top: 160, bottom: 600))
                window.layoutIfNeeded()
                try assertBalanced(panel.machine, "long name")
                keep(window, "target-8-row-session-long-name")
                panel.machine.title = "MacBook-Pro-7.local"
            }
            guard kind == .bot else { continue }
            // The name refused, every status over it, then typed.
            let names: [(String, String, String?)] = [
                ("refused", "", "Give the bot a name"),
                ("named", "Release Captain", nil),
            ]
            for (name, typed, validation) in names {
                for (statusName, status) in states {
                    panel.name.text = typed
                    panel.validation = validation
                    panel.machine.status = status
                    panel.place(panel.layout(width: 393, top: 160, bottom: 600))
                    window.layoutIfNeeded()
                    let frames = Self.frames(panel) + ["panel \(panel.frame)"]
                    XCTAssertEqual(frames, reference, "bot \(name) \(statusName): a view moved")
                    XCTAssertEqual(panel.name.attributedPlaceholder?.string, validation ?? "Name your bot")
                }
                keep(window, "target-8-row-bot-name-\(name)")
            }
        }
    }

    /// Live, on the reported account: today's computer goes offline and
    /// comes back while the empty chat is open, keyboard up. Only the
    /// label's text and colour change; every frame in the panel and the
    /// composer stays where it was.
    func testALiveOnlineOfflineFlipMovesNothing() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, account) = try await reportedAccount(log: log)
        defer { window.isHidden = true }
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        try XCTUnwrap(Self.actions(start.machineMenuElements()).first { $0.title == "MacBook-Pro-7.local" }).performWithSender(nil, target: nil)
        try await until { panel.machine.title == "MacBook-Pro-7.local" && panel.machine.statusText == "● Online" }
        try await Task.sleep(for: .milliseconds(300))
        func snapshot() -> [String] {
            chat.view.layoutIfNeeded()
            return Self.frames(panel) + ["panel \(panel.frame)", "card \(card.convert(card.bounds, to: chat.view))"]
        }
        let online = snapshot()
        keep(window, "target-9-live-online")

        try await Self.setPresence(account.store, active: false)
        try await until { panel.machine.statusText?.hasPrefix("● Offline · ") == true }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(snapshot(), online, "going offline moved something")
        keep(window, "target-9-live-offline")

        try await Self.setPresence(account.store, active: true)
        try await until { panel.machine.statusText == "● Online" }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(snapshot(), online, "coming back moved something")
        keep(window, "target-9-live-online-again")
    }

    /// Every Happy Agent offline when Task is picked (presence from before,
    /// live presence not in yet): the task goes to today's computer, whose
    /// Happy Agent is offline. The server's comes online and the task moves
    /// there; the row's name and chip change, and nothing in the panel or
    /// the composer moves.
    func testATaskPickedWithEveryHappyAgentOfflineMovesWhenOneComesOnline() async throws {
        let log = TargetSpawns()
        let (home, navigation, window, account) = try await reportedAccount(log: log)
        defer { window.isHidden = true }
        try await Self.setPresence(account.store, active: false, ids: [Self.todaysAgent, Self.server])
        let (chat, card, panel, start) = try await emptyChat(home, navigation)
        panel.kind.selectedSegmentIndex = try XCTUnwrap(panel.sessionKinds.firstIndex(of: .task))
        panel.kind.sendActions(for: .valueChanged)
        try await until { panel.sessionKind == .task && start.drafts.draft.selectedMachineId == Self.todaysMac }
        try await until { start.composer.choices.offline == .happyAgent && panel.machine.title == "MacBook-Pro-7.local" }
        try await Task.sleep(for: .milliseconds(300))
        func frames() -> [String] {
            chat.view.layoutIfNeeded()
            return Self.panelFrames(panel, in: chat.view) + ["card \(card.convert(card.bounds, to: chat.view))"]
        }
        let before = frames()
        keep(window, "target-10-task-every-agent-offline")

        try await Self.setPresence(account.store, active: true, ids: [Self.server])
        try await until { start.drafts.draft.selectedMachineId == Self.server && panel.machine.title == "happy-core" && panel.machine.statusText == "● Online" }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(start.drafts.createsTask)
        XCTAssertEqual(frames(), before, "moving to the Happy Agent that came online moved the panel")
        try assertBalanced(panel.machine, "moved")
        keep(window, "target-10-task-moved-to-online-agent")

        card.setText("Ship it", selection: NSRange(location: 7, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { !log.spawned.isEmpty }
        XCTAssertEqual(log.spawned.map(\.machineId), [Self.server])
    }

    /// Daemons on the reported account, today's computer's by default, as
    /// presence would leave them.
    private nonisolated static func setPresence(_ store: LocalStore, active: Bool, ids: [String] = [todaysMac, todaysAgent]) async throws {
        try await Task.detached {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            for id in ids {
                _ = try store.applyMachineUpdate(id: id, metadata: nil, daemonState: nil, active: active,
                                                 activeAt: now)
            }
        }.value
    }

    // MARK: Helpers

    private static func keyboardHeight(_ chat: UIViewController) -> CGFloat {
        chat.view.keyboardLayoutGuide.layoutFrame.height
    }

    private static func actions(_ elements: [UIMenuElement]) -> [UIAction] {
        elements.flatMap { element -> [UIAction] in
            if let action = element as? UIAction { return [action] }
            if let menu = element as? UIMenu { return actions(menu.children) }
            return []
        }
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "timed out", file: file, line: line)
    }

    private func keep(_ window: UIWindow, _ name: String) {
        // The keyboard is its own window: the screen is drawn whole.
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            for shown in (window.windowScene?.windows ?? [window]) where !shown.isHidden {
                _ = shown.drawHierarchy(in: shown.frame, afterScreenUpdates: true)
            }
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
