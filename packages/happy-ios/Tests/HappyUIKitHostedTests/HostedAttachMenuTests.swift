#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyLayout
@testable import HappyUI
import HappyWire
import PhotosUI
import UIKit
import XCTest

/// A paired computer for a chat in the test host: it answers what a
/// conversation and its account's outbox ask, and takes request bodies at
/// `rate` bytes a second, as a slow tunnel would, so a ring is seen filling.
private actor AttachComputer: AgentTransport {
    var rate = Int.max
    var chunk = 4 * 1024
    private(set) var sends: [JSONValue] = []
    private(set) var uploads: [String] = []
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func throttle(rate: Int, chunk: Int) { self.rate = rate; self.chunk = chunk }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        try answer(method: method, path: path, body: body)
    }

    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        var offset = 0
        while offset < body.count {
            let end = min(body.count, offset + chunk)
            if rate != .max { try await Task.sleep(for: .seconds(Double(end - offset) / Double(rate))) }
            offset = end
            sent(offset)
        }
        return try answer(method: upload ? "PUT" : method, path: path, body: body)
    }

    func stream(path: String, credential: String, headers: [String: String]) -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func reset() {}
    func close() { streams.forEach { $0.finish() }; streams.removeAll() }

    private(set) var asked: [String] = []

    private func answer(method: String, path: String, body: Data?) throws -> HTTP1Response {
        asked.append("\(method) \(path)")
        let value = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
        if path == "/v0/config" {
            // One model, so a send has a mode to go with.
            return .init(status: 200, body: Data("""
                {"config": {"defaults": {"providerId": "claude", "modelId": "anthropic/sonnet-5", "effort": "low", "permissionMode": "auto"},
                "models": {"anthropic/sonnet-5": {"name": "Sonnet 5", "efforts": ["low"], "defaultEffort": "low", "serviceTiers": []}},
                "providers": {"claude": {"type": "claude", "enabled": true, "models": [{"id": "anthropic/sonnet-5", "enabled": true}]}}}}
                """.utf8))
        }
        if path == "/v0/bootstrap/desktop" {
            return try response(.object(["cursor": .string("c"), "projects": .array([]), "workspaces": .array([])]))
        }
        if path.hasSuffix("/bootstrap") {
            return try response(.object(["agent": .object(["id": .string("attach-test"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])]))
        }
        if path.contains("/messages?") { return try response(.object(["runs": .array([]), "hasMore": .bool(false)])) }
        if method == "GET", path.hasPrefix("/v0/agents/") {
            return try response(.object(["agent": .object(["id": .string("attach-test"), "workspaceId": .string("w"), "status": .string("idle")])]))
        }
        if method == "PUT", let name = value?["path"]?.stringValue, let content = value?["content"]?.stringValue, let bytes = Data(base64Encoded: content) {
            uploads.append(name)
            return try response(.object(["hash": .string(Hashing.sha256(bytes).map { String(format: "%02x", $0) }.joined())]))
        }
        if method == "POST", path.hasSuffix("/send"), let value { sends.append(value) }
        return try response(.object([:]))
    }

    private func response(_ value: JSONValue) throws -> HTTP1Response {
        .init(status: 200, body: try JSONEncoder().encode(value))
    }
}

/// The composer's "+" as Telegram's attachment menu, in a chat in the test
/// host, with a drawn library of each access: the grid picks in order and
/// attaches, limited access shows what was allowed and a way to change it,
/// refused shows no grid and the system's picker under the explanation, it
/// never pastes, and it comes and goes leaving the draft as it was. Then a
/// sending picture's ring, from the bytes written to the bubble.
///
/// With `HAPPY_PREVIEW_DIR` set, each state is kept there as a PNG, light
/// and dark.
@MainActor
final class HostedAttachMenuTests: XCTestCase {
    private var window: UIWindow?
    private var chat: ChatViewController!
    private var card: AgentInputCardView!
    private var computer: AttachComputer!
    private var session: Session!

