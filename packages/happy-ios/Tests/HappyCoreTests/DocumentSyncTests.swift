import Foundation
import HappyWire
@testable import HappyCore
import XCTest

/// `DocumentSync` against a daemon that keeps documents as the real one
/// does (`SurfaceDocuments.change`): one Yjs replica, a change log with
/// mutation IDs, live frames to every subscribed stream.
final class DocumentSyncTests: XCTestCase {
    actor Daemon: AgentTransport {
        let surfaceId: String
        let doc = YDoc(clientID: 1)
        private(set) var seq = 0
        private(set) var mutations: [String: Int] = [:]
        private(set) var posted: [String] = []
        private(set) var presence: [[UInt8]] = []
        private(set) var subscribed: Set<String> = []
        var online = true
        /// The next update is stored but its answer lost.
        var loseNextAnswer = false
        var refuseUpdates = false
        var streams: DocumentStreams?

        init(surfaceId: String, base: [UInt8]) throws {
            self.surfaceId = surfaceId
            try doc.applyUpdate(base)
        }

        func setOnline(_ value: Bool) { online = value }
        func loseAnswer() { loseNextAnswer = true }
        func setStreams(_ streams: DocumentStreams) { self.streams = streams }
        var markdown: String { DocumentMarkdown.markdown(DocumentReader.blocks(doc)) }

        /// A change from desktop: applied and sent to every subscriber.
        func remote(_ update: [UInt8]) async throws {
            try doc.applyUpdate(update)
            seq += 1
            await broadcast(update, mutationId: nil)
        }

        private func broadcast(_ update: [UInt8], mutationId: String?) async {
            guard let streams, !subscribed.isEmpty else { return }
            let frame: JSONValue = .object([
                "surfaceId": .string(surfaceId), "seq": .number(Double(seq)), "update": .string(Data(update).base64EncodedString()),
                "mutationId": mutationId.map(JSONValue.string) ?? .null, "actor": .object(["userId": .null, "agentId": .null]), "source": .string("api"),
            ])
            await streams.frame("document.update", data: String(decoding: try! JSONEncoder().encode(frame), as: UTF8.self))
        }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            guard online else { throw PairingError.unavailable }
            let base = "/v0/surfaces/document/\(surfaceId)"
            let json = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
            func answer(_ value: JSONValue) -> HTTP1Response { HTTP1Response(status: 200, body: try! JSONEncoder().encode(value)) }
            let (route, query) = { () -> (String, String) in
                let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
                return (parts[0], parts.count > 1 ? parts[1] : "")
            }()
            switch (method, route) {
            case ("GET", base + "/state"):
                var since: [Int: Int] = [:]
                if let raw = query.split(separator: "&").first(where: { $0.hasPrefix("stateVector=") })?.dropFirst(12),
                   let bytes = Data(base64Encoded: String(raw).removingPercentEncoding ?? "") {
                    since = try YDoc.decodeStateVector(Array(bytes))
                }
                return answer(.object([
                    "seq": .number(Double(seq)),
                    "update": .string(Data(doc.encodeStateAsUpdate(since: since)).base64EncodedString()),
                    "stateVector": .string(Data(YDoc.encodeStateVector(doc.stateVector())).base64EncodedString()),
                ]))
            case ("POST", base + "/updates"):
                let id = json!["mutationId"]!.stringValue!
                posted.append(id)
                if refuseUpdates { return HTTP1Response(status: 400, body: Data(#"{"error":"no","code":"invalid_request"}"#.utf8)) }
                if let seq = mutations[id] { return answer(.object(["seq": .number(Double(seq))])) }
                let update = Array(Data(base64Encoded: json!["update"]!.stringValue!)!)
                let before = doc.stateVector()
                try doc.applyUpdate(update)
                XCTAssertFalse(doc.hasPending, "a change the daemon can't place")
                if doc.stateVector() != before || !update.isEmpty {
                    seq += 1
                    mutations[id] = seq
                    await broadcast(update, mutationId: id)
                }
                if loseNextAnswer { loseNextAnswer = false; throw PairingError.unavailable }
                return answer(.object(["seq": .number(Double(seq))]))
            case ("POST", base + "/subscribe"):
                subscribed.insert(json!["streamId"]!.stringValue!)
                return answer(.object(["seq": .number(Double(seq))]))
            case ("POST", base + "/unsubscribe"):
                subscribed.remove(json!["streamId"]!.stringValue!)
                return answer(.object([:]))
            case ("POST", base + "/presence"):
                presence.append(Array(Data(base64Encoded: json!["update"]!.stringValue!)!))
                return answer(.object([:]))
            default:
                return HTTP1Response(status: 404)
            }
        }

        func browserConnection() async throws -> any BrowserStream { throw PairingError.unavailable }
        func close() async {}
    }

    var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("document-sync-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    static let base = DocumentEditorTests.fixture("desktop-short")
    static let surfaceId = "doc1"

    /// An editor wired to its sync as the screen wires them.
    @discardableResult
    static func attach(_ sync: DocumentSync) async throws -> DocumentEditor {
        let made = await sync.editor()
        let handoff = try XCTUnwrap(made)
        let editor = handoff.editor
        let local = sync.local
        editor.onLocalUpdate = { local.yield($0) }
        return editor
    }

    static func eventually(_ timeout: Duration = .seconds(5), _ condition: () async -> Bool) async -> Bool {
        let end = ContinuousClock.now + timeout
        while ContinuousClock.now < end {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await condition()
    }

    static func type(_ editor: DocumentEditor, _ text: String, line: Int = 1) {
        for character in text {
            let block = editor.lines[line].block
            editor.setRuns(block.id, [DocumentRun(block.plainText + String(character))])
        }
    }

    func testTypingGoesOutInBatchesAndEndsSaved() async throws {
        let daemon = try Daemon(surfaceId: Self.surfaceId, base: Self.base)
        let library = DocumentLibrary(client: AgentClient(transport: daemon, token: "t"), directory: directory)
        await daemon.setStreams(library.streams)
        await library.opened(.object(["streamId": .string("s1")]))
        let sync = await library.document(Self.surfaceId)
        let opening = await sync.start()
        XCTAssertEqual(opening, .ready)
        let editor = try await Self.attach(sync)
        let subscribed = await Self.eventually { await daemon.subscribed.contains("s1") }
        XCTAssertTrue(subscribed)
        Self.type(editor, " and more words typed quickly")
        let expected = DocumentMarkdown.markdown(editor.blocks)
        let saved = await Self.eventually {
            let state = await sync.saveState
            let markdown = await daemon.markdown
            return state == .saved && markdown == expected
        }
        XCTAssertTrue(saved)
        let posts = await sync.posts
        XCTAssertLessThan(posts, 10, "29 keystrokes, a few batches at most 200 ms apart")
        let ids = await daemon.posted
        XCTAssertEqual(Set(ids).count, ids.count, "every batch its own mutation")
    }

    func testRemoteChangesReachTheEditorOnce() async throws {
        let daemon = try Daemon(surfaceId: Self.surfaceId, base: Self.base)
        let library = DocumentLibrary(client: AgentClient(transport: daemon, token: "t"), directory: directory)
        await daemon.setStreams(library.streams)
        await library.opened(.object(["streamId": .string("s1")]))
        let sync = await library.document(Self.surfaceId)
        _ = await sync.start()
        let events = await sync.events()
        let editor = try await Self.attach(sync)
        _ = await Self.eventually { await daemon.subscribed.contains("s1") }
        // Desktop types at the start of the second line.
        let desktop = YDoc(clientID: 4040)
        try desktop.applyUpdate(Self.base)
        let desktopEditor = DocumentEditor(doc: desktop)
        var sent: [UInt8] = []
        desktopEditor.onLocalUpdate = { sent = $0 }
        desktopEditor.setRuns(desktopEditor.lines[1].id, [DocumentRun("Desktop: " + desktopEditor.lines[1].block.plainText)])
        try await daemon.remote(sent)
        var remote: [[UInt8]] = []
        for await event in events {
            if case let .remote(update) = event { remote.append(update); break }
        }
        XCTAssertEqual(remote, [sent])
        try editor.apply(remote: remote[0])
        XCTAssertTrue(editor.lines[1].block.plainText.hasPrefix("Desktop: "))
    }

    func testOfflineEditsSurviveARelaunchAndGoOutOnceOnReconnect() async throws {
        let daemon = try Daemon(surfaceId: Self.surfaceId, base: Self.base)
        let client = AgentClient(transport: daemon, token: "t")
        var library = DocumentLibrary(client: client, directory: directory)
        await daemon.setStreams(library.streams)
        await library.opened(.object(["streamId": .string("s1")]))
        var sync = await library.document(Self.surfaceId)
        _ = await sync.start()
        var editor = try await Self.attach(sync)
        _ = await Self.eventually { await daemon.subscribed.contains("s1") }
        // Airplane mode.
        await daemon.setOnline(false)
        await library.closed()
        Self.type(editor, " offline")
        let waiting = await Self.eventually {
            let state = await sync.saveState
            let kept = await sync.kept
            return state == .waiting && kept == 8
        }
        XCTAssertTrue(waiting, "a keystroke reaches the disk a moment after it is typed")
        let expected = DocumentMarkdown.markdown(editor.blocks)
        // Killed: nothing shut down, a new library over the same folder.
        library = DocumentLibrary(client: client, directory: directory)
        await daemon.setStreams(library.streams)
        sync = await library.document(Self.surfaceId)
        _ = await sync.start()
        editor = try await Self.attach(sync)
        XCTAssertEqual(DocumentMarkdown.markdown(editor.blocks), expected, "opens from disk with the offline edit")
        let stillWaiting = await sync.saveState
        XCTAssertEqual(stillWaiting, .waiting)
        // Back online; the first answer is lost after the daemon stored it.
        await daemon.setOnline(true)
        await daemon.loseAnswer()
        await library.opened(.object(["streamId": .string("s2")]))
        let saved = await Self.eventually { await sync.saveState == .saved }
        XCTAssertTrue(saved)
        let markdown = await daemon.markdown
        XCTAssertEqual(markdown, expected)
        let posted = await daemon.posted
        XCTAssertEqual(posted.count, 2, "sent, answer lost, sent again")
        XCTAssertEqual(Set(posted).count, 1, "under the same mutation ID")
        let seq = await daemon.seq
        XCTAssertEqual(seq, 1, "stored once")
    }

    func testAnUnsentDocumentNoEditorHoldsIsSentWhenTheStreamReturns() async throws {
        let daemon = try Daemon(surfaceId: Self.surfaceId, base: Self.base)
        let client = AgentClient(transport: daemon, token: "t")
        var library = DocumentLibrary(client: client, directory: directory)
        let sync = await library.document(Self.surfaceId)
        _ = await sync.start()
        let editor = try await Self.attach(sync)
        Self.type(editor, "!")
        _ = await Self.eventually { await sync.saveState == .waiting }
        await sync.release()
        let expected = DocumentMarkdown.markdown(editor.blocks)
        library = DocumentLibrary(client: client, directory: directory)
        await daemon.setStreams(library.streams)
        await library.opened(.object(["streamId": .string("s3")]))
        let sent = await Self.eventually { await daemon.markdown == expected }
        XCTAssertTrue(sent)
        let retired = await Self.eventually { await library.open.isEmpty }
        XCTAssertTrue(retired, "let go of once saved")
    }

    func testPresenceGoesOutSpacedAndPeersComeIn() async throws {
        let daemon = try Daemon(surfaceId: Self.surfaceId, base: Self.base)
        let library = DocumentLibrary(client: AgentClient(transport: daemon, token: "t"), directory: directory)
        await library.opened(.object(["streamId": .string("s1")]))
        let sync = await library.document(Self.surfaceId)
        _ = await sync.start()
        let events = await sync.events()
        let editor = try await Self.attach(sync)
        _ = await Self.eventually { await daemon.subscribed.contains("s1") }
        let caret = try XCTUnwrap(editor.relativePosition(DocumentCaret(id: editor.lines[1].id, offset: 2)))
        for name in ["a", "b", "c", "d"] { sync.presence.yield(DocumentPeer.state(name: name, color: "#123456", anchor: caret, head: caret)) }
        let sentLast = await Self.eventually {
            let last = await daemon.presence.last.flatMap { try? YAwarenessState.decode($0) }
            return last?.first?.state?["user"]?["name"]?.stringValue == "d"
        }
        XCTAssertTrue(sentLast)
        let count = await daemon.presence.count
        XCTAssertLessThanOrEqual(count, 2, "coalesced to the spacing")

        let fixture = DocumentCursorTests.object["presence"] as! [String: Any]
        let frame: JSONValue = .object(["surfaceId": .string(Self.surfaceId), "clientKey": .string("k1"), "revision": .number(1), "active": .bool(true),
                                        "awarenessClientId": .number(31337), "update": .string(fixture["update"] as! String)])
        await library.frame("document.presence", data: String(decoding: try JSONEncoder().encode(frame), as: UTF8.self))
        var peers: [DocumentPeer] = []
        for await event in events { if case let .peers(list) = event { peers = list; break } }
        XCTAssertEqual(peers.map(\.name), ["Steve"])
        XCTAssertEqual(peers.first?.color, "#ff6b6b")
        XCTAssertEqual(peers.first?.anchor?.item, YID(client: 4242, clock: 6))
        // Gone: an inactive frame with a newer revision.
        let leave: JSONValue = .object(["surfaceId": .string(Self.surfaceId), "clientKey": .string("k1"), "revision": .number(2), "active": .bool(false)])
        await library.frame("document.presence", data: String(decoding: try JSONEncoder().encode(leave), as: UTF8.self))
        for await event in events { if case let .peers(list) = event { peers = list; break } }
        XCTAssertEqual(peers, [])
    }
}
