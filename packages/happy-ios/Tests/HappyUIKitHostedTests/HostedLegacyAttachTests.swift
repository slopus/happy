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

/// The account's server, as far as a legacy chat's send goes: it gives an
/// upload a place, takes the blob's bytes a quarter at a time as the test
/// lets them go (or refuses them), and acknowledges each message posted.
/// Everything else is offline.
private final class LegacyUploadServer: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _allowed = 0
    private var _written = 0
    private var _refuses = false
    private var _posted: [String] = []
    private var seq = 0

    /// Quarters of the blob the server may take now.
    func allow(_ quarters: Int) { lock.withLock { _allowed = quarters } }
    var written: Int { lock.withLock { _written } }
    /// The next blob is refused after its first quarter.
    func refuse(_ value: Bool) { lock.withLock { _refuses = value } }
    /// The localIds posted, in order.
    var posted: [String] { lock.withLock { _posted } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let path = request.url.path
        if request.method == "POST", path.hasSuffix("/attachments/request-upload") {
            return HTTPResponse(status: 200, body: Data(#"{"ref":"legacy-blob","uploadUrl":"https://uploads.example.test/blob","method":"PUT"}"#.utf8))
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

    /// The blob: each quarter as it is let go, told to `progress`.
    func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse {
        guard request.method == "PUT", request.url.path == "/blob" else { return try await send(request) }
        let total = Int64(request.body?.count ?? 0)
        for quarter in 1...4 {
            while lock.withLock({ _allowed < quarter }) { try await Task.sleep(for: .milliseconds(5)) }
            lock.withLock { _written = quarter }
            progress(total * Int64(quarter) / 4, total)
            if lock.withLock({ _refuses }) {
                lock.withLock { _refuses = false }
                return HTTPResponse(status: 413, body: Data("too big".utf8))
            }
        }
        return HTTPResponse(status: 200, body: Data())
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// The legacy chat's "+" is the agent chat's: Telegram's attach menu, the
/// keyboard down under it and back after, the draft untouched, a photo
/// picked in its grid sent with the draft as its caption. Sent, the picture is its
/// own item in the outbox: its bubble is this device's copy, dimmed under
/// the ring the bytes written fill, a quarter at a time, one apply each;
/// its cross takes out the picture alone and the text still goes; a
/// refused upload shows the retry arrow, which sends it again.
///
/// With `HAPPY_PREVIEW_DIR` set, the menu and a ring half way are kept
/// there, light and dark (`HAPPY_SCREEN_WATCH`: by the simulator's own
/// screenshot, taken from outside).
@MainActor
final class HostedLegacyAttachTests: XCTestCase {
    private static let sessionId = "legacy-attach"
    private var window: UIWindow?
    private var controller: AccountController!
    private var account: AccountSession!
    private var server: LegacyUploadServer!
    private var navigation: UINavigationController!
    private var chat: LegacyChatViewController!
    private var card: AgentInputCardView!

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() async throws {
        AttachMenuEnvironment.library = { PhotoKitAttachLibrary() }
        AttachMenuEnvironment.camera = { UIImagePickerController.isSourceTypeAvailable(.camera) }
        window?.isHidden = true
        window = nil
        await controller?.signOut()
        try await super.tearDown()
    }

    /// Signed in, the chat open on a Claude session whose key this account
    /// holds, so its outbox really seals and sends.
    private func open() async throws {
        AttachMenuEnvironment.library = { FixtureAttachLibrary(access: .authorized, count: 30) }
        AttachMenuEnvironment.camera = { true }
        let server = LegacyUploadServer()
        self.server = server
        controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: server, connector: NoSockets()
        )
        let secret = Data(repeating: 5, count: 32)
        try await controller.signIn(Credentials(token: "t", secret: secret))
        account = try XCTUnwrap(controller.session)
        let wrapped = Base64.encode(try AccountKeys(secret: secret).wrapDataKey(Data(repeating: 9, count: 32)))
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let record = SessionRecord(
            id: Self.sessionId, seq: 0, createdAt: now, updatedAt: now, active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": .string("claude"),
                "summary": .object(["text": .string("Attach a picture"), "updatedAt": .number(Double(now))]),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: wrapped, decryptable: true
        )
        let store = account.store
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.upsertSessions([record])
        }.value
        let context = AppContext(account: controller, variant: .development, version: "test")
        chat = LegacyChatViewController(context: context, session: account, sessionId: Self.sessionId)
        navigation = UINavigationController(rootViewController: chat)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        self.window = window
        try await wait { self.chat.contentInstalled && self.cardIfShown() != nil }
        card = try XCTUnwrap(cardIfShown())
        try await wait { self.card.configuration.showsAdd }
    }

    private func cardIfShown() -> AgentInputCardView? {
        views(chat.view).compactMap { $0 as? AgentInputCardView }.first { $0.window != nil }
    }

    private var presented: UIViewController? { navigation.presentedViewController }

    /// The "+", as a finger presses it, and the menu up and settled.
    private func menu() async throws -> AttachSheetViewController {
        let plus = try XCTUnwrap(card.addControl as? UIControl, "the + is no control")
        plus.sendActions(for: .touchUpInside)
        try await wait { self.presented is AttachSheetViewController }
        let sheet = try XCTUnwrap(presented as? AttachSheetViewController)
        try await Task.sleep(for: .milliseconds(600))
        sheet.view.layoutIfNeeded()
        return sheet
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

    /// The screen, light and dark, into `HAPPY_PREVIEW_DIR`, as
    /// `HostedAttachMenuTests.keep` does.
    private func keep(_ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"], let window else { return }
        let watched = ProcessInfo.processInfo.environment["HAPPY_SCREEN_WATCH"] != nil
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(watched ? 600 : 250))
            window.layoutIfNeeded()
            let file = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(style == .dark ? "dark" : "light").png")
            if watched {
                try? FileManager.default.removeItem(at: file)
                try Data().write(to: file.deletingPathExtension().appendingPathExtension("request"))
                let deadline = ContinuousClock.now + .seconds(10)
                while !FileManager.default.fileExists(atPath: file.path), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(100)) }
                try await Task.sleep(for: .milliseconds(300))
            } else {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                try image.pngData()?.write(to: file)
            }
        }
        window.overrideUserInterfaceStyle = .unspecified
    }

    /// The outbox's items, read off the main thread.
    private func outbox() async throws -> [OutboxRecord] {
        let store = account.store
        return try await Task.detached { try store.pendingOutbox(limit: Int.max) }.value
    }

    /// The first photo picked in the menu's grid.
    private func pick(in sheet: AttachSheetViewController) async throws {
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 2 }
        try XCTUnwrap(grid.cellForItem(at: IndexPath(item: 0, section: 0)) as? AttachGridCell).check.sendActions(for: .touchUpInside)
        XCTAssertEqual(sheet.picked, ["fixture-0"])
        try await Task.sleep(for: .milliseconds(400))
    }

    /// The text a message in the outbox carries.
    private func text(_ item: OutboxRecord) -> String? { item.payload["content"]?["text"]?.stringValue }

    /// A photo sent from the menu with `text` as its caption: the
    /// picture's own outbox item, its ring's tile in the bubble, and the
    /// text's localId.
    private func sendPhoto(_ text: String) async throws -> (file: String, text: String, tile: ChatAttachmentView) {
        card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0))
        let sheet = try await menu()
        try await pick(in: sheet)
        try XCTUnwrap(view("attach-send", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)
        var items: [OutboxRecord] = []
        let deadline = ContinuousClock.now + .seconds(15)
        while items.count < 2, ContinuousClock.now < deadline {
            items = try await outbox()
            try await Task.sleep(for: .milliseconds(20))
        }
        let file = try XCTUnwrap(items.first { $0.kind == .file }, "no picture in the outbox")
        let message = try XCTUnwrap(items.first { $0.kind == .message }, "no text in the outbox")
        XCTAssertEqual(message.dependsOn, file.localId)
        XCTAssertEqual(self.text(message), text)
        try await wait { self.tile() != nil }
        return (file.localId, message.localId, try XCTUnwrap(tile()))
    }

    private func tile() -> ChatAttachmentView? {
        views(chat.view).compactMap { $0 as? ChatAttachmentView }.first { $0.window != nil && $0.ring != nil && !($0.ring?.isHidden ?? true) }
    }

    /// What a tap on `tile`'s ring does, by the row's own hits.
    private func ringAction(_ tile: ChatAttachmentView) throws -> (ChatRowAction?, ChatPlanView) {
        var current = tile.superview
        while let view = current, !(view is ChatPlanView) { current = view.superview }
        let plan = try XCTUnwrap(current as? ChatPlanView, "the tile is in no row")
        let ring = try XCTUnwrap(tile.ring)
        return (plan.action(at: ring.convert(CGPoint(x: ring.bounds.midX, y: ring.bounds.midY), to: plan)), plan)
    }

    // MARK: The menu

    /// The legacy chat's "+" opens the attach menu with the keyboard put
    /// away; closed, the draft, its selection and the keyboard are as they
    /// were. The caption starts as the draft and writes back to it as it is
    /// typed; sent, the photo and the caption go out as the composer's own
    /// send, and the composer is empty after.
    func testThePlusOpensTheAttachMenuAndSendsAPhotoWithTheDraftAsCaption() async throws {
        try await open()
        card.setText("A draft that stays", selection: NSRange(location: 2, length: 5))
        card.focus()
        try await wait { self.card.textView.isFirstResponder }

        // Up and closed with nothing: all as it was.
        let first = try await menu()
        XCTAssertFalse(card.textView.isFirstResponder, "the keyboard stayed under the menu")
        let grid = try XCTUnwrap(view("attach-grid", in: first.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 6 }
        try await keep("legacy-attach-menu")
        first.close()
        try await wait { self.presented == nil }
        try await wait { self.card.textView.isFirstResponder }
        XCTAssertEqual(card.text, "A draft that stays")
        XCTAssertEqual(card.textView.selectedRange, NSRange(location: 2, length: 5))

        // Picked: the caption is the draft, and typing there types here.
        let sheet = try await menu()
        try await pick(in: sheet)
        let caption = try XCTUnwrap(view("attach-caption", in: sheet.view) as? UITextView)
        XCTAssertEqual(caption.text, "A draft that stays")
        try await keep("legacy-attach-picked")
        caption.text = "A draft that stays, with a photo"
        caption.delegate?.textViewDidChange?(caption)
        XCTAssertEqual(card.text, "A draft that stays, with a photo")

        try XCTUnwrap(view("attach-send", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)
        var items: [OutboxRecord] = []
        let deadline = ContinuousClock.now + .seconds(15)
        while items.count < 2, ContinuousClock.now < deadline {
            items = try await outbox()
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(items.map(\.kind), [.file, .message])
        XCTAssertEqual(items.last.flatMap(text), "A draft that stays, with a photo")
        let store = account.store
        let picture = try await Task.detached { try store.attachment(outboxLocalId: items[0].localId) }.value
        XCTAssertEqual(picture?.mimeType, "image/jpeg")
        try await wait { self.card.text.isEmpty && self.card.configuration.attachments.isEmpty }
        XCTAssertFalse(card.textView.isFirstResponder, "the keyboard came back after a send from the menu")
    }

    // MARK: Upload rings

    /// Sent, the picture's ring turns while it is sealed, then fills a
    /// quarter at a time with the bytes the server took, the board and the
    /// ring saying the same share, one apply each; then the picture and its
    /// text are posted in order and the bubble is the sent picture.
    func testThePictureFillsItsRingWithTheBytesWritten() async throws {
        try await open()
        let sent = try await sendPhoto("Here it is")
        let key = UploadProgressBoard.outboxKey(sent.file)
        let ring = try XCTUnwrap(sent.tile.ring)
        try await wait { UploadProgressBoard.shared.phase(key) == .preparing }
        XCTAssertEqual(ring.state, .waiting)
        // This device's copy, not a download.
        try await wait { sent.tile.pictureImage != nil }
        let (action, _) = try ringAction(sent.tile)
        XCTAssertEqual(action, .cancelUpload(messageId: sent.file, piece: sent.file))

        // The last quarter is done at once, and the picture posted.
        for quarter in 1...3 {
            let share = Double(quarter) / 4
            try await Task.sleep(for: .milliseconds(100))
            // Looked up again: a theme change may draw the row anew.
            let tile = try XCTUnwrap(tile())
            let before = tile.ringApplies
            server.allow(quarter)
            try await wait { UploadProgressBoard.shared.phase(key) == .uploading(share) && tile.ring?.state == .progress(share) }
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(tile.ringApplies - before, 1, "quarter \(quarter): not one apply")
            if quarter == 2 { try await keep("legacy-upload-ring") }
        }
        server.allow(4)
        try await wait { self.server.posted == [sent.file, sent.text] }
        let left = try await outbox()
        XCTAssertTrue(left.isEmpty)
        try await wait { UploadProgressBoard.shared.phase(key) == nil }
        XCTAssertEqual(card.text, "")
        XCTAssertTrue(card.configuration.attachments.isEmpty)
    }

    /// The cross while it uploads: the picture alone goes, its upload
    /// stops where it was, and the text it went with is posted.
    func testTheCrossTakesOutThePictureAndTheTextStillGoes() async throws {
        try await open()
        let sent = try await sendPhoto("Without the picture")
        let key = UploadProgressBoard.outboxKey(sent.file)
        server.allow(1)
        try await wait { sent.tile.ring?.state == .progress(0.25) }
        let (action, plan) = try ringAction(sent.tile)
        XCTAssertEqual(action, .cancelUpload(messageId: sent.file, piece: sent.file))
        plan.onAction?(try XCTUnwrap(action))

        try await wait { self.server.posted == [sent.text] }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.posted, [sent.text], "the picture went after its cross")
        XCTAssertEqual(server.written, 1, "the upload went on after its cross")
        let left = try await outbox()
        XCTAssertTrue(left.isEmpty)
        XCTAssertNil(UploadProgressBoard.shared.phase(key))
        try await wait { self.tile() == nil }
    }

    /// Refused: the ring shows its retry arrow and the text goes on its
    /// own; the arrow sends the picture again, from nothing to all of it.
    func testARefusedUploadRetriesFromTheRing() async throws {
        try await open()
        server.refuse(true)
        let sent = try await sendPhoto("Try again")
        let key = UploadProgressBoard.outboxKey(sent.file)
        server.allow(1)
        try await wait { self.tile()?.ring?.state == .failed }
        let failed = try XCTUnwrap(tile())
        XCTAssertNil(UploadProgressBoard.shared.phase(key), "a refused upload kept its share")
        try await wait { self.server.posted == [sent.text] }
        let (action, plan) = try ringAction(failed)
        XCTAssertEqual(action, .retry(localId: sent.file))

        server.allow(0)
        plan.onAction?(try XCTUnwrap(action))
        try await wait { UploadProgressBoard.shared.phase(key) == .preparing }
        try await wait { self.tile()?.ring?.state == .waiting }
        server.allow(4)
        try await wait { self.server.posted == [sent.text, sent.file] }
        let left = try await outbox()
        XCTAssertTrue(left.isEmpty)
    }
}
#endif
