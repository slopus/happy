import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// What an agent's turn showed the person, as desktop's transcript keeps it
/// (`happyAgentConnectGroupProject`, `conversationMediaRuns`): the pictures
/// sent with a message, and each call's pictures, recordings, files and
/// artifact as a row of its own, its line over what it showed, which stays
/// when the turn folds.
final class AgentMediaTests: XCTestCase {
    /// A picture as the daemon presents one an agent read (Steve's history:
    /// `Read` of a PNG, a 2-column layout).
    static func picture(_ name: String, width: Double = 1228, height: Double = 550) -> JSONValue {
        .object([
            "kind": .string("image"), "name": .string(name), "mimeType": .string("image/png"), "size": .number(179_115),
            "width": .number(width), "height": .number(height), "thumbhash": .string("xgcCA4AnNsaAeSlmd3/+XGU="),
            "source": .object(["path": .string("/w/\(name)"), "absolutePath": .string("/w/\(name)")]),
        ])
    }

    static func video(_ name: String) -> JSONValue {
        .object(["kind": .string("video"), "name": .string(name), "mimeType": .string("video/mp4"), "size": .number(8_400_000)])
    }

    static func document(_ name: String) -> JSONValue {
        .object(["kind": .string("document"), "name": .string(name), "mimeType": .string("application/pdf"), "size": .number(120_000)])
    }

    static let twoColumns: JSONValue = .object(["type": .string("columns"), "columns": .number(2)])

    static func media(_ items: [JSONValue], layout: JSONValue? = nil) -> [String: JSONValue] {
        var presentation: [String: JSONValue] = ["type": .string("media"), "items": .array(items)]
        if let layout { presentation["layout"] = layout }
        return presentation
    }

    static func read(_ id: String, _ file: String) -> JSONValue {
        TurnServer.call(id, "Read", presentation: media([picture(file)], layout: twoColumns))
    }

    static let pixel = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

    /// One finished run: the person's words and a photo, then the agent's
    /// work, every kind of thing a call shows, and its answer.
    static func run(ended: Bool = true) -> JSONValue {
        let user = TurnServer.message("u-r", role: "user", content: [
            .object(["type": .string("text"), "text": .string("What do you see?")]),
            .object(["type": .string("image"), "mimeType": .string("image/png"), "data": .string(pixel.base64EncodedString())]),
        ])
        let agent = TurnServer.message("m-r", role: "agent", content: [
            .object(["type": .string("text"), "text": .string("Looking at the screenshots.")]),
            read("t-read-1", "before.png"),
            TurnServer.call("t-ls", "Glob", presentation: ["type": .string("exploration"), "operations": .array([.object(["kind": .string("search"), "command": .string("Glob *.png")])])]),
            read("t-read-2", "after.png"),
            TurnServer.call("t-run", "exec_command", presentation: ["type": .string("exec_command"), "command": .string("make video")]),
            TurnServer.call("t-show", "present_files", presentation: media([video("demo.mp4"), picture("a.png"), picture("b.png"), picture("c.png"), document("notes.pdf")])),
            TurnServer.call("t-gen", "codex_imagegen", presentation: media([picture("generated.png", width: 1024, height: 1024)])),
            TurnServer.call("t-art", "create_artifact", presentation: [
                "type": .string("artifact"), "artifactId": .string("art1"), "version": .number(1), "artifactType": .string("html"), "title": .string("Report"),
            ]),
            .object(["type": .string("text"), "text": .string("Both screenshots show the new header.")]),
        ])
        var run: [String: JSONValue] = ["id": .string("r"), "status": .string(ended ? "completed" : "running"), "startedAt": .number(1_000), "messages": .array([user, agent])]
        if ended { run["endedAt"] = .number(13_000); run["reason"] = .string("completed") }
        return .object(run)
    }