    override func tearDown() async throws {
        AttachMenuEnvironment.library = { PhotoKitAttachLibrary() }
        AttachMenuEnvironment.camera = { UIImagePickerController.isSourceTypeAvailable(.camera) }
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func open(_ library: FixtureAttachLibrary, started: Bool = false) async throws {
        AttachMenuEnvironment.library = { library }
        AttachMenuEnvironment.camera = { true }
        let computer = AttachComputer()
        self.computer = computer
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "attach-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in computer })
        await account.agentConnections.setForeground(started)
        let paired = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"attach-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: "Attach test")
        addTeardownBlock { @MainActor in
            Session.forget(paired.id)
            try await account.agentConnections.remove(paired.id)
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        session = try XCTUnwrap(Session.session(for: paired.id, context: context))
        if started {
            // The account's outbox delivers once it has read the computer.
            let engine = session.engine
            await engine.start()
            let deadline = ContinuousClock.now + .seconds(10)
            while await !engine.deliveryAllowed, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
            let allowed = await engine.deliveryAllowed
            XCTAssertTrue(allowed, "the outbox never opened")
        }
        chat = ChatViewController(session: session, agentId: "attach-test", title: "Attach menu", spaceId: nil, seedling: nil)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: chat)
        self.window = window
        window.layoutIfNeeded()
        card = try XCTUnwrap(views(chat.view).compactMap { $0 as? AgentInputCardView }.first)
    }

    private func plus() throws -> UIControl {
        try XCTUnwrap(views(card).compactMap { $0 as? UIControl }.first { $0.accessibilityLabel == Strings.addPicture })
    }

    /// The menu, up and settled.
    private func menu() async throws -> AttachSheetViewController {
        try plus().sendActions(for: .touchUpInside)
        try await wait { self.chat.presentedViewController is AttachSheetViewController }
        let sheet = try XCTUnwrap(chat.presentedViewController as? AttachSheetViewController)
        try await Task.sleep(for: .milliseconds(600))
        sheet.view.layoutIfNeeded()
        return sheet
    }

    private func view(_ id: String, in root: UIView) -> UIView? {
        views(root).first { $0.accessibilityIdentifier == id && !$0.isHidden && $0.alpha > 0.01 && $0.window != nil && !hiddenAbove($0) }
    }

    private func hiddenAbove(_ view: UIView) -> Bool {
        var current = view.superview
        while let one = current {
            if one.isHidden { return true }
            current = one.superview
        }
        return false
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func wait(_ seconds: Double = 10, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state")
    }

    /// The screen as it is, light and dark, into `HAPPY_PREVIEW_DIR`: with
    /// `HAPPY_SCREEN_WATCH` set, a `.request` there asks a watcher outside
    /// to take the simulator's own screenshot (glass and all); else the
    /// test window draws itself.
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

    // MARK: Library access

    /// Full access: the newest first beside the camera, picked in order
    /// with their numbers, "Add 2" in the tab bar's place; added, a photo
    /// and a video wait in the composer.
    func testAuthorizedGridPicksInOrderAndAttachesPhotoAndVideo() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 6 }
        XCTAssertNotNil(view("attach-camera", in: sheet.view), "no camera cell")
        XCTAssertNil(view("attach-no-access", in: sheet.view))
        XCTAssertNil(view("attach-limited", in: sheet.view))
        XCTAssertNil(view("attach-add", in: sheet.view), "Add before anything was picked")

        sheet.collectionView(grid, didSelectItemAt: IndexPath(item: 0, section: 0))
        sheet.collectionView(grid, didSelectItemAt: IndexPath(item: 1, section: 0))
        XCTAssertEqual(sheet.picked, ["fixture-0", "fixture-1"])
        let first = try XCTUnwrap(view("attach-photo:0", in: sheet.view))
        let second = try XCTUnwrap(view("attach-photo:1", in: sheet.view))
        XCTAssertEqual(first.accessibilityLabel, "Photo, picked 1")
        XCTAssertTrue(second.accessibilityLabel?.hasPrefix("Video, ") == true && second.accessibilityLabel?.hasSuffix("picked 2") == true, second.accessibilityLabel ?? "")
        try await Task.sleep(for: .milliseconds(400))
        let add = try XCTUnwrap(view("attach-add", in: sheet.view) as? UIControl)
        XCTAssertEqual(add.accessibilityLabel, "Add 2")
        try await keep("attach-authorized-selected")

        add.sendActions(for: .touchUpInside)
        try await wait(15) { self.card.configuration.attachments.count == 2 && self.chat.presentedViewController == nil }
        XCTAssertEqual(card.configuration.attachments.map(\.mimeType), ["image/jpeg", "video/quicktime"])
    }

