#if canImport(UIKit)
import Foundation
import HappyCore
import HappyCrypto
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// The account's server for a first send with a picture: an upload is given
/// a place, its bytes wait at the PUT until the test lets them go, and each
/// message posted is acknowledged. Everything else is offline.
private final class ComposeUploadServer: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _held = true
    private var _uploads = 0
    private var _posted: [String] = []
    private var seq = 0

    func release() { lock.withLock { _held = false } }
    /// Blobs written.
    var uploads: Int { lock.withLock { _uploads } }
    /// The localIds posted, in order.
    var posted: [String] { lock.withLock { _posted } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let path = request.url.path
        if request.method == "POST", path.hasSuffix("/attachments/request-upload") {
            return HTTPResponse(status: 200, body: Data(#"{"ref":"compose-blob","uploadUrl":"https://uploads.example.test/blob","method":"PUT"}"#.utf8))
        }
        if request.method == "POST", path.hasSuffix("/messages"), let body = request.body {
            let messages = try JSONDecoder().decode(SendMessagesRequest.self, from: body).messages
            let acknowledged = lock.withLock { () -> [JSONValue] in
                messages.map { message in
                    _posted.append(message.localId)
                    seq += 1
                    return .object([
                        "id": .string("posted-\(seq)"), "seq": .number(Double(seq)), "localId": .string(message.localId),
                        "createdAt": .number(1_792_141_200_000), "updatedAt": .number(1_792_141_200_000),
                    ])
                }
            }
            return HTTPResponse(status: 200, body: try JSONEncoder().encode(JSONValue.object(["messages": .array(acknowledged)])))
        }
        throw URLError(.notConnectedToInternet)
    }

    func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse {
        guard request.method == "PUT", request.url.path == "/blob" else { return try await send(request) }
        while lock.withLock({ _held }) { try await Task.sleep(for: .milliseconds(5)) }
        let total = Int64(request.body?.count ?? 0)
        progress(total, total)
        lock.withLock { _uploads += 1 }
        return HTTPResponse(status: 200, body: Data())
    }
}

private struct ComposeAttachNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// The machine: refuses while told to; otherwise a spawn writes the new
/// session's row, with a data key the account holds so its outbox seals,
/// and answers with its id.
private final class ComposeAttachMachine: HomeOps, @unchecked Sendable {
    private let lock = NSLock()
    private var _refuses: Bool
    private var _spawns = 0
    let store: LocalStore
    let dataKey: String

    init(store: LocalStore, dataKey: String, refuses: Bool) {
        self.store = store
        self.dataKey = dataKey
        _refuses = refuses
    }

    func refuse(_ value: Bool) { lock.withLock { _refuses = value } }
    var spawns: Int { lock.withLock { _spawns } }

    func machineSpawnNewSession(options: SpawnSessionOptions) async -> SpawnSessionResult {
        let refuses = lock.withLock { _spawns += 1; return _refuses }
        if refuses { return .error(errorMessage: "The machine said no") }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: HostedComposeAttachTests.newSessionId, seq: 0, createdAt: now, updatedAt: now,
            active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": .string(options.agent ?? "claude"), "version": .string("1.2.6"),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: dataKey, decryptable: true
        )
        try? await Task.detached { [store] in try store.upsertSessions([record]) }.value
        return .success(sessionId: HostedComposeAttachTests.newSessionId)
    }
    func machineResumeSession(machineId: String, sessionId: String, model: String?, permissionMode: String?) async -> SpawnSessionResult { .error(errorMessage: "") }
    func forkAndSpawn(source: ForkSource, options: ForkOptions) async -> SpawnSessionResult { .error(errorMessage: "") }
    func machineStopSession(machineId: String, sessionId: String) async -> MachineOperationResult { try! JSONDecoder().decode(MachineOperationResult.self, from: Data(#"{"success":true}"#.utf8)) }
    func machineBash(machineId: String, command: String, cwd: String) async throws -> SessionBashResponse { throw URLError(.cannotConnectToHost) }
}

private struct ComposeAttachSessionOps: HomeSessionOps {
    func sessionKill(sessionId: String) async throws -> SessionKillResponse { throw URLError(.cannotConnectToHost) }
    func sessionSetAgentModes(sessionId: String, patch: SessionAgentModesPatch, transport: any MetadataUpdateTransport) async throws {}
    func sessionSetAvatar(sessionId: String, picture: SessionAvatarPicture) async throws {}
    func archive(sessionId: String) async throws {}
    func ensureSessionReady(sessionId: String) async throws {}
    func uploadSessionBlob(sessionId: String, name: String, bytes: Data) async throws -> (ref: String, size: Int) { throw URLError(.cannotConnectToHost) }
}

/// The empty Happy CLI chat compose opens, before it has a session: "+"
/// is there, and a photo picked in the attach menu goes with the first
/// send. The send makes the session, then the photo is the new session's
/// own outbox item ahead of the text, uploaded to it and posted in order.
/// A start that fails keeps the photo (and the text) in the composer, and
/// the next send takes it.
@MainActor
final class HostedComposeAttachTests: XCTestCase {
    nonisolated static let newSessionId = "compose-attach-session"
    private var window: UIWindow?
    private var controller: AccountController!
    private var account: AccountSession!
    private var server: ComposeUploadServer!
    private var machine: ComposeAttachMachine!
    private var navigation: UINavigationController!
    private var chat: LegacyChatViewController!
    private var card: AgentInputCardView!

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() async throws {
        LegacyComposeStart.makeStarter = { SessionStarter.make(for: $0) }
        AttachMenuEnvironment.library = { PhotoKitAttachLibrary() }
        AttachMenuEnvironment.camera = { UIImagePickerController.isSourceTypeAvailable(.camera) }
        window?.isHidden = true
        window = nil
        await controller?.signOut()
        try await super.tearDown()
    }

    /// Signed in on the seeded computer, home open and compose pressed:
    /// the empty chat, its keyboard up.
    private func compose(refuses: Bool = false) async throws {
        AttachMenuEnvironment.library = { FixtureAttachLibrary(access: .authorized, count: 30) }
        AttachMenuEnvironment.camera = { true }
        let server = ComposeUploadServer()
        self.server = server
        controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: server, connector: ComposeAttachNoSocket()
        )
        let secret = Data(repeating: 5, count: 32)
        try await controller.signIn(Credentials(token: "t", secret: secret))
        account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
        }.value
        let drafts = NewSessionDraftStore.shared(for: controller.localSettings)
        drafts.setMachineId(SeededAccount.machineId)
        drafts.setPath(SeededAccount.project)
        drafts.setInput("")
        let machine = ComposeAttachMachine(
            store: store,
            dataKey: Base64.encode(try AccountKeys(secret: secret).wrapDataKey(Data(repeating: 9, count: 32))),
            refuses: refuses
        )
        self.machine = machine
        LegacyComposeStart.makeStarter = { account in
            SessionStarter(environment: .init(
                ops: machine,
                sessionOps: ComposeAttachSessionOps(),
                sender: account.sender,
                metadataTransport: account.realtime,
                saveInitialModes: { [sender = account.sender] in try await sender.saveInitialModes(sessionId: $0, patch: $1) },
                refreshSessions: {},
                attachmentPlan: { [sender = account.sender] message, sessionId in try await sender.attachmentPlan(for: message, sessionId: sessionId) },
                spawnRequests: account.spawnRequests
            ))
        }
        let context = AppContext(account: controller, variant: .development, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        window.overrideUserInterfaceStyle = .light
        self.window = window
        try await wait { home.children.contains { $0 is SessionListViewController } && home.canCompose }
        home.compose()
        try await wait { self.navigation.topViewController is LegacyChatViewController && self.navigation.transitionCoordinator == nil }
        chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        XCTAssertTrue(chat.isComposing)
        try await wait { self.chat.contentInstalled && self.cardIfShown() != nil }
        card = try XCTUnwrap(cardIfShown())
        try await wait { self.card.textView.isFirstResponder }
    }

    private func cardIfShown() -> AgentInputCardView? {
        views(chat.view).compactMap { $0 as? AgentInputCardView }.first { $0.window != nil }
    }

    private func view(_ id: String, in root: UIView) -> UIView? {
        views(root).first { $0.accessibilityIdentifier == id && !$0.isHidden && $0.alpha > 0.01 && $0.window != nil }
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func wait(_ seconds: Double = 10, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "never reached the expected state", file: file, line: line)
    }

    /// The "+", as a finger presses it; a photo picked in the menu's grid,
    /// confirmed into the composer and sent with the composer's send.
    private func sendPhotoFromTheMenu() async throws {
        let plus = try XCTUnwrap(card.addControl as? UIControl, "the + is no control")
        XCTAssertFalse(plus.isHidden, "the empty chat hides its +")
        plus.sendActions(for: .touchUpInside)
        try await wait { self.navigation.presentedViewController is AttachSheetViewController }
        let sheet = try XCTUnwrap(navigation.presentedViewController as? AttachSheetViewController)
        try await Task.sleep(for: .milliseconds(600))
        sheet.view.layoutIfNeeded()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 2 }
        try XCTUnwrap(grid.cellForItem(at: IndexPath(item: 0, section: 0)) as? AttachGridCell).check.sendActions(for: .touchUpInside)
        XCTAssertEqual(sheet.picked, ["fixture-0"])
        try await Task.sleep(for: .milliseconds(400))
        try XCTUnwrap(view("attach-confirm", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)
        try await wait(15) { self.navigation.presentedViewController == nil && self.card.configuration.attachments.count == 1 && !self.card.configuration.attachments.contains(where: \.preparing) }
        card.delegate?.agentInputCardDidPressSend(card)
    }

    /// The new session's outbox, read off the main thread.
    private func outbox() async throws -> [OutboxRecord] {
        let store = account.store
        return try await Task.detached { try store.pendingOutbox(limit: Int.max) }.value
            .filter { $0.sessionId == Self.newSessionId }
    }

    /// The first send's photo and text in the new session's outbox, the
    /// photo first and the text waiting on it: the outbox's own copy of
    /// the picture, so it is sent after a relaunch too. Then the server
    /// takes the bytes and both are posted in order.
    private func assertTheFirstSendCarriesThePhoto(_ text: String) async throws {
        var items: [OutboxRecord] = []
        let deadline = ContinuousClock.now + .seconds(15)
        while items.count < 2, ContinuousClock.now < deadline {
            items = try await outbox()
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(items.map(\.kind), [.file, .message])
        let file = try XCTUnwrap(items.first { $0.kind == .file }, "no picture in the new session's outbox")
        let message = try XCTUnwrap(items.first { $0.kind == .message }, "no text in the new session's outbox")
        XCTAssertEqual(message.dependsOn, file.localId)
        XCTAssertEqual(message.payload["content"]?["text"]?.stringValue, text)
        let store = account.store
        let picture = try await Task.detached { try store.attachment(outboxLocalId: file.localId) }.value
        XCTAssertEqual(picture?.mimeType, "image/jpeg")
        XCTAssertEqual(picture?.sessionId, Self.newSessionId)
        let copy = try XCTUnwrap(picture).path
        XCTAssertTrue(FileManager.default.fileExists(atPath: account.filesDirectory.appendingPathComponent(copy).path), "the outbox kept no copy")
        // The composer holds nothing: the photo went with the send.
        try await wait { self.card.text.isEmpty && self.card.configuration.attachments.isEmpty }

        server.release()
        try await wait(15) { self.server.posted == [file.localId, message.localId] }
        XCTAssertEqual(server.uploads, 1)
        let left = try await outbox()
        XCTAssertTrue(left.isEmpty)
    }

    func testThePlusShowsInTheEmptyChatAndThePhotoGoesWithTheFirstSend() async throws {
        try await compose()
        try await wait { self.card.configuration.showsAdd }
        card.setText("What's wrong with this screen?", selection: NSRange(location: 30, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        try await sendPhotoFromTheMenu()

        // The send made the session, and the screen is its chat.
        try await wait { !self.chat.isComposing }
        XCTAssertEqual(chat.chatId, Self.newSessionId)
        XCTAssertEqual(machine.spawns, 1)
        try await assertTheFirstSendCarriesThePhoto("What's wrong with this screen?")
    }

    func testAFailedStartKeepsThePhotoAndTheNextSendTakesIt() async throws {
        try await compose(refuses: true)
        try await wait { self.card.configuration.showsAdd }
        card.setText("Try with the picture", selection: NSRange(location: 20, length: 0))
        card.delegate?.agentInputCardDidChangeText(card)
        try await sendPhotoFromTheMenu()

        // Refused: said so, still the empty chat, the photo and the text
        // still in the composer, nothing in any outbox.
        try await wait { self.navigation.presentedViewController is UIAlertController }
        try await wait {
            if let alert = self.navigation.presentedViewController, !alert.isBeingPresented { alert.dismiss(animated: false) }
            return self.navigation.presentedViewController == nil
        }
        XCTAssertTrue(chat.isComposing)
        XCTAssertEqual(machine.spawns, 1)
        XCTAssertEqual(card.text, "Try with the picture")
        XCTAssertEqual(card.configuration.attachments.count, 1, "the picked photo went with the refusal")
        XCTAssertTrue(card.configuration.showsAdd)
        let store = account.store
        let queued = try await Task.detached { try store.pendingOutbox(limit: Int.max) }.value
        XCTAssertTrue(queued.isEmpty)

        // Sent again, the machine answers: the same photo goes.
        machine.refuse(false)
        card.delegate?.agentInputCardDidPressSend(card)
        try await wait { !self.chat.isComposing }
        XCTAssertEqual(machine.spawns, 2)
        XCTAssertEqual(chat.chatId, Self.newSessionId)
        try await assertTheFirstSendCarriesThePhoto("Try with the picture")
    }
}
#endif
