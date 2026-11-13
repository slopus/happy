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
        AttachMenuEnvironment.reduceMotion = { UIAccessibility.isReduceMotionEnabled }
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
        chat = ChatViewController(session: session, agentId: "attach-test", title: "Attach menu", spaceId: nil, intro: nil)
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

    /// Taps picture `index`'s circle, as a finger would.
    private func pick(_ index: Int, in grid: UICollectionView) throws {
        let cell = try XCTUnwrap(grid.cellForItem(at: IndexPath(item: index, section: 0)) as? AttachGridCell)
        cell.check.sendActions(for: .touchUpInside)
    }

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
    /// with their numbers; the count beside close, the tab bar turned into
    /// the caption with send, which starts from the draft and writes back
    /// to it; sent, the menu goes and the composer sends both with it.
    func testAuthorizedGridPicksInOrderAndSendsWithTheCaption() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        card.setText("Draft", selection: NSRange(location: 5, length: 0))
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 6 }
        XCTAssertNotNil(view("attach-camera", in: sheet.view), "no camera cell")
        XCTAssertNil(view("attach-no-access", in: sheet.view))
        XCTAssertNil(view("attach-limited", in: sheet.view))
        XCTAssertNil(view("attach-send", in: sheet.view), "send before anything was picked")
        XCTAssertNil(view("attach-count", in: sheet.view), "a count before anything was picked")

        try pick(0, in: grid)
        try pick(1, in: grid)
        XCTAssertEqual(sheet.picked, ["fixture-0", "fixture-1"])
        let first = try XCTUnwrap(view("attach-photo:0", in: sheet.view))
        let second = try XCTUnwrap(view("attach-photo:1", in: sheet.view))
        XCTAssertEqual(first.accessibilityLabel, "Photo, picked 1")
        XCTAssertTrue(second.accessibilityLabel?.hasPrefix("Video, ") == true && second.accessibilityLabel?.hasSuffix("picked 2") == true, second.accessibilityLabel ?? "")
        try await Task.sleep(for: .milliseconds(500))
        let send = try XCTUnwrap(view("attach-send", in: sheet.view) as? UIControl)
        XCTAssertEqual(view("attach-count", in: sheet.view)?.accessibilityLabel, "2 selected")
        let caption = try XCTUnwrap(view("attach-caption", in: sheet.view) as? UITextView)
        XCTAssertEqual(caption.text, "Draft", "the caption isn't the draft")
        XCTAssertNil(view("attach-tab-files", in: sheet.view), "the tabs stayed under the caption")
        try await keep("attach-authorized-selected")

        caption.text = "Draft and two"
        caption.delegate?.textViewDidChange?(caption)
        XCTAssertEqual(card.text, "Draft and two", "the caption didn't write back to the draft")
        send.sendActions(for: .touchUpInside)
        try await wait(15) { self.chat.presentedViewController == nil && self.card.text.isEmpty && self.card.configuration.attachments.isEmpty }
    }

    /// The count at the top right takes the picks to the composer instead:
    /// the menu goes, both wait there with the caption as the text and the
    /// keyboard up, nothing sent until the composer's own send.
    func testTheCountAtTheTopRightStagesThePicksWithoutSending() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        card.setText("Draft", selection: NSRange(location: 5, length: 0))
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 6 }
        try pick(0, in: grid)
        try pick(1, in: grid)
        try await Task.sleep(for: .milliseconds(500))
        let count = try XCTUnwrap(view("attach-count", in: sheet.view) as? UIControl)
        XCTAssertEqual(count.accessibilityLabel, "2 selected")
        // At the header's far right, clear of close and the title.
        let frame = count.convert(count.bounds, to: sheet.view)
        let close = try XCTUnwrap(view("attach-close", in: sheet.view)).convert(CGRect(x: 0, y: 0, width: 44, height: 44), to: sheet.view)
        let title = try XCTUnwrap(view("attach-title", in: sheet.view))
        XCTAssertEqual(frame.midY, close.midY, accuracy: 0.5, "the count isn't in the header")
        XCTAssertEqual(sheet.view.bounds.width - frame.maxX, close.minX, accuracy: 6, "the count isn't at the far right")
        XCTAssertGreaterThan(frame.minX, title.convert(title.bounds, to: sheet.view).maxX, "the count is over the title")
        XCTAssertNotNil(view("attach-send", in: sheet.view), "the caption lost its send")
        let caption = try XCTUnwrap(view("attach-caption", in: sheet.view) as? UITextView)
        caption.text = "Draft and two"
        caption.delegate?.textViewDidChange?(caption)
        try await keep("attach-count-top-right")

        count.sendActions(for: .touchUpInside)
        try await wait(15) { self.chat.presentedViewController == nil && self.card.configuration.attachments.count == 2 }
        XCTAssertEqual(card.text, "Draft and two", "the caption isn't the composer's text")
        try await wait { self.card.textView.isFirstResponder }
        try await Task.sleep(for: .milliseconds(500))
        let sent = await computer.sends.count
        XCTAssertEqual(sent, 0, "the count sent")
        try await keep("attach-count-staged")
        chat.agentInputCardDidPressSend(card)
        try await wait(15) { self.card.text.isEmpty && self.card.configuration.attachments.isEmpty }
    }

    /// The circle takes touches in the tile's top right 44, past its own
    /// 29 (Telegram's takes only its own); the rest of the tile opens the
    /// preview.
    func testTheCirclePicksFromTheTilesCorner() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 6 }
        let cell = try XCTUnwrap(grid.cellForItem(at: IndexPath(item: 0, section: 0)) as? AttachGridCell)
        let width = cell.bounds.width
        for point in [CGPoint(x: width - 2, y: 2), CGPoint(x: width - 43, y: 43), CGPoint(x: width - 17, y: 17)] {
            XCTAssertTrue(cell.hitTest(point, with: nil)?.isDescendant(of: cell.check) == true, "\(point) missed the circle")
        }
        for point in [CGPoint(x: width - 46, y: 20), CGPoint(x: width - 20, y: 46), CGPoint(x: width / 2, y: cell.bounds.midY)] {
            XCTAssertFalse(cell.hitTest(point, with: nil)?.isDescendant(of: cell.check) == true, "\(point) took the circle")
        }
    }

    /// A long caption grows to its tallest, the chat composer's five lines,
    /// and then scrolls inside its one row, send at its foot; the text never leaves
    /// the glass, and the grid keeps room to scroll every picture clear of it.
    func testALongCaptionStopsGrowingAndScrollsInside() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        let sheet = try await menu()
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        try await wait { grid.visibleCells.count >= 6 }
        try pick(0, in: grid)
        try await Task.sleep(for: .milliseconds(500))
        let caption = try XCTUnwrap(view("attach-caption", in: sheet.view) as? UITextView)
        caption.becomeFirstResponder()
        try await Task.sleep(for: .milliseconds(800))
        caption.text = Array(repeating: "A caption that goes on and on.", count: 40).joined(separator: " ")
        caption.delegate?.textViewDidChange?(caption)
        try await Task.sleep(for: .milliseconds(400))
        sheet.view.layoutIfNeeded()
        let sheetLayout = try XCTUnwrap(sheet.sheet)
        let glass = sheet.panel.glassFrame
        let room = sheet.view.bounds.height - sheet.keyboard - sheetLayout.expandedTop
        // The chat composer's card caps its own text (120) and scrolls it.
        XCTAssertLessThanOrEqual(glass.height, sheet.panel.card.height(fitting: glass.width) + 0.5)
        XCTAssertLessThan(glass.height, room / 2, "the caption grew past its tallest")
        XCTAssertGreaterThanOrEqual(glass.minY, sheetLayout.expandedTop, "the caption rose over the header")
        XCTAssertLessThanOrEqual(glass.maxY, sheet.view.bounds.height - sheet.keyboard + 0.5, "the caption went under the keyboard")
        let text = caption.convert(caption.bounds, to: sheet.panel)
        XCTAssertGreaterThanOrEqual(text.minY, 0, "the text left the glass's top")
        XCTAssertLessThanOrEqual(text.maxY, sheet.panel.bounds.height + 0.5, "the text left the glass's foot")
        XCTAssertTrue(caption.isScrollEnabled, "a caption past its tallest doesn't scroll")
        // Scrolled to its end, the top line shows whole and nothing of the
        // line above it peeks in over it.
        caption.setContentOffset(CGPoint(x: 0, y: caption.contentSize.height - caption.bounds.height), animated: false)
        let top = caption.contentOffset.y
        let layoutManager = try XCTUnwrap(caption.textLayoutManager)
        var lines: [CGRect] = []
        layoutManager.enumerateTextLayoutFragments(from: layoutManager.documentRange.location, options: [.ensuresLayout]) { fragment in
            for line in fragment.textLineFragments {
                lines.append(line.typographicBounds.offsetBy(dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY))
            }
            return true
        }
        let cut = try XCTUnwrap(lines.first { $0.minY <= top && top < $0.maxY })
        XCTAssertLessThan(top - cut.minY, 1, "part of the line above the top one shows")
        // One row: send beside the text at its foot, no row of controls under it.
        let send = sheet.panel.card.primaryControl.convert(sheet.panel.card.primaryControl.bounds, to: sheet.panel)
        XCTAssertGreaterThanOrEqual(send.minX, text.maxX, "send isn't beside the text")
        XCTAssertEqual(send.maxY, text.maxY, accuracy: 12, "send isn't at the text's last line")
        XCTAssertLessThan(sheet.panel.bounds.height - send.maxY, 12, "a row under send")
        let under = sheet.panel.convert(sheet.panel.bounds, to: grid)
        let visibleFoot = grid.bounds.maxY - grid.contentInset.bottom
        XCTAssertLessThanOrEqual(visibleFoot, under.minY + 0.5, "the grid's last row can't scroll clear of the caption")
        try await keep("attach-long-caption")
        caption.resignFirstResponder()
    }

    /// Limited access: only what was allowed, under Telegram's note with
    /// its way to change that.
    func testLimitedShowsTheAllowedItemsAndAManageControl() async throws {
        try await open(FixtureAttachLibrary(access: .limited, count: 7))
        let sheet = try await menu()
        // Presentation and library delivery can outlast menu()'s animation
        // pause on CI. The existing wait covers the visible grid and its data.
        try await wait {
            (self.view("attach-grid", in: sheet.view) as? UICollectionView)?.numberOfItems(inSection: 0) == 7
        }
        let grid = try XCTUnwrap(view("attach-grid", in: sheet.view) as? UICollectionView)
        XCTAssertEqual(grid.numberOfItems(inSection: 0), 7)
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
            let files = try XCTUnwrap(view("attach-tab-files", in: sheet.view))
            for page in [nil, files] {
                _ = page?.accessibilityActivate()
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

    // MARK: In and out

    /// What is on screen each frame, as drawn (presentation layers), in the
    /// window's space: the sheet's clip and dim, the "+" and the morph's
    /// picture of it.
    private struct Frame {
        var clip: CGRect
        var dim: Float
        /// The "+" as drawn: its own opacity times its ancestors'.
        var plus: Float
        var plusFrame: CGRect
        /// The morph's picture of the "+": opacity as drawn, and where.
        var glyph: Float
        var glyphFrame: CGRect
    }

    private func film(_ sheet: @escaping () -> AttachSheetViewController?, plus: UIView, for seconds: Double, while act: () async throws -> Void) async throws -> [Frame] {
        var frames: [Frame] = []
        let recorder = TickRecorder { _ in
            frames.append(self.frame(sheet(), plus: plus))
        }
        try await act()
        try await Task.sleep(for: .seconds(seconds))
        recorder.stop()
        return frames
    }

    private func frame(_ sheet: AttachSheetViewController?, plus: UIView) -> Frame {
        func drawn(_ view: UIView) -> (Float, CGRect) {
            guard let window = view.window else { return (0, .zero) }
            var opacity: Float = 1
            var current: UIView? = view
            while let one = current {
                let layer = one.layer.presentation() ?? one.layer
                // As drawn: the presentation tree only, so every view is read
                // from the same committed frame.
                if layer.isHidden { return (0, .zero) }
                opacity *= layer.opacity
                current = one.superview
            }
            let layer = view.layer.presentation() ?? view.layer
            return (opacity, layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer))
        }
        let (plusOpacity, plusFrame) = drawn(plus)
        var result = Frame(clip: .zero, dim: 0, plus: plusOpacity, plusFrame: plusFrame, glyph: 0, glyphFrame: .zero)
        guard let sheet, sheet.isViewLoaded, sheet.view.window != nil else { return result }
        if let clip = views(sheet.view).first(where: { $0.accessibilityIdentifier == "attach-sheet" }) {
            let layer = clip.layer.presentation() ?? clip.layer
            if let window = clip.window { result.clip = layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer) }
        }
        if let dim = views(sheet.view).first(where: { $0.accessibilityIdentifier == "attach-dim" }) {
            result.dim = (dim.layer.presentation() ?? dim.layer).opacity
        }
        if let glyph = views(sheet.view).first(where: { $0.accessibilityIdentifier == "attach-morph-glyph" }) {
            (result.glyph, result.glyphFrame) = drawn(glyph)
        }
        return result
    }

    /// Across a hand-off between the "+" and the morph's picture of it:
    /// every frame shows exactly one "+", whole, in the button's place;
    /// never neither, never both.
    private func assertOnePlus(_ frames: ArraySlice<Frame>, _ phase: String, travel: CGFloat = 0.5, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(frames.isEmpty, "\(phase): no frames", file: file, line: line)
        // The morph's "+" travels onto the button; the frame before the
        // button shows again it is on its pixels.
        if let index = frames.lastIndex(where: { $0.glyph > 0.02 }) {
            let last = frames[index]
            XCTAssertEqual(last.glyphFrame.midX, last.plusFrame.midX, accuracy: travel, "\(phase): the morph's + is off the button at the hand-over", file: file, line: line)
            XCTAssertEqual(last.glyphFrame.midY, last.plusFrame.midY, accuracy: travel, "\(phase): the morph's + is off the button at the hand-over", file: file, line: line)
            XCTAssertEqual(last.glyphFrame.width, last.plusFrame.width, accuracy: 0.5, file: file, line: line)
        }
        for (index, frame) in frames.enumerated() {
            let shown = [frame.plus, frame.glyph].filter { $0 > 0.02 }
            XCTAssertEqual(shown.count, 1, "\(phase) frame \(index): plus \(frame.plus), morph \(frame.glyph)", file: file, line: line)
            XCTAssertGreaterThan(max(frame.plus, frame.glyph), 0.98, "\(phase) frame \(index): the + is faded (\(frame.plus), \(frame.glyph))", file: file, line: line)
        }
    }

    /// The "+" as a finger presses it: down, the action, then up, as
    /// UIControl orders them, so its press's own spring runs as on a phone.
    private func press(_ plus: UIControl) {
        plus.isHighlighted = true
        plus.sendActions(for: .touchUpInside)
        plus.isHighlighted = false
    }

    /// The "+" as a finger opens it: the sheet grows out of the button over
    /// several frames, from about the button's size to its own, while the
    /// dim fades in; closed, it shrinks back into the button and the dim
    /// fades out. Neither may land in one frame, and the "+" hands over to
    /// the morph and back without a frame where it is missing or doubled,
    /// nor ever showing over the sheet in between.
    func testTheMenuGrowsOutOfThePlusAndBackIntoIt() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        let plus = try plus()
        let button = plus.convert(plus.bounds, to: nil)
        // Before the press, for the hand-over's first frame.
        let before = frame(nil, plus: plus)
        let opening = try await film({ self.chat.presentedViewController as? AttachSheetViewController }, plus: plus, for: 0.8) {
            press(plus)
        }
        let sheet = try XCTUnwrap(chat.presentedViewController as? AttachSheetViewController)
        let rest = try XCTUnwrap(opening.last).clip
        let growing = opening.filter { $0.clip.width > button.width + 4 && $0.clip.width < rest.width - 4 }
        XCTAssertGreaterThanOrEqual(growing.count, 5, "the sheet didn't grow over frames: \(opening.prefix(12).map { Int($0.clip.width) })")
        XCTAssertLessThan(try XCTUnwrap(opening.first { $0.clip.width > 0 }).clip.width, rest.width / 2, "the first frame was already big")
        XCTAssertGreaterThanOrEqual(opening.filter { $0.dim > 0.05 && $0.dim < 0.95 }.count, 4, "the dim didn't fade in")
        XCTAssertEqual(rest.width, sheet.view.bounds.width, accuracy: 12)
        // The hand-over: up to the morph's first frame the button shows,
        // from it the morph's picture, on the same pixels.
        XCTAssertGreaterThan(before.plus, 0.98)
        let firstMorph = try XCTUnwrap(opening.firstIndex { $0.clip.width > 0 }, "the morph never showed")
        // Its first frame on screen is already one frame into its spring.
        assertOnePlus(opening[..<(firstMorph + 1)], "open hand-over", travel: 2)
        // From then on the button stays hidden: its press's spring doesn't
        // bring it back over the sheet.
        let after = opening[firstMorph...]
        XCTAssertTrue(after.allSatisfy { $0.plus < 0.02 }, "the + showed again while the menu opened: \(after.map(\.plus).prefix(30))")

        let closing = try await film({ sheet }, plus: plus, for: 0.9) {
            try XCTUnwrap(view("attach-close", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)
        }
        try await wait { self.chat.presentedViewController == nil }
        let shrinking = closing.filter { $0.clip.width > button.width + 4 && $0.clip.width < rest.width - 4 }
        XCTAssertGreaterThanOrEqual(shrinking.count, 4, "the sheet didn't shrink over frames: \(closing.prefix(12).map { Int($0.clip.width) })")
        XCTAssertGreaterThanOrEqual(closing.filter { $0.dim > 0.05 && $0.dim < 0.95 }.count, 3, "the dim didn't fade out")
        // The hand-back: from the frame the morph's + is whole to the end,
        // exactly one + every frame, the button's own at the end.
        let whole = try XCTUnwrap(closing.firstIndex { $0.glyph > 0.98 }, "the morph's + never came back whole")
        assertOnePlus(closing[whole...], "close hand-back")
        XCTAssertGreaterThan(try XCTUnwrap(closing.last).plus, 0.98, "the + stayed hidden")
        let landed = try XCTUnwrap(closing.last { $0.glyph > 0.98 })
        XCTAssertEqual(landed.clip.midX, button.midX, accuracy: 0.5, "it didn't go back into the +")
        XCTAssertEqual(plus.alpha, 1)
    }

    /// Closed by tapping the dim and by Escape, the same hand-back.
    func testTheDimAndEscapeHandTheButtonBackInOneFrame() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        let plus = try plus()
        for how in ["dim", "escape"] {
            press(plus)
            try await wait { self.chat.presentedViewController is AttachSheetViewController }
            let sheet = try XCTUnwrap(chat.presentedViewController as? AttachSheetViewController)
            try await Task.sleep(for: .milliseconds(700))
            let closing = try await film({ sheet }, plus: plus, for: 0.9) {
                if how == "dim" {
                    _ = sheet.perform(NSSelectorFromString("dimTapped"))
                } else {
                    _ = sheet.accessibilityPerformEscape()
                }
            }
            try await wait { self.chat.presentedViewController == nil }
            let whole = try XCTUnwrap(closing.firstIndex { $0.glyph > 0.98 }, "\(how): the morph's + never came back whole")
            assertOnePlus(closing[whole...], "\(how) hand-back")
            XCTAssertEqual(plus.alpha, 1)
        }
    }

    /// With Reduce Motion the sheet slides: the "+" never hides.
    func testWithReduceMotionThePlusStaysAndTheSheetSlides() async throws {
        AttachMenuEnvironment.reduceMotion = { true }
        try await open(FixtureAttachLibrary(access: .authorized, count: 30))
        let plus = try plus()
        let opening = try await film({ self.chat.presentedViewController as? AttachSheetViewController }, plus: plus, for: 0.7) {
            press(plus)
        }
        let sheet = try XCTUnwrap(chat.presentedViewController as? AttachSheetViewController)
        let shown = opening.filter { $0.clip.width > 0 }
        XCTAssertGreaterThanOrEqual(Set(shown.map { Int($0.clip.minY) }).count, 5, "it didn't slide in")
        XCTAssertTrue(opening.allSatisfy { $0.glyph < 0.02 }, "a morph under Reduce Motion")
        let closing = try await film({ sheet }, plus: plus, for: 0.6) { sheet.close() }
        try await wait { self.chat.presentedViewController == nil }
        // Its press dims it a moment, as any press does; it never goes.
        XCTAssertTrue((opening + closing).allSatisfy { $0.plus > 0.5 }, "the + hid under Reduce Motion: \((opening + closing).map(\.plus).min() ?? 0)")
        XCTAssertGreaterThan(try XCTUnwrap(closing.last).plus, 0.98)
    }

    /// A picture waiting in the composer grows in over frames and, taken
    /// out, shrinks and fades over frames before it goes.
    func testComposerPicturesGrowInAndShrinkOut() async throws {
        try await open(FixtureAttachLibrary(access: .authorized, count: 4))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("chip-\(UUID().uuidString).png")
        try UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }.pngData()?.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let strip = try XCTUnwrap(views(card).compactMap { $0 as? AttachmentStripView }.first)
        func scales(while change: () -> Void) async throws -> [CGFloat] {
            var seen: [CGFloat] = []
            let recorder = TickRecorder { _ in
                // Only what can be seen: the strip hidden hides its pictures.
                guard !strip.isHidden else { return }
                for view in strip.drawnThumbnails {
                    seen.append((view.layer.presentation() ?? view.layer).affineTransform().a)
                }
            }
            change()
            try await Task.sleep(for: .milliseconds(600))
            recorder.stop()
            return seen
        }
        var config = card.configuration
        config.attachments = [AgentInputAttachmentPreview(id: "a", fileURL: file, mimeType: "image/png")]
        let growing = try await scales { self.card.configuration = config }
        XCTAssertGreaterThanOrEqual(growing.filter { $0 > 0.25 && $0 < 0.95 }.count, 4, "it didn't grow in: \(growing.prefix(12))")
        XCTAssertEqual(growing.last ?? 0, 1, accuracy: 0.001)

        config.attachments = []
        let shrinking = try await scales { self.card.configuration = config }
        XCTAssertGreaterThanOrEqual(shrinking.filter { $0 > 0.25 && $0 < 0.95 }.count, 4, "it didn't shrink out: \(shrinking.prefix(12))")
        XCTAssertTrue(strip.drawnThumbnails.isEmpty, "it stayed")
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
        XCTAssertEqual(MediaRingView().drawn, UploadRingLayout.waitingShare)
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
        try pick(0, in: grid)
        try pick(1, in: grid)
        try await Task.sleep(for: .milliseconds(500))
        let caption = try XCTUnwrap(view("attach-caption", in: sheet.view) as? UITextView)
        caption.text = "Here they are"
        caption.delegate?.textViewDidChange?(caption)
        // Sent from the menu, as Telegram's send does.
        try XCTUnwrap(view("attach-send", in: sheet.view) as? UIControl).sendActions(for: .touchUpInside)

        // Both tiles get rings; each only ever moves forward.
        var seen: [ObjectIdentifier: [MediaRingView.State]] = [:]
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
        try await wait(10) { tiles.allSatisfy { $0.ring.map { $0.isHidden || $0.state == .play } ?? true } }
    }
}
#endif
