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
/// daemon has replied.
private struct TargetMachines: HomeOps {
    let store: LocalStore
    let log: TargetSpawns
    let syncDelay: Duration

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
        let delay = syncDelay
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

    private func reportedAccount(syncDelay: Duration = .zero, log: TargetSpawns, sender: (any ChatSending)? = nil) async throws -> (LegacyHomeViewController, UINavigationController, UIWindow, AccountSession) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: TargetOffline(), connector: TargetNoSocket()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 9, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached { [store] in try HostedComposeTargetTests.seed(store) }.value
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
        try await until { home.children.contains { $0 is SessionListViewController } && home.canCompose }
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

        card.setText("yo", selection: NSRange(location: 2, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        card.delegate?.agentInputCardDidPressSend(card)
        try await until { panel.name.isFirstResponder }
        XCTAssertNil(chat.presentedViewController, "no alert: the name is asked for in place")
        XCTAssertEqual(panel.validation, "Give the bot a name")
        XCTAssertTrue(chat.isComposing)
        XCTAssertEqual(card.text, "yo")
        XCTAssertTrue(log.spawned.isEmpty)
        try await Task.sleep(for: .milliseconds(400))
        keep(window, "target-2-bot-needs-name")

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
        XCTAssertEqual(row.statusText, "● Offline · 3d ago")
        let offlineFrame = row.frame
        let offlineName = try XCTUnwrap(row.titleLabel).convert(row.titleLabel!.bounds, to: row)
        let label = row.statusFrame
        XCTAssertEqual(label.maxX, row.bounds.width - NewWorkStatusLayout.inset, accuracy: 0.5, "at the row's trailing end")
        XCTAssertEqual(label, NewWorkStatusLayout.label(rowWidth: row.bounds.width), "pinned top-right")
        XCTAssertFalse(offlineName.intersects(label), "the name never runs under the label")
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
        XCTAssertEqual(onlineName.minX, offlineName.minX, accuracy: 0.5, "the name starts where it did")
        XCTAssertEqual(row.statusFrame.maxX, label.maxX, accuracy: 0.5, "the label ends where it did")
        keep(window, "target-6-online-in-row")
    }

    // MARK: Status never moves anything

    /// Every view in `root`, depth first, with its frame in `root`.
    private static func frames(_ root: UIView) -> [String] {
        var out: [String] = []
        func walk(_ view: UIView, _ path: String) {
            for (index, child) in view.subviews.enumerated() {
                let here = "\(path)/\(index):\(type(of: child))"
                out.append("\(here) \(child.convert(child.bounds, to: root)) hidden=\(child.isHidden) alpha=\(child.alpha)")
                walk(child, here)
            }
        }
        walk(root, "")
        return out
    }

    /// The panel alone at an iPhone 14 Pro's width: online, offline and
    /// unknown (no status) lay out every view of the panel, the computer
    /// row's own included, at the same frame, for a session and a bot.
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
            ("offline", ("● Offline · 2h ago", UIColor(Palette.warningText))),
            ("unknown", nil),
            ("agent-offline", ("● Happy Agent offline", UIColor(Palette.warningText))),
        ]
        for kind in [HomeDockKind.session, .bot] {
            panel.setSessionKinds([.session, .bot, .task], current: kind, botName: "")
            var reference: [String]?
            for (name, status) in states {
                panel.machine.status = status
                panel.place(panel.layout(width: 393, top: 160, bottom: 600))
                window.layoutIfNeeded()
                let frames = Self.frames(panel) + ["panel \(panel.frame)"]
                XCTAssertEqual(panel.machine.statusText, status?.text)
                if let reference {
                    XCTAssertEqual(frames, reference, "\(kind) \(name): a view moved")
                } else {
                    reference = frames
                }
                keep(window, "target-8-row-\(kind)-\(name)")
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

    /// Today's computer, both its daemons, as presence would leave them.
    private nonisolated static func setPresence(_ store: LocalStore, active: Bool) async throws {
        try await Task.detached {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            for id in [todaysMac, todaysAgent] {
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
