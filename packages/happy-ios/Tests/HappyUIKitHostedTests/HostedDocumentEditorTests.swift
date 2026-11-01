#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct OfflineRelay: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct OfflineSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A paired computer with one shared document, kept as the daemon keeps it
/// (`SurfaceDocuments`): a Yjs replica, a change log, live frames to each
/// subscribed stream, and a desktop editor of its own that can type into it.
private actor DocumentComputer: AgentTransport {
    static let surfaceId = "notes"
    static let home = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],
     "surfaces":[{"id":"notes","name":"Release notes","type":"document","members":[{"userId":null,"orderKey":"a"}]}]}
    """#

    let doc: YDoc
    private(set) var seq = 0
    private var mutations: [String: Int] = [:]
    private(set) var posted: [String] = []
    private(set) var presence = 0
    var online = true
    private var streams: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    private var subscribed: Set<String> = []
    private var connections = 0

    init(base: [UInt8]) {
        doc = YDoc(clientID: 1)
        try! doc.applyUpdate(base)
    }

    var markdown: String { DocumentMarkdown.markdown(DocumentReader.blocks(doc)) }
    var lines: [DocumentLine] { DocumentEditor.flatten(DocumentReader.blocks(doc)) }
    var isSubscribed: Bool { !subscribed.isEmpty }

    func set(online: Bool) {
        self.online = online
        if !online {
            streams.values.forEach { $0.finish(throwing: URLError(.notConnectedToInternet)) }
            streams.removeAll()
            subscribed.removeAll()
        }
    }

    /// Desktop types: the change is stored and sent to every subscribed stream.
    func desktop(_ edit: @Sendable (DocumentEditor) -> Void) {
        let replica = YDoc(clientID: 4040 + seq)
        try! replica.applyUpdate(doc.encodeStateAsUpdate())
        let editor = DocumentEditor(doc: replica)
        var update: [UInt8] = []
        editor.onLocalUpdate = { update = $0 }
        edit(editor)
        store(update, mutationId: nil)
    }

    private func store(_ update: [UInt8], mutationId: String?) {
        try! doc.applyUpdate(update)
        seq += 1
        if let mutationId { mutations[mutationId] = seq }
        let frame: JSONValue = .object([
            "surfaceId": .string(Self.surfaceId), "seq": .number(Double(seq)), "update": .string(Data(update).base64EncodedString()),
            "mutationId": mutationId.map(JSONValue.string) ?? .null, "actor": .object(["userId": .null, "agentId": .null]), "source": .string("api"),
        ])
        let data = Data("event: document.update\ndata: \(String(decoding: try! JSONEncoder().encode(frame), as: UTF8.self))\n\n".utf8)
        for id in subscribed { streams[id]?.yield(data) }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        let json = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
        let base = "/v0/surfaces/document/\(Self.surfaceId)"
        let route = String(path.split(separator: "?").first ?? "")
        func answer(_ value: JSONValue) throws -> HTTP1Response { .init(status: 200, body: try JSONEncoder().encode(value)) }
        switch (method, route) {
        case ("GET", "/v0/bootstrap/desktop"):
            return .init(status: 200, body: Data(Self.home.utf8))
        case ("GET", "/v0/health"):
            return try answer(.object(["capabilities": .object(["collaborativeDocuments": .bool(true), "surfaceEditing": .bool(true)])]))
        case ("GET", base + "/state"):
            var since: [Int: Int] = [:]
            if let raw = path.split(separator: "stateVector=").dropFirst().first, let bytes = Data(base64Encoded: String(raw).removingPercentEncoding ?? "") {
                since = try YDoc.decodeStateVector(Array(bytes))
            }
            return try answer(.object([
                "seq": .number(Double(seq)),
                "update": .string(Data(doc.encodeStateAsUpdate(since: since)).base64EncodedString()),
                "stateVector": .string(Data(YDoc.encodeStateVector(doc.stateVector())).base64EncodedString()),
            ]))
        case ("POST", base + "/updates"):
            let id = json?["mutationId"]?.stringValue ?? ""
            posted.append(id)
            if mutations[id] == nil, let text = json?["update"]?.stringValue, let bytes = Data(base64Encoded: text) {
                store(Array(bytes), mutationId: id)
            }
            return try answer(.object(["seq": .number(Double(mutations[id] ?? seq))]))
        case ("POST", base + "/subscribe"):
            if let id = json?["streamId"]?.stringValue { subscribed.insert(id) }
            return try answer(.object(["seq": .number(Double(seq))]))
        case ("POST", base + "/unsubscribe"):
            if let id = json?["streamId"]?.stringValue { subscribed.remove(id) }
            return try answer(.object([:]))
        case ("POST", base + "/presence"):
            presence += 1
            return try answer(.object([:]))
        default:
            return .init(status: 404, body: Data("{}".utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        connections += 1
        let id = "stream\(connections)"
        streams[id] = continuation
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true,\"streamId\":\"\(id)\"}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() {}
}

/// The document editor on a simulator against a computer that keeps the
/// document as the daemon does: opening it, typing with Markdown
/// shortcuts, formatting, ticking a task, a desktop edit merging under the
/// caret, and an offline edit sent once the computer is back.
@MainActor
final class HostedDocumentEditorTests: XCTestCase {
    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        guard let folder = Self.evidence else { return }
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
    }

    private func until(_ what: String, _ seconds: Double = 6, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    /// The document the computer starts with, as desktop would have written it.
    static func seed() -> [UInt8] {
        let doc = YDoc(clientID: 7)
        let editor = DocumentEditor(doc: doc)
        var updates: [[UInt8]] = []
        editor.onLocalUpdate = { updates.append($0) }
        func line(_ type: String, _ runs: [DocumentRun], depth: Int = 0, props: [String: YAny] = [:]) -> DocumentLine {
            DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: type, props: props, content: .inline(runs)), depth: depth)
        }
        let bold: [String: YAny] = ["bold": .object([])]
        editor.replaceLines(0..<editor.lines.count, with: [
            line("heading", [DocumentRun("Release notes")], props: ["level": .number(1)]),
            line("paragraph", [DocumentRun("Hello world, this is the "), DocumentRun("shared", marks: bold), DocumentRun(" document.")]),
            line("checkListItem", [DocumentRun("Ship the editor")]),
            line("checkListItem", [DocumentRun("Write the doc")], props: ["checked": .bool(true)]),
            line("bulletListItem", [DocumentRun("Offline first")]),
            line("bulletListItem", [DocumentRun("Kept on the phone")], depth: 1),
            line("numberedListItem", [DocumentRun("Open")]),
            line("numberedListItem", [DocumentRun("Type")]),
            line("quote", [DocumentRun("Merges never lose the cursor.")]),
            line("codeBlock", [DocumentRun("let doc = YDoc()\ndoc.applyUpdate(update)")], props: ["language": .string("swift")]),
            DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "divider", content: .none)),
            line("paragraph", [DocumentRun("See "), DocumentRun("happy.engineering", marks: ["link": .object([("href", .string("https://happy.engineering"))])]), DocumentRun(" and "), DocumentRun("code", marks: ["code": .object([])]), DocumentRun(".")]),
        ])
        return doc.encodeStateAsUpdate()
    }

    private struct Opened {
        let session: Session
        let screen: DocumentViewController
        let window: UIWindow
        let navigation: UINavigationController
    }

    private func open(_ computer: DocumentComputer, style: UIUserInterfaceStyle = .light) async throws -> Opened {
        let credentials = InMemoryAgentConnectionCredentialStore()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("document-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentConnectionCredentialStore: credentials,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: OfflineRelay(), connector: OfflineSockets()
        )
        await account.agentConnections.setForeground(false)
        let pairing = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"document-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in Session.forget(pairing.id) }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        await session.engine.start()
        try await until("live") { session.home.live }
        let screen = SurfaceScreens.make(session: session, surface: AgentWire.Surface(id: DocumentComputer.surfaceId, type: "document", name: "Release notes"))
        let document = try XCTUnwrap(screen as? DocumentViewController)
        let navigation = UINavigationController(rootViewController: document)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        window.overrideUserInterfaceStyle = style
        addTeardownBlock { @MainActor in window.isHidden = true }
        try await until("the document, drawn") { document.textControllerForTesting?.lines.count == 12 }
        try await until("subscribed") { await computer.isSubscribed }
        return Opened(session: session, screen: document, window: window, navigation: navigation)
    }

    /// Milliseconds between keys: 0 for the tests, more when recording the demo
    /// (`TEST_RUNNER_DOCUMENT_DEMO_PACE_MS=70 xcodebuild test …`).
    private static let pace = Int(ProcessInfo.processInfo.environment["DOCUMENT_DEMO_PACE_MS"] ?? "") ?? 0

    private func type(_ text: String, into view: UITextView) async {
        for character in text {
            view.insertText(String(character))
            await pause(1)
        }
    }

    private func pause(_ keys: Int) async {
        guard Self.pace > 0 else { return }
        try? await Task.sleep(for: .milliseconds(Self.pace * keys))
    }

    func testOpensTypesWithShortcutsFormatsAndTicksATask() async throws {
        let computer = DocumentComputer(base: Self.seed())
        let opened = try await open(computer)
        let screen = opened.screen
        let textView = screen.textViewForTesting
        let controller = try XCTUnwrap(screen.textControllerForTesting)
        capture(opened.window, "document-light")
        XCTAssertEqual(textView.textStorage.string.components(separatedBy: "\n").first, "Release notes")
        XCTAssertEqual(screen.navigationItem.subtitle, Strings.Documents.saved)

        // Typing at the end of the last line, then a new line made a heading by "## ".
        textView.becomeFirstResponder()
        textView.selectedRange = NSRange(location: textView.textStorage.length - 1, length: 0)
        // The first keyboard of a run holds the screen for seconds; the demo waits it out.
        await pause(80)
        await type(" More.", into: textView)
        await type("\n", into: textView)
        XCTAssertEqual(controller.lines.count, 13)
        await type("## Next", into: textView)
        XCTAssertEqual(controller.lines[12].block.type, "heading")
        XCTAssertEqual(controller.lines[12].block.level, 2)
        XCTAssertEqual(controller.lines[12].block.plainText, "Next")
        await type("\n", into: textView)
        XCTAssertEqual(controller.lines[13].block.type, "paragraph", "Enter after a heading starts a paragraph")
        await type("- one", into: textView)
        XCTAssertEqual(controller.lines[13].block.type, "bulletListItem")
        await type("\n", into: textView)
        XCTAssertEqual(controller.lines[14].block.type, "bulletListItem", "Enter in a list continues it")
        await type("\n", into: textView)
        XCTAssertEqual(controller.lines[14].block.type, "paragraph", "Enter in an empty item leaves the list")
        await type("[] task", into: textView)
        XCTAssertEqual(controller.lines[14].block.type, "checkListItem")
        await type("\n", into: textView)
        textView.deleteBackward()
        XCTAssertEqual(controller.lines[15].block.type, "paragraph", "Backspace at an item's start unformats it")
        await type("a **bold** move", into: textView)
        XCTAssertEqual(controller.lines[15].block.runs, [DocumentRun("a "), DocumentRun("bold", marks: ["bold": .object([])]), DocumentRun(" move")])

        // The bar's italic over a selection.
        let start = textView.textStorage.length - 1 - 4
        textView.selectedRange = NSRange(location: start, length: 4)
        await pause(10)
        controller.run(.italic)
        XCTAssertEqual(controller.lines[15].block.runs.last, DocumentRun("move", marks: ["italic": .object([])]))
        XCTAssertTrue(controller.activeTools.contains(.italic))
        screen.toolbarForTesting.layoutIfNeeded()
        await pause(10)

        // The open task's box, found where it is drawn, ticks it.
        let id = controller.lines[2].id
        let point = try XCTUnwrap(Self.checkbox(in: textView, line: 2, controller: controller))
        XCTAssertEqual(textView.task(at: point), id)
        controller.toggle(id)
        XCTAssertTrue(controller.lines[2].block.checked)
        await pause(15)

        try await until("everything on the computer") {
            let markdown = await computer.markdown
            return markdown.contains("## Next") && markdown.contains("- [x] Ship the editor") && markdown.contains("a **bold** *move*") && screen.navigationItem.subtitle == Strings.Documents.saved
        }
        let markdown = await computer.markdown
        XCTAssertTrue(markdown.contains("- one"), markdown)
        XCTAssertTrue(markdown.contains("- [ ] task"), markdown)
        XCTAssertTrue(markdown.hasPrefix("# Release notes\n"), markdown)
        let lines = await computer.lines
        XCTAssertEqual(lines.map(\.block.type), controller.lines.map(\.block.type), "the computer reads what the phone shows")
        XCTAssertEqual(lines.map(\.block.plainText), controller.lines.map(\.block.plainText))
        textView.selectedRange = NSRange(location: 30, length: 0)
        try await Task.sleep(for: .milliseconds(400))
        capture(opened.window, "document-editing-light")
        textView.resignFirstResponder()
    }

    /// Where line `i`'s task box is drawn, in the text view.
    static func checkbox(in textView: DocumentTextView, line i: Int, controller: DocumentTextController) -> CGPoint? {
        guard let manager = textView.textLayoutManager, let content = manager.textContentManager,
              let location = content.location(content.documentRange.location, offsetBy: DocumentText.starts(controller.lines)[i]) else { return nil }
        manager.ensureLayout(for: NSTextRange(location: location))
        guard let fragment = manager.textLayoutFragment(for: location) as? DocumentLayoutFragment, let target = fragment.checkTarget else { return nil }
        return CGPoint(x: fragment.layoutFragmentFrame.minX + target.midX + textView.textContainerInset.left,
                       y: fragment.layoutFragmentFrame.minY + target.midY + textView.textContainerInset.top)
    }

    func testADesktopEditMergesWithoutMovingTheCaret() async throws {
        let computer = DocumentComputer(base: Self.seed())
        let opened = try await open(computer, style: .dark)
        let textView = opened.screen.textViewForTesting
        let controller = try XCTUnwrap(opened.screen.textControllerForTesting)
        textView.becomeFirstResponder()
        // The caret before "world", and a selection of "this" further on.
        let starts = DocumentText.starts(controller.lines)
        textView.selectedRange = NSRange(location: starts[1] + 6, length: 0)
        let before = controller.caret(at: textView.selectedRange.location)
        XCTAssertEqual(before, DocumentCaret(id: controller.lines[1].id, offset: 6))

        // Desktop types at the start of the same line, and deletes a line above.
        await computer.desktop { editor in
            let line = editor.lines[1]
            editor.setRuns(line.id, DocumentEdits.typing(line.block.runs, "Desktop says: ", replacing: 0..<0))
        }
        try await until("the desktop edit, shown") { controller.lines[1].block.plainText.hasPrefix("Desktop says: ") }
        XCTAssertEqual(controller.caret(at: textView.selectedRange.location), DocumentCaret(id: controller.lines[1].id, offset: 6 + 14), "the caret stayed before “world”")
        let after = (textView.textStorage.string as NSString).substring(with: NSRange(location: textView.selectedRange.location, length: 5))
        XCTAssertEqual(after, "world")

        // A selection holds too, while the line above it goes.
        let third = DocumentText.starts(controller.lines)[2]
        textView.selectedRange = NSRange(location: third + 5, length: 3)
        await computer.desktop { editor in editor.replaceLines(0..<1, with: []) }
        try await until("the heading gone") { controller.lines.count == 11 }
        let selected = (textView.textStorage.string as NSString).substring(with: textView.selectedRange)
        XCTAssertEqual(selected, "the", "“Ship the editor” keeps its selection")
        XCTAssertEqual(textView.textStorage.string, controller.lines.map { DocumentText.paragraph($0) + "\n" }.joined())

        // A peer's presence shows as a face and a cursor.
        let caret = try XCTUnwrap(controller.editor.relativePosition(DocumentCaret(id: controller.lines[0].id, offset: 3)))
        let state = DocumentPeer.state(name: "Steve", color: "#F98181", anchor: caret, head: caret)
        let frame: JSONValue = .object(["surfaceId": .string(DocumentComputer.surfaceId), "clientKey": .string("desktop"), "revision": .number(1), "active": .bool(true),
                                        "awarenessClientId": .number(4040), "update": .string(Data(YAwarenessState.encode([YAwarenessState(clientID: 4040, clock: 1, state: state)])).base64EncodedString())])
        await opened.session.engine.documents.streams.frame("document.presence", data: String(decoding: try JSONEncoder().encode(frame), as: UTF8.self))
        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "document-merge-dark")
        textView.resignFirstResponder()
        try await Task.sleep(for: .milliseconds(400))
        capture(opened.window, "document-dark")
    }

    func testAnOfflineEditIsKeptAndSentOnceOnReconnect() async throws {
        let computer = DocumentComputer(base: Self.seed())
        defer { NetworkPath.shared.force(nil) }
        NetworkPath.shared.force(true)
        let opened = try await open(computer)
        let screen = opened.screen
        let textView = screen.textViewForTesting
        let controller = try XCTUnwrap(screen.textControllerForTesting)
        let postedBefore = await computer.posted.count

        // Airplane mode: the stream drops, the edit stays on the phone.
        NetworkPath.shared.force(false)
        await computer.set(online: false)
        try await until("offline") { !opened.session.home.live }
        textView.becomeFirstResponder()
        textView.selectedRange = NSRange(location: DocumentText.starts(controller.lines)[5] - 1, length: 0)
        await type(" offline", into: textView)
        try await until("waiting to sync") { screen.navigationItem.subtitle == Strings.Documents.waiting }
        capture(opened.window, "document-offline")
        let heard = await computer.markdown
        XCTAssertFalse(heard.contains("Offline first offline"))

        // Back: the new stream subscribes, catches up, and the edit goes once.
        await computer.set(online: true)
        NetworkPath.shared.force(true)
        await opened.session.engine.reconnect()
        try await until("sent", 12) { await computer.markdown.contains("- Offline first offline") }
        try await until("saved") { screen.navigationItem.subtitle == Strings.Documents.saved }
        let posted = await computer.posted.dropFirst(postedBefore)
        XCTAssertEqual(Set(posted).count, posted.count, "no batch sent twice under new IDs")
        let lines = await computer.lines
        XCTAssertEqual(lines.map(\.block.plainText), controller.lines.map(\.block.plainText))
        textView.resignFirstResponder()
    }

    /// Typing and merging on a 10,000-word document: the main thread's
    /// share of a keystroke and of a remote change, written to
    /// `.context/evidence/latency.txt`.
    func testTypingLatencyOnALongDocument() async throws {
        let words = ["the", "editor", "keeps", "every", "block", "as", "it", "was", "written", "and", "merges", "changes", "from", "desktop", "without", "losing", "place"]
        let doc = YDoc(clientID: 9)
        let editor = DocumentEditor(doc: doc)
        var lines: [DocumentLine] = []
        var count = 0
        var i = 0
        while count < 10_000 {
            let length = 12 + (i % 9)
            let text = (0..<length).map { words[($0 + i) % words.count] }.joined(separator: " ")
            count += length
            let type = i % 10 == 0 ? "heading" : (i % 7 == 0 ? "bulletListItem" : "paragraph")
            lines.append(DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: type, props: type == "heading" ? ["level": .number(2)] : [:], content: .inline([DocumentRun(text)]))))
            i += 1
        }
        editor.replaceLines(0..<editor.lines.count, with: lines)
        let computer = DocumentComputer(base: doc.encodeStateAsUpdate())
        let started = ContinuousClock.now
        let credentialsOpened = try await openLong(computer, lines: lines.count)
        let openTime = ContinuousClock.now - started
        let textView = credentialsOpened.screen.textViewForTesting
        let controller = try XCTUnwrap(credentialsOpened.screen.textControllerForTesting)
        textView.becomeFirstResponder()
        textView.selectedRange = NSRange(location: DocumentText.starts(controller.lines)[lines.count / 2] + 10, length: 0)
        var keystrokes: [Double] = []
        var editorShare: [Double] = []
        for character in "typing in the middle of a long document" {
            let clock = ContinuousClock.now
            textView.insertText(String(character))
            keystrokes.append(Self.ms(ContinuousClock.now - clock))
            editorShare.append(Self.ms(controller.lastTyping))
        }
        var remotes: [Double] = []
        let third = lines.count / 3
        for n in 0..<20 {
            let clock = ContinuousClock.now
            let before = controller.lines[lines.count / 3].block.plainText
            await computer.desktop { editor in
                let line = editor.lines[third]
                editor.setRuns(line.id, DocumentEdits.typing(line.block.runs, "x", replacing: 0..<0))
            }
            try await until("remote \(n)") { controller.lines[lines.count / 3].block.plainText != before }
            _ = clock
            remotes.append(Self.ms(controller.lastApply))
        }
        func summary(_ values: [Double]) -> String {
            let sorted = values.sorted()
            return String(format: "p50 %.2f ms, p95 %.2f ms, max %.2f ms (n=%d)", sorted[sorted.count / 2], sorted[min(sorted.count - 1, sorted.count * 95 / 100)], sorted.last!, sorted.count)
        }
        let report = """
        10,000-word document: \(lines.count) blocks, \(count) words, \(textView.textStorage.length) UTF-16 units.
        Open (read, editor and text built off the main thread, installed): \(String(format: "%.0f", Self.ms(openTime))) ms
        Keystroke, whole main-thread cost (insertText → read back → Yjs write → paragraph check): \(summary(keystrokes))
          of which the editor's (read back → Yjs write → paragraph check): \(summary(editorShare))
        Remote change, main-thread apply (Yjs merge → changed lines → paragraph replaced): \(summary(remotes))
        """
        if let folder = Self.evidence { try? report.write(to: folder.appendingPathComponent("latency.txt"), atomically: true, encoding: .utf8) }
        print(report)
        XCTAssertLessThan(keystrokes.sorted()[keystrokes.count / 2], 8.3, "a keystroke within a 120 Hz frame")
        XCTAssertLessThan(remotes.sorted()[remotes.count / 2], 4.2)
        textView.resignFirstResponder()
    }

    private func openLong(_ computer: DocumentComputer, lines: Int) async throws -> Opened {
        let credentials = InMemoryAgentConnectionCredentialStore()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("document-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentConnectionCredentialStore: credentials,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: OfflineRelay(), connector: OfflineSockets()
        )
        await account.agentConnections.setForeground(false)
        let pairing = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"document-long","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in Session.forget(pairing.id) }
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: AppContext(account: account, variant: .preview, version: "test")))
        await session.engine.start()
        try await until("live") { session.home.live }
        let screen = DocumentViewController(session: session, surfaceId: DocumentComputer.surfaceId, name: "Long")
        let navigation = UINavigationController(rootViewController: screen)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true }
        try await until("the long document, drawn", 15) { screen.textControllerForTesting?.lines.count == lines }
        try await until("subscribed") { await computer.isSubscribed }
        return Opened(session: session, screen: screen, window: window, navigation: navigation)
    }

    static func ms(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
    }
}
#endif