    private func open(_ server: TurnServer) async -> (Conversation, SyncEngine, AsyncStream<ChatSnapshot>.AsyncIterator) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        let updates = conversation.updates.makeAsyncIterator()
        await conversation.start()
        return (conversation, engine, updates)
    }

    private func next(_ updates: inout AsyncStream<ChatSnapshot>.AsyncIterator, until: (ChatSnapshot) -> Bool) async throws -> ChatSnapshot {
        while let snapshot = await updates.next() {
            if snapshot.loaded, until(snapshot) { return snapshot }
        }
        return try XCTUnwrap(nil as ChatSnapshot?, "the conversation ended first")
    }

    private func item(_ id: String, in items: [ChatItem], file: StaticString = #filePath, line: UInt = #line) throws -> ChatItem {
        try XCTUnwrap(items.first { $0.id == id }, "no \(id)", file: file, line: line)
    }

    private func gallery(_ item: ChatItem) -> (media: [Media], columns: Int)? {
        for piece in item.pieces { if case .gallery(let media, let columns) = piece { return (media, columns) } }
        return nil
    }

    // MARK: Decoding

    /// Every kind a turn shows is read from the wire: the person's photo
    /// inline; each call that showed something its own row, its line's
    /// presentation kept, what it showed its pieces; the words around them
    /// rows of their own.
    func testEveryKindOfMediaIsReadAsItsOwnRow() async throws {
        var (conversation, _, updates) = await open(TurnServer(runs: [Self.run()]))
        let snapshot = try await next(&updates) { $0.items.contains { $0.id == "r:status" } }
        XCTAssertEqual(snapshot.items.map(\.id), [
            "u-r", "m-r", "t-read-1", "t-ls", "t-read-2", "t-run", "t-show", "t-gen", "t-art", "m-r/8", "r:status",
        ])

        let user = try item("u-r", in: snapshot.items)
        XCTAssertEqual(user.role, .user)
        XCTAssertEqual(user.pieces, [.text("What do you see?"), .picture(id: "u-r:1", mimeType: "image/png", data: Self.pixel)])

        // A read picture: Read's line, its picture under it, in the columns asked.
        let read = try item("t-read-1", in: snapshot.items)
        guard case .tool(let tool) = read.role else { return XCTFail("not a tool row") }
        XCTAssertEqual(tool.name, "Read")
        XCTAssertEqual(tool.presentation?.type, "media")
        XCTAssertTrue(tool.isResult)
        let shown = try XCTUnwrap(gallery(read))
        XCTAssertEqual(shown.columns, 2)
        XCTAssertEqual(shown.media.map(\.key), ["tool/t-read-1/0"])
        XCTAssertEqual(shown.media.first?.item.width, 1228)
        XCTAssertEqual(shown.media.first?.item.thumbhash, "xgcCA4AnNsaAeSlmd3/+XGU=")

        // Presented files: the recording and pictures as one flow (no layout:
        // justified rows), the document as its card, in the order presented.
        let presented = try item("t-show", in: snapshot.items)
        XCTAssertEqual(presented.pieces.count, 2)
        let flow = try XCTUnwrap(gallery(presented))
        XCTAssertEqual(flow.columns, 0)
        XCTAssertEqual(flow.media.map(\.key), ["tool/t-show/0", "tool/t-show/1", "tool/t-show/2", "tool/t-show/3"])
        XCTAssertEqual(flow.media.map(\.isVideo), [true, false, false, false])
        guard case .file(let document) = presented.pieces[1] else { return XCTFail("no document card") }
        XCTAssertEqual(document.key, "tool/t-show/4")

        let generated = try XCTUnwrap(gallery(try item("t-gen", in: snapshot.items)))
        XCTAssertEqual(generated.media.map(\.item.name), ["generated.png"])

        let artifact = try item("t-art", in: snapshot.items)
        XCTAssertEqual(artifact.pieces, [.artifact(Artifact(id: "art1", version: 1, type: "html", title: "Report", followsLatest: false))])

        // Calls that showed nothing are lines; the words stay the agent's.
        XCTAssertEqual(try item("t-ls", in: snapshot.items).pieces, [])
        XCTAssertEqual(try item("m-r", in: snapshot.items).pieces, [.text("Looking at the screenshots.")])
        XCTAssertEqual(try item("m-r/8", in: snapshot.items).role, .agent)
        guard case .turnEnd(let ended) = try item("r:status", in: snapshot.items).role else { return XCTFail("no status") }
        XCTAssertEqual(ended.tools, 7)
        XCTAssertEqual(ended.copyText, "Both screenshots show the new header.")

        // Shared media reads the calls' pieces too.
        let shared = Shared.of(items: snapshot.items)
        XCTAssertEqual(Set(shared.media.map(\.key)), [
            "sent/u-r#0", "tool/t-read-1/0", "tool/t-read-2/0", "tool/t-show/0", "tool/t-show/1", "tool/t-show/2", "tool/t-show/3", "tool/t-show/4", "tool/t-gen/0",
        ])
        await conversation.stop()
    }

    /// Running, every call shows what it showed where it ran; the two reads
    /// a search apart are one grid under the second.
    func testALiveTurnShowsItsMediaAndJoinsReadsIntoOneGrid() async throws {
        var (conversation, _, updates) = await open(TurnServer(runs: [Self.run(ended: false)]))
        let snapshot = try await next(&updates) { $0.items.contains { $0.id == "t-art" } }
        let shown = TurnFold.fold(snapshot.items, expanded: [])
        XCTAssertEqual(shown.map(\.id), ["u-r", "m-r", "t-read-1", "t-ls", "t-read-2", "t-run", "t-show", "t-gen", "t-art", "m-r/8"], "a running turn folds nothing")
        XCTAssertEqual(try item("t-read-1", in: shown).pieces, [], "its picture is drawn under the run's last read")
        let grid = try XCTUnwrap(gallery(try item("t-read-2", in: shown)))
        XCTAssertEqual(grid.columns, 2)
        XCTAssertEqual(grid.media.map(\.key), ["tool/t-read-1/0", "tool/t-read-2/0"])
        // The command between the reads and the presented files ends the run.
        XCTAssertEqual(try item("t-show", in: shown).pieces.count, 2)
        XCTAssertEqual(try item("t-gen", in: shown).pieces.count, 1)
        await conversation.stop()
    }

    /// Folded, the turn keeps every call that showed something, as desktop
    /// does; the command and the search fold away, and the reads, now next
    /// to each other, are still one grid.
    func testAFoldedTurnKeepsWhatItShowed() async throws {
        var (conversation, _, updates) = await open(TurnServer(runs: [Self.run()]))
        let snapshot = try await next(&updates) { $0.items.contains { $0.id == "r:status" } }
        let folded = TurnFold.fold(snapshot.items, expanded: [])
        XCTAssertEqual(folded.map(\.id), ["u-r", "t-read-1", "t-read-2", "t-show", "t-gen", "t-art", "r:trace", "m-r/8", "r:status"])
        XCTAssertEqual(folded.first { $0.id == "r:trace" }?.role, .trace(.init(turn: "r", open: false, tools: 7)))
        XCTAssertEqual(try item("u-r", in: folded).pieces.count, 2, "the person's photo stays")
        XCTAssertEqual(try XCTUnwrap(gallery(try item("t-read-2", in: folded))).media.map(\.key), ["tool/t-read-1/0", "tool/t-read-2/0"])
        XCTAssertEqual(try XCTUnwrap(gallery(try item("t-show", in: folded))).media.count, 4)
        XCTAssertEqual(try item("t-art", in: folded).pieces.count, 1)

        // Opened, every step is back and the reads are a search apart: still one grid.
        let opened = TurnFold.fold(snapshot.items, expanded: ["r"])
        XCTAssertEqual(opened.map(\.id), ["u-r", "r:trace", "m-r", "t-read-1", "t-ls", "t-read-2", "t-run", "t-show", "t-gen", "t-art", "m-r/8", "r:status"])
        XCTAssertEqual(try XCTUnwrap(gallery(try item("t-read-2", in: opened))).media.count, 2)
        await conversation.stop()

        // Read again on another launch: the same rows.
        var (again, _, later) = await open(TurnServer(runs: [Self.run()]))
        let reloaded = try await next(&later) { $0.items.contains { $0.id == "r:status" } }
        XCTAssertEqual(TurnFold.fold(reloaded.items, expanded: []), folded)
        await again.stop()
    }

    // MARK: Runs

    private func shows(_ id: String, _ kinds: [String], columns: Int = 2, type: String = "media") -> ChatItem {
        let media = kinds.enumerated().map { offset, kind in
            Media(toolCallId: id, index: offset, item: AgentWire.MediaItem(kind: kind, name: "\(id)-\(offset)", mimeType: kind == "image" ? "image/png" : "video/mp4"))
        }
        return ChatItem(id: id, role: .tool(.init(name: "Read", status: "completed", presentation: AgentWire.Presentation(type: type))), pieces: [.gallery(media, columns: columns)], delivery: .sent)
    }

    private func line(_ id: String, _ type: String) -> ChatItem {
        ChatItem(id: id, role: .tool(.init(name: "x", status: "completed", presentation: AgentWire.Presentation(type: type))), pieces: [], delivery: .sent)
    }

    /// Desktop's runs: pictures in the same columns, an exploration passed
    /// over; another column count, a recording or anything else ends one.
    func testRunsAreDesktops() {
        let items = [
            shows("a", ["image"]), line("x", "exploration"), shows("b", ["image", "image"]),
            shows("c", ["image"], columns: 1), shows("d", ["image"], columns: 1),
            shows("e", ["video"]), shows("f", ["image"]),
            line("g", "exec_command"), shows("h", ["image"]),
            shows("i", ["image"], columns: 0), shows("j", ["image"], columns: 0),
        ]
        let joined = MediaRuns.join(items)
        func keys(_ id: String) -> [String] {
            guard case .gallery(let media, _)? = joined.first(where: { $0.id == id })?.pieces.first else { return [] }
            return media.map(\.key)
        }
        XCTAssertEqual(keys("a"), [])
        XCTAssertEqual(keys("b"), ["tool/a/0", "tool/b/0", "tool/b/1"])
        XCTAssertEqual(keys("c"), [])
        XCTAssertEqual(keys("d"), ["tool/c/0", "tool/d/0"])
        guard case .gallery(_, let columns)? = joined.first(where: { $0.id == "d" })?.pieces.first else { return XCTFail("no grid") }
        XCTAssertEqual(columns, 1)
        // A recording ends a run; a run of one is none.
        XCTAssertEqual(keys("e"), ["tool/e/0"])
        XCTAssertEqual(keys("f"), ["tool/f/0"])
        XCTAssertEqual(keys("h"), ["tool/h/0"])
        // No columns asked: each call its own flow.
        XCTAssertEqual(keys("i"), ["tool/i/0"])
        XCTAssertEqual(keys("j"), ["tool/j/0"])
    }
}