    /// Limited access: only what was allowed, under Telegram's note with
    /// its way to change that.
    func testLimitedShowsTheAllowedItemsAndAManageControl() async throws {
        try await open(FixtureAttachLibrary(access: .limited, count: 7))
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.numberOfItems(inSection: 0) == 7 }
        let note = try XCTUnwrap(view("attach-limited", in: sheet.view))
        let manage = try XCTUnwrap(view("attach-manage", in: sheet.view) as? UIButton)
        XCTAssertNotNil(manage.menu, "manage offers nothing")
        let camera = try XCTUnwrap(view("attach-camera", in: sheet.view))
        XCTAssertLessThanOrEqual(note.convert(note.bounds, to: nil).maxY, camera.convert(camera.bounds, to: nil).minY + 1, "the note isn't above the grid")
        try await keep("attach-limited")
    }

    /// Refused: no grid, the explanation, and "Choose Photos or Videos"
    /// under it, which opens the system's picker that needs no access.
    func testDeniedShowsNoGridAndPhotosUnderTheExplanation() async throws {
        try await open(FixtureAttachLibrary(access: .denied))
        let sheet = try await menu()
        XCTAssertNil(view("attach-grid", in: sheet.view), "a grid with no access")
        let explanation = try XCTUnwrap(view("attach-no-access", in: sheet.view))
        let labels = views(explanation).compactMap { $0 as? UILabel }.filter { !$0.isHidden && !($0.text ?? "").isEmpty }
        let text = try XCTUnwrap(labels.first { $0.text == Strings.AttachMenu.accessText })
        let photos = try XCTUnwrap(view("attach-photos", in: sheet.view) as? UIControl)
        XCTAssertEqual(photos.accessibilityLabel ?? (photos as? UIButton)?.configuration?.title, Strings.AttachMenu.choosePhotos)
        let below = photos.convert(photos.bounds, to: nil).minY - text.convert(text.bounds, to: nil).maxY
        XCTAssertGreaterThan(below, 0, "Photos isn't under the explanation")
        XCTAssertLessThan(below, 60, "Photos is far from the explanation")
        let settings = try XCTUnwrap(view("attach-settings", in: sheet.view))
        XCTAssertGreaterThan(settings.convert(settings.bounds, to: nil).minY, photos.convert(photos.bounds, to: nil).maxY)
        try await keep("attach-denied")

        photos.sendActions(for: .touchUpInside)
        try await wait { self.chat.presentedViewController is PHPickerViewController }
        chat.presentedViewController?.dismiss(animated: false)
    }

    /// Never asked: the menu asks once it is up, and shows the grid once allowed.
    func testNotDeterminedAsksWhenTheMenuOpens() async throws {
        let library = FixtureAttachLibrary(access: .notDetermined, grant: .authorized, count: 12)
        try await open(library)
        let sheet = try await menu()
        try await wait { library.access == .authorized }
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.numberOfItems(inSection: 0) == 12 }
    }

    /// Nothing in the menu pastes, in any state or tab.
    func testNothingPastes() async throws {
        for access in [AttachLibraryAccess.authorized, .limited, .denied] {
            try await open(FixtureAttachLibrary(access: access, count: 8))
            let sheet = try await menu()
            let files = try XCTUnwrap(view("attach-tab-files", in: sheet.view) as? UIControl)
            for page in [nil, files] {
                page?.sendActions(for: .touchUpInside)
                try await Task.sleep(for: .milliseconds(400))
                let all = views(sheet.view)
                XCTAssertFalse(all.contains { $0.accessibilityIdentifier == "attach-paste" }, "\(access): a paste row")
                XCTAssertFalse(all.contains { ($0.accessibilityLabel ?? "").localizedCaseInsensitiveContains("paste") || (($0 as? UILabel)?.text ?? "").localizedCaseInsensitiveContains("paste") }, "\(access): something says paste")
            }
            XCTAssertNotNil(view("attach-files", in: sheet.view))
            XCTAssertNotNil(view("attach-system-photos", in: sheet.view))
            if access == .authorized { try await keep("attach-files-tab") }
            sheet.close()
            try await wait { self.chat.presentedViewController == nil }
            window?.isHidden = true
        }
    }

    /// Up over the chat with the keyboard put away, pulled to full height,
    /// closed: the draft and the attachments waiting are as they were, and
    /// the keyboard comes back.
    func testOpenExpandCloseKeepsTheDraftAndGivesTheKeyboardBack() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        card.setText("A draft that stays", selection: NSRange(location: 2, length: 5))
        card.focus()
        try await wait { self.card.textView.isFirstResponder }
        let pace = ProcessInfo.processInfo.environment["HAPPY_RECORD_PACE"].flatMap(Double.init) ?? 0
        let sheet = try await menu()
        XCTAssertFalse(card.textView.isFirstResponder, "the keyboard stayed under the menu")
        let clip = try XCTUnwrap(view("attach-sheet", in: sheet.view))
        let rest = clip.convert(clip.bounds, to: nil).minY
        XCTAssertGreaterThan(rest, sheet.view.safeAreaInsets.top + 40, "the menu opened expanded")
        try await Task.sleep(for: .seconds(pace))

        sheet.setExpanded(true)
        try await Task.sleep(for: .milliseconds(700) + .seconds(pace))
        XCTAssertTrue(sheet.expanded)
        XCTAssertLessThan(clip.convert(clip.bounds, to: nil).minY, rest - 100, "it didn't pull up")
        sheet.setExpanded(false)
        try await Task.sleep(for: .milliseconds(700) + .seconds(pace))
        XCTAssertEqual(clip.convert(clip.bounds, to: nil).minY, rest, accuracy: 1, "it didn't settle back")

        try XCTUnwrap(view("attach-close", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)
        try await wait { self.chat.presentedViewController == nil }
        XCTAssertEqual(card.text, "A draft that stays")
        try await wait { self.card.textView.isFirstResponder }
        XCTAssertEqual(card.textView.selectedRange, NSRange(location: 2, length: 5))
        try await Task.sleep(for: .seconds(pace))
    }

    // MARK: Upload progress

    /// A tile's ring as the board says, applied once a frame however many
    /// writes came between: half way it is a dark disc with the arc half
    /// round and the cross; failed, a retry arrow; sent, gone.
    func testARingShowsTheBoardsShareOnceAFrame() async throws {
        let window = hostedKeyWindow(in: try await hostedActiveScene())
        self.window = window
        let host = UIView(frame: window.bounds)
        host.backgroundColor = UIColor(Palette.surface)
        window.rootViewController?.view.addSubview(host)
        // Waiting its turn: the short arc, not a whole ring.
        XCTAssertEqual(UploadRingView().drawn, UploadRingLayout.waitingShare)
        let tile = ChatMediaView(frame: CGRect(x: 60, y: 200, width: 240, height: 180))
        tile.backgroundColor = .systemTeal
        host.addSubview(tile)
        let key = "ring-\(UUID().uuidString):1"
        UploadProgressBoard.shared.set(key, .uploading(0.5))
        tile.apply(ChatMedia(key: "sent/\(key)", isVideo: false, thumbhash: nil, label: Strings.picture, upload: ChatUpload(key: key, failed: false)))
        tile.layoutIfNeeded()
        let ring = try XCTUnwrap(tile.ring)
        XCTAssertEqual(ring.state, .progress(0.5))
        XCTAssertEqual(ring.frame, CGRect(x: 95, y: 65, width: 50, height: 50))
        XCTAssertEqual(tile.accessibilityValue, "uploading, 50%")
        try await keep("upload-ring-half")

        // Three writes between frames: one apply, with the last.
        try await Task.sleep(for: .milliseconds(100))
        let before = UploadRings.shared.applied
        UploadProgressBoard.shared.set(key, .uploading(0.6))
        UploadProgressBoard.shared.set(key, .uploading(0.7))
        UploadProgressBoard.shared.set(key, .uploading(0.75))
        try await wait { ring.state == .progress(0.75) }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(UploadRings.shared.applied - before, 1)

        tile.apply(ChatMedia(key: "sent/\(key)", isVideo: false, thumbhash: nil, label: Strings.picture, upload: ChatUpload(key: key, failed: true)))
        XCTAssertEqual(ring.state, .failed)
        XCTAssertEqual(tile.accessibilityValue, Strings.Upload.failed)
        try await keep("upload-ring-failed")

        tile.apply(ChatMedia(key: "sent/\(key)", isVideo: false, thumbhash: nil, label: Strings.picture, upload: ChatUpload(key: key, failed: false)))
        UploadProgressBoard.shared.set(key, .done)
        try await wait { ring.isHidden }
        UploadProgressBoard.shared.clear(message: String(key.dropLast(2)))
    }

    /// End to end, over a slow tunnel: a photo and a video picked in the
    /// menu and sent; each fills its ring in the bubble from the bytes the
    /// computer took, and the message goes with the video's upload named.
    func testASlowUploadFillsEachRingInTheBubble() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30), started: true)
        let rate = ProcessInfo.processInfo.environment["HAPPY_UPLOAD_RATE"].flatMap(Int.init) ?? 400_000
        await computer.throttle(rate: rate, chunk: 8 * 1024)
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 2 }
        sheet.collectionView(grid, didSelectItemAt: IndexPath(item: 0, section: 0))
        sheet.collectionView(grid, didSelectItemAt: IndexPath(item: 1, section: 0))
        try await Task.sleep(for: .milliseconds(300))
        try XCTUnwrap(view("attach-add", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)
        try await wait(15) { self.card.configuration.attachments.count == 2 && self.chat.presentedViewController == nil }
        card.setText("Here they are", selection: NSRange(location: 13, length: 0))
        chat.agentInputCardDidPressSend(card)

        // Both tiles get rings; each only ever moves forward.
        var seen: [ObjectIdentifier: [UploadRingView.State]] = [:]
        let deadline = ContinuousClock.now + .seconds(60)
        var tiles: [ChatMediaView] = []
        var keeping: Task<Void, Error>?
        while ContinuousClock.now < deadline {
            tiles = views(chat.view).compactMap { $0 as? ChatMediaView }.filter { $0.window != nil && !$0.isHidden }
            for tile in tiles {
                guard let ring = tile.ring, !ring.isHidden else { continue }
                if seen[ObjectIdentifier(ring), default: []].last != ring.state { seen[ObjectIdentifier(ring), default: []].append(ring.state) }
            }
            if await computer.sends.count == 1 { break }
            if keeping == nil, seen.values.contains(where: { $0.contains { if case .progress(let share) = $0 { share > 0.3 } else { false } } }) {
                keeping = Task { try await self.keep("upload-bubble") }
            }
            try await Task.sleep(for: .milliseconds(16))
        }
        try await keeping?.value
        let asked = await computer.asked
        XCTAssertEqual(seen.count, 2, "both the photo and the video showed a ring; asked: \(Set(asked).sorted())")
        for states in seen.values {
            let shares = states.compactMap { if case .progress(let share) = $0 { share } else { nil } }
            XCTAssertGreaterThan(shares.count, 2, "a ring barely moved: \(states)")
            XCTAssertEqual(shares, shares.sorted(), "a ring went back: \(shares)")
        }
        let uploads = await computer.uploads
        let sends = await computer.sends
        XCTAssertEqual(uploads.count, 1, "the video was uploaded once")
        XCTAssertTrue(uploads.first?.hasSuffix(".mov") == true)
        XCTAssertEqual(sends.count, 1)
        XCTAssertTrue(sends.first?["text"]?.stringValue?.contains(uploads.first ?? "-") == true, "the message doesn't name the upload")
        XCTAssertEqual(sends.first?["content"]?.arrayValue?.count, 1, "the photo went inline")
        // Taken: the rings are let go.
        try await wait(10) { tiles.allSatisfy { $0.ring?.isHidden ?? true } }
    }
}
#endif
