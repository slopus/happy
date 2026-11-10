import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Chat UI as a conversation reads, draws and presses it: blocks and
/// presentations, components as pieces, quick replies, and the
/// `default_model` card with its attempts. The contract's own vectors are
/// `ChatUiContractTests`.
final class ChatUiTests: XCTestCase {
    // MARK: Blocks

    func testActionBlocksUiAndQuickRepliesReadAndKeep() throws {
        let json = #"""
        {"id":"m","role":"agent","createdAt":1,"content":[
          {"type":"action","messageId":"a1","uiId":"u1","componentId":"model","action":{"type":"default_model.set","payload":{"providerId":"claude","modelId":"opus","effort":"high"}},"outcome":{"status":"rejected","code":"not_allowed","reason":"Only an owner can change the default model."}},
          {"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u2","components":[{"id":"x","type":"slideshow","fallback":"Slides","props":{}}]},"items":[]}},
          {"type":"ui","ui":{"components":[]}},
          {"type":"action","messageId":"a1"},
          {"type":"quick_replies","options":"Yes"},
          {"type":"quick_replies","options":["Yes","Not now"],"ui":[{"type":"provider","props":{"provider":"claude"}},null]},
          {"type":"tool_call","id":"c2","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Fix it"],"ui":[null]}}
        ]}
        """#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        guard case .action(let block) = message.content[0] else { return XCTFail("no action") }
        XCTAssertEqual(block.offer, UiOffer(messageId: "a1", uiId: "u1", componentId: "model"))
        XCTAssertEqual(block.outcome, UiOutcome(status: "rejected", code: "not_allowed", reason: "Only an owner can change the default model."))
        guard case .toolCall(_, _, _, let presentation, _, _, _, _) = message.content[1] else { return XCTFail("no call") }
        XCTAssertEqual(presentation?.ui?.components.first?.type, "slideshow")
        // A block that can't be read is skipped, never the message.
        XCTAssertEqual(Array(message.content[2...4]), [.unknown("ui"), .unknown("action"), .unknown("quick_replies")])
        // An option's own `ui` isn't read: the words alone.
        XCTAssertEqual(message.content[5], .quickReplies(["Yes", "Not now"]))
        guard case .toolCall(_, _, _, let suggested, _, _, _, _) = message.content[6] else { return XCTFail("no call") }
        XCTAssertEqual(suggested?.options, ["Fix it"])
        XCTAssertNil(suggested?.ui)
        let kept = try JSONDecoder().decode(AgentWire.Message.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(kept.content, message.content)
        let reply = try JSONDecoder().decode(AgentWire.Message.self, from: Data(#"{"id":"u","role":"user","createdAt":2,"content":[],"quickReply":{"messageId":"m","toolCallId":"c2","index":0}}"#.utf8))
        XCTAssertEqual(reply.quickReply, QuickReply(messageId: "m", toolCallId: "c2", index: 0))
    }

    // MARK: Pieces

    private let offer = UiOffer(messageId: "a1", uiId: "u1", componentId: "c")

    private func component(_ type: String, _ props: JSONValue, fallback: String = "Fallback") -> UiComponent {
        UiComponent(id: "c", type: type, fallback: fallback, props: props)
    }

    private func kind(_ type: String, _ props: JSONValue, fallback: String = "Fallback") -> UiShown.Kind? {
        guard case .ui(let shown)? = UiShown.pieces(component(type, props, fallback: fallback), document: "u1", message: "a1", media: []).first else { return nil }
        return shown.kind
    }

    func testATypeThePhoneDoesntDrawIsItsFallbackLine() {
        for type in ["provider_sign_in", "phone_app", "invite", "slideshow"] {
            XCTAssertEqual(kind(type, .object(["provider": .string("claude")])), .line("Fallback"), type)
        }
        XCTAssertEqual(kind("slideshow", .object([:]), fallback: "  Three slides \n"), .line("Three slides"))
        // With no fallback there is nothing to draw.
        XCTAssertEqual(UiShown.pieces(component("slideshow", .object([:]), fallback: " "), document: "u1", message: "a1", media: []), [])
    }

    func testAKnownTypeWhosePropsDontFitIsItsFallbackLine() {
        XCTAssertEqual(kind("file_tree", .object(["paths": .array([.string("a.txt")])])), .fileTree([.init(depth: 0, name: "a.txt", folder: false)]))
        XCTAssertEqual(kind("file_tree", .object(["paths": .array([])])), .line("Fallback"))
        XCTAssertEqual(kind("file_tree", .object(["paths": .array([.string("a.txt"), .number(1)])])), .line("Fallback"))
        XCTAssertEqual(kind("file_tree", .object(["paths": .array([.string("a\u{7}.txt")])])), .line("Fallback"))
        XCTAssertEqual(kind("file_tree", .object(["paths": .array([.string("a.txt")]), "root": .string("/")])), .line("Fallback"))
        XCTAssertEqual(kind("default_model", .object([:])), .defaultModel)
        XCTAssertEqual(kind("default_model", .object(["provider": .string("claude")])), .line("Fallback"))
        XCTAssertEqual(UiShown.pieces(component("default_model", .object([:])), document: "u1", message: "a1", media: []),
                       [.ui(UiShown(offer: offer, type: "default_model", kind: .defaultModel, fallback: "Fallback"))])
    }

    func testMediaIsTheCallsItemsInRowsWithTheirLabels() {
        let item = AgentWire.MediaItem(kind: "image", name: "a.png", mimeType: "image/png")
        let media = (0..<3).map { Media(toolCallId: "call", index: $0, item: item) }
        func pieces(_ items: [JSONValue], extra: [String: JSONValue] = [:]) -> [ChatItem.Piece] {
            UiShown.pieces(component("media", .object(["items": .array(items)].merging(extra) { $1 })), document: "u1", message: "a1", media: media)
        }
        let line: [ChatItem.Piece] = [.ui(UiShown(offer: offer, type: "media", kind: .line("Fallback"), fallback: "Fallback"))]
        XCTAssertEqual(pieces([.object(["mediaIndex": .number(2), "label": .string("Login")]), .object(["mediaIndex": .number(0)])]), [.mediaRows([media[2], media[0]], labels: ["Login", nil])])
        // An index past the call's items: the fallback, never a hole.
        XCTAssertEqual(pieces([.object(["mediaIndex": .number(5)])]), line)
        // Props that don't fit: a blank label, a fraction, a layout of the model's.
        XCTAssertEqual(pieces([.object(["mediaIndex": .number(0), "label": .string("")])]), line)
        XCTAssertEqual(pieces([.object(["mediaIndex": .number(0.5)])]), line)
        XCTAssertEqual(pieces([.object(["mediaIndex": .number(0)])], extra: ["columns": .number(2)]), line)
        XCTAssertEqual(pieces([]), line)
        // A `ui` block has no media items of its own.
        XCTAssertEqual(UiShown.pieces(component("media", .object(["items": .array([.object(["mediaIndex": .number(0)])])])), document: "u1", message: "a1", media: []), line)
    }

    func testAFileTreeIsItsFoldersOnceBeforeWhatIsInThem() {
        XCTAssertEqual(UiFileTree.rows(["src/app/main.ts", "src/app/util.ts", "README.md", "src/lib/"]), [
            .init(depth: 0, name: "src", folder: true), .init(depth: 1, name: "app", folder: true),
            .init(depth: 2, name: "main.ts", folder: false), .init(depth: 2, name: "util.ts", folder: false),
            .init(depth: 1, name: "lib", folder: true), .init(depth: 0, name: "README.md", folder: false),
        ])
    }

    // MARK: A conversation

    private func open(_ server: ChatUiServer) async -> (Conversation, AsyncStream<ChatSnapshot>.AsyncIterator) {
        let opened = await openWithStore(server)
        return (opened.0, opened.1)
    }

    private func openWithStore(_ server: ChatUiServer) async -> (Conversation, AsyncStream<ChatSnapshot>.AsyncIterator, Store) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let mode = AgentWire.Mode(providerId: "claude", modelId: "opus", effort: "high", serviceTier: nil, permissionMode: "auto")
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "agent", mode: mode)
        let updates = conversation.updates.makeAsyncIterator()
        await conversation.start()
        return (conversation, updates, engine.spaces)
    }

    private func next(_ updates: inout AsyncStream<ChatSnapshot>.AsyncIterator, until: (ChatSnapshot) -> Bool) async -> ChatSnapshot? {
        while let snapshot = await updates.next() { if snapshot.loaded, until(snapshot) { return snapshot } }
        return nil
    }

    private func shown(_ snapshot: ChatSnapshot?, _ componentId: String = "pick") -> UiShown? {
        for item in snapshot?.items ?? [] {
            for piece in item.pieces { if case .ui(let shown) = piece, shown.offer.componentId == componentId { return shown } }
        }
        return nil
    }

    // MARK: Quick replies

    private static func suggesting(_ id: String, at: Double) -> JSONValue {
        .object(["id": .string(id), "role": .string("agent"), "createdAt": .number(at), "content": .array([
            .object(["type": .string("text"), "text": .string("Shall I fix it?")]),
            .object(["type": .string("tool_call"), "id": .string("call1"), "name": .string("suggest_replies"), "status": .string("completed"),
                     "presentation": .object(["type": .string("quick_replies"), "options": .array([.string("Yes, go ahead"), .string("Not now")])])]),
        ])])
    }

    private func replies(_ snapshot: ChatSnapshot?, _ messageId: String? = nil) -> QuickReplies? {
        for item in snapshot?.items ?? [] {
            for piece in item.pieces { if case .quickReplies(let replies) = piece, messageId == nil || replies.messageId == messageId { return replies } }
        }
        return nil
    }

    private func repliesRows(_ snapshot: ChatSnapshot?) -> [ChatItem] {
        (snapshot?.items ?? []).filter { $0.pieces.contains { if case .quickReplies = $0 { true } else { false } } }
    }

    /// A suggestion is its own row right under the turn's words and above
    /// how the turn ended, with no call line; a tap is an ordinary steered
    /// send of the option naming where it came from, with
    /// `Happy-Protocol: 35`. Sent, every option stays where it was, the
    /// one sent marked, and the stack takes no second tap.
    func testATapSendsAndEveryOptionStaysWithTheSentOneMarked() async throws {
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "endedAt": .number(2), "messages": .array([Self.suggesting("a1", at: 1)])]),
        ])
        var (conversation, updates, store) = await openWithStore(server)
        let first = await next(&updates) { self.replies($0) != nil && $0.items.contains { $0.id == "r1:status" } }
        let shown = try XCTUnwrap(replies(first))
        XCTAssertEqual(shown, QuickReplies(messageId: "a1", toolCallId: "call1", options: ["Yes, go ahead", "Not now"], live: true))
        XCTAssertEqual(first?.items.map(\.id), ["a1", "replies:a1:call1", "r1:status"])
        XCTAssertEqual(first?.items[1].turn, "r1")
        XCTAssertFalse(first?.items.contains { if case .tool = $0.role { true } else { false } } ?? true, "no suggest_replies call line")

        let sending = Task { await conversation.sendQuickReply(shown, index: 0) }
        let sent = await next(&updates) { $0.items.contains { $0.role == .user } }
        let bubble = try XCTUnwrap(sent?.items.last { $0.role == .user })
        XCTAssertEqual(bubble.text, "Yes, go ahead")
        XCTAssertTrue(bubble.suggested)
        XCTAssertEqual(replies(sent), QuickReplies(messageId: "a1", toolCallId: "call1", options: ["Yes, go ahead", "Not now"], chosen: 0, live: false))
        XCTAssertEqual(sent?.items.prefix(3).map(\.id), ["a1", "replies:a1:call1", "r1:status"], "nothing moved")
        // The changeset: the stack's row reconfigured, the send's inserted, nothing else touched.
        let before = Dictionary(uniqueKeysWithValues: (first?.items ?? []).map { ($0.id, $0) })
        let after = sent?.items ?? []
        XCTAssertEqual(after.filter { before[$0.id] == nil }.map(\.id), [bubble.id])
        XCTAssertEqual(after.filter { item in before[item.id].map { $0 != item } ?? false }.map(\.id), ["replies:a1:call1"])
        XCTAssertEqual(Set(before.keys).subtracting(after.map(\.id)), [])
        _ = await sending.value
        // Without an outbox, a send goes when the stream picks up again.
        await store.externalResync(loadSidebar: false)
        var body: JSONValue?
        for _ in 0..<200 {
            body = await server.sends.first
            if body != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(body?["text"], .string("Yes, go ahead"))
        XCTAssertEqual(body?["delivery"], .string("steer"))
        XCTAssertEqual(body?["quickReply"], .object(["messageId": .string("a1"), "toolCallId": .string("call1"), "index": .number(0)]))
        let protocols = await server.protocols
        XCTAssertTrue(!protocols.isEmpty && protocols.allSatisfy { $0 == "35" }, "\(protocols)")
        await conversation.stop()
    }

    /// Every suggestion stays, each marked by the person's message that
    /// sent one (as read back on any device), and only the newest takes a
    /// tap; a stored reply says it was suggested, and the daemon's own
    /// block is a suggestion too.
    func testEverySuggestionStaysMarkedFromHistoryAndOnlyTheNewestTakesATap() async throws {
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([
                .object(["id": .string("a0"), "role": .string("agent"), "createdAt": .number(0), "content": .array([.object(["type": .string("quick_replies"), "options": .array([.string("Hi")])])])]),
                Self.suggesting("a1", at: 1),
                .object(["id": .string("u1"), "role": .string("user"), "createdAt": .number(2), "content": .array([.object(["type": .string("text"), "text": .string("Not now")])]),
                         "quickReply": .object(["messageId": .string("a1"), "toolCallId": .string("call1"), "index": .number(1)])]),
            ])]),
            .object(["id": .string("r2"), "status": .string("completed"), "messages": .array([
                .object(["id": .string("a2"), "role": .string("agent"), "createdAt": .number(3), "content": .array([.object(["type": .string("quick_replies"), "options": .array([.string("Thanks")])])])]),
            ])]),
        ])
        var (conversation, updates) = await open(server)
        let first = await next(&updates) { $0.items.contains { $0.role == .user } && self.repliesRows($0).count == 3 }
        XCTAssertEqual(first?.items.first { $0.id == "u1" }?.suggested, true)
        XCTAssertEqual(replies(first, "a0"), QuickReplies(messageId: "a0", options: ["Hi"]))
        XCTAssertEqual(replies(first, "a1"), QuickReplies(messageId: "a1", toolCallId: "call1", options: ["Yes, go ahead", "Not now"], chosen: 1))
        XCTAssertEqual(replies(first, "a2"), QuickReplies(messageId: "a2", options: ["Thanks"], live: true))
        await conversation.stop()
    }

    /// Words the agent goes on with after offering replies come above
    /// them: the stack stays at the foot of what it said.
    func testWordsTheAgentGoesOnWithComeAboveTheReplies() async throws {
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "endedAt": .number(3), "messages": .array([
                Self.suggesting("a1", at: 1),
                .object(["id": .string("a2"), "role": .string("agent"), "createdAt": .number(2), "content": .array([.object(["type": .string("text"), "text": .string("My vote is the first.")])])]),
            ])]),
        ])
        var (conversation, updates) = await open(server)
        let first = await next(&updates) { self.replies($0) != nil && $0.items.contains { $0.id == "r1:status" } }
        XCTAssertEqual(first?.items.map(\.id), ["a1", "a2", "replies:a1:call1", "r1:status"])
        await conversation.stop()
    }

    /// A reply steered into the turn that offered the replies, and the
    /// answer streaming in it, go under the stack: it stays right under
    /// the words that offered it, and as the answer grows its row and the
    /// words' are never made again.
    func testWhatComesLaterInTheTurnGoesUnderTheRepliesAndNeverMovesThem() async throws {
        func steered(_ answer: String) -> [JSONValue] {
            [.object(["id": .string("r1"), "status": .string("running"), "messages": .array([
                Self.suggesting("a1", at: 1),
                .object(["id": .string("u2"), "role": .string("user"), "createdAt": .number(2), "content": .array([.object(["type": .string("text"), "text": .string("Yes, go ahead")])]),
                         "quickReply": .object(["messageId": .string("a1"), "toolCallId": .string("call1"), "index": .number(0)])]),
                .object(["id": .string("a3"), "role": .string("agent"), "createdAt": .number(3), "content": .array([.object(["type": .string("text"), "text": .string(answer)])])]),
            ])])]
        }
        let server = ChatUiServer(history: steered("Fixing"))
        var (conversation, updates, store) = await openWithStore(server)
        let first = await next(&updates) { $0.items.contains { $0.id == "a3" } }
        XCTAssertEqual(first?.items.map(\.id), ["a1", "replies:a1:call1", "u2", "a3"])
        XCTAssertEqual(replies(first), QuickReplies(messageId: "a1", toolCallId: "call1", options: ["Yes, go ahead", "Not now"], chosen: 0))

        await server.move(to: steered("Fixing it now: the first file is done"))
        await store.externalResync(loadSidebar: false)
        let grown = await next(&updates) { $0.items.first { $0.id == "a3" }?.text.hasSuffix("done") == true }
        XCTAssertEqual(grown?.items.map(\.id), ["a1", "replies:a1:call1", "u2", "a3"])
        let kept = Dictionary(uniqueKeysWithValues: (first?.items ?? []).map { ($0.id, $0) })
        XCTAssertEqual(grown?.items.filter { kept[$0.id] != $0 }.map(\.id), ["a3"], "only the answer is made again")
        await conversation.stop()
    }

    /// Taken by the computer but not yet in a run, a reply keeps its
    /// option marked: the stack never blinks between the send and its run.
    func testASentReplyWaitingForItsRunStaysMarked() async throws {
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "endedAt": .number(2), "messages": .array([Self.suggesting("a1", at: 1)])]),
        ])
        await server.read("/bootstrap", .object([
            "agent": .object(["id": .string("agent"), "workspaceId": .string("w"), "status": .string("idle")]),
            "pending": .array([.object(["id": .string("u2"), "role": .string("user"), "createdAt": .number(3), "content": .array([.object(["type": .string("text"), "text": .string("Not now")])]),
                                        "quickReply": .object(["messageId": .string("a1"), "toolCallId": .string("call1"), "index": .number(1)])])]),
        ]))
        var (conversation, updates) = await open(server)
        let first = await next(&updates) { $0.items.contains { $0.id == "u2" } }
        XCTAssertEqual(replies(first), QuickReplies(messageId: "a1", toolCallId: "call1", options: ["Yes, go ahead", "Not now"], chosen: 1))
        await conversation.stop()
    }

    /// A call the run's end left interrupted, then told completed by a
    /// later update, takes the completed state and what it showed.
    func testACallTheRunsEndInterruptedTakesItsLaterCompletion() async throws {
        func message(_ status: String, presentation: JSONValue?) -> JSONValue {
            var call: [String: JSONValue] = ["type": .string("tool_call"), "id": .string("c1"), "name": .string("show_ui"), "status": .string(status)]
            if let presentation { call["presentation"] = presentation }
            return .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([.object(["type": .string("text"), "text": .string("Here it is:")]), .object(call)])])
        }
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([message("interrupted", presentation: nil)])]),
        ])
        var (conversation, updates, store) = await openWithStore(server)
        let first = await next(&updates) { $0.items.contains { $0.id == "a1" } }
        XCTAssertNil(shown(first, "tree"))
        let document: JSONValue = .object(["type": .string("ui"), "items": .array([]), "ui": .object(["id": .string("u1"), "components": .array([
            .object(["id": .string("tree"), "type": .string("file_tree"), "fallback": .string("Files"), "props": .object(["paths": .array([.string("a.txt")])])]),
        ])])])
        await store.externalEvent(.object(["type": .string("message.updated"), "payload": .object(["agentId": .string("agent"), "message": message("completed", presentation: document), "runId": .string("r1")])]))
        let completed = await next(&updates) { self.shown($0, "tree") != nil }
        XCTAssertEqual(shown(completed, "tree")?.kind, .fileTree([.init(depth: 0, name: "a.txt", folder: false)]))
        await conversation.stop()
    }

    // MARK: The default model

    private static let config: JSONValue = config(model: "opus")

    private static func config(model: String) -> JSONValue {
        .object(["config": .object([
            "defaults": .object(["providerId": .string("claude"), "modelId": .string(model), "effort": .string("high"), "permissionMode": .string("auto")]),
            "models": .object([
                "opus": .object(["name": .string("Claude Opus"), "efforts": .array([.string("low"), .string("high")])]),
                "sonnet": .object(["name": .string("Claude Sonnet"), "efforts": .array([.string("low"), .string("high")])]),
            ]),
            "providers": .object(["claude": .object(["type": .string("claude"), "enabled": .bool(true), "models": .array([
                .object(["id": .string("opus"), "enabled": .bool(true)]), .object(["id": .string("sonnet"), "enabled": .bool(true)]),
            ])])]),
        ])])
    }

    private func model(_ defaults: UiModelDefaults? = nil, attempt: UiAttempt? = nil) -> UiShown {
        UiShown(offer: offer, type: "default_model", kind: .defaultModel, fallback: "The default model is in Settings.", attempt: attempt, defaults: defaults)
    }

    func testTheDefaultModelCardReadsTheConfiguration() throws {
        let defaults = try XCTUnwrap(UiModelDefaults(response: JSONEncoder().encode(Self.config)))
        XCTAssertEqual(defaults.title, "Claude Opus · high")
        XCTAssertEqual(defaults.choices.map(\.model.id), ["opus", "sonnet"])
        XCTAssertEqual(UiCard.make(model(defaults), granted: nil), UiCard(title: "Default model", lines: [.init("Claude Opus · high")], buttons: [.init("Change", .pickModel)]))
        // Someone who may not change it sees it, and who can.
        let member = UiCard.make(model(defaults), granted: ["content.write"])
        XCTAssertEqual(member.buttons, [.init("Change", .pickModel, enabled: false)])
        XCTAssertEqual(member.lines.last, .init("Owners and admins can change the default model", .muted))
        // Not read (an older server): its fallback, and nothing to press.
        XCTAssertEqual(UiCard.make(model(), granted: nil), UiCard(title: "Default model", lines: [.init("The default model is in Settings.", .muted)]))
    }

    func testTheCardShowsItsAttemptPendingAndRefused() throws {
        let defaults = try XCTUnwrap(UiModelDefaults(response: JSONEncoder().encode(Self.config)))
        let pending = UiCard.make(model(defaults, attempt: UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "pending"))), granted: nil)
        XCTAssertEqual(pending.buttons.map(\.enabled), [false])
        XCTAssertEqual(pending.lines.last, .init("Saving…", .muted))
        let refused = UiCard.make(model(defaults, attempt: UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "rejected", code: "not_allowed", reason: "Ask an owner."))), granted: nil)
        XCTAssertEqual(refused.buttons.map(\.enabled), [true])
        XCTAssertEqual(refused.lines.last, .init("Ask an owner.", .error))
        let failed = UiCard.make(model(defaults, attempt: UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "failed", code: "hook_failed"))), granted: nil)
        XCTAssertEqual(failed.lines.last, .init("hook_failed", .error))
        // Accepted, or a status this build doesn't know: the state alone.
        for status in ["accepted", "queued"] {
            XCTAssertEqual(UiCard.make(model(defaults, attempt: UiAttempt(type: "default_model.set", outcome: UiOutcome(status: status))), granted: nil).lines, [.init("Claude Opus · high")], status)
        }
    }

    /// A refusal stands until the server's state is read after this phone
    /// learned of it; pending and accepted attempts always stand.
    func testARefusalOlderThanTheLiveReadingDoesNotStand() {
        let refused = UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "rejected"))
        XCTAssertTrue(refused.stands(learnedAt: 10, readAt: nil))
        XCTAssertTrue(refused.stands(learnedAt: 10, readAt: 9))
        XCTAssertTrue(refused.stands(learnedAt: 10, readAt: 10))
        XCTAssertFalse(refused.stands(learnedAt: 10, readAt: 11))
        XCTAssertFalse(UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "failed")).stands(learnedAt: 10, readAt: 11))
        XCTAssertTrue(UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "pending")).stands(learnedAt: 10, readAt: 11))
    }

    private static let offering: [JSONValue] = [
        .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([
            .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([.object(["type": .string("ui"), "ui": .object([
                "id": .string("u1"), "components": .array([.object(["id": .string("model"), "type": .string("default_model"), "fallback": .string("The default model is in Settings."), "props": .object([:])])]),
            ])])])]),
        ])]),
    ]

    private static func record(_ status: String, reason: String? = nil, at: Double = 5) -> JSONValue {
        var outcome: [String: JSONValue] = ["status": .string(status)]
        if let reason { outcome["reason"] = .string(reason) }
        return .object(["id": .string("k"), "role": .string("service"), "createdAt": .number(at), "content": .array([.object([
            "type": .string("action"), "messageId": .string("a1"), "uiId": .string("u1"), "componentId": .string("model"),
            "action": .object(["type": .string("default_model.set"), "payload": .object(["providerId": .string("claude"), "modelId": .string("sonnet"), "effort": .string("high")])]),
            "outcome": .object(outcome),
        ])])])
    }

    private static func set(_ model: String) -> UiAction {
        UiAction(type: "default_model.set", payload: .object(["providerId": .string("claude"), "modelId": .string(model), "effort": .string("high")]))
    }

    /// The card is drawn from `GET /v0/config`, read once it is shown and
    /// again on `config.updated`. A press goes to `/actions` with the
    /// offer, with no bubble; refused, the card says why until the
    /// server's state is read again.
    func testALiveDefaultModelFollowsTheConfigurationAndShowsItsAttempt() async throws {
        let server = ChatUiServer(history: Self.offering)
        await server.read("/v0/config", Self.config)
        await server.answer(.object(["record": Self.record("rejected", reason: "Ask an owner."), "result": .null, "cursor": .null]))
        var (conversation, updates, store) = await openWithStore(server)
        let read = await next(&updates) { self.shown($0, "model")?.defaults != nil }
        let card = try XCTUnwrap(shown(read, "model"))
        XCTAssertEqual(card.defaults?.title, "Claude Opus · high")
        XCTAssertNil(card.attempt)

        let chat = conversation, sonnet = Self.set("sonnet")
        let pressing = Task { await chat.act(card, action: sonnet) }
        let refused = await next(&updates) { self.shown($0, "model")?.attempt?.outcome.status == "rejected" }
        let accepted = await pressing.value
        XCTAssertFalse(accepted)
        XCTAssertEqual(shown(refused, "model")?.attempt, UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "rejected", reason: "Ask an owner.")))
        XCTAssertEqual(refused?.items.map(\.id), read?.items.map(\.id), "no bubble, and no row for the record")
        let sent = await server.actions
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["messageId"], .string("a1"))
        XCTAssertEqual(sent.first?["uiId"], .string("u1"))
        XCTAssertEqual(sent.first?["componentId"], .string("model"))
        XCTAssertEqual(sent.first?["action"], .object(["type": .string("default_model.set"), "payload": .object(["providerId": .string("claude"), "modelId": .string("sonnet"), "effort": .string("high")])]))

        // Someone changes the default elsewhere: the reading is newer than the refusal, which goes.
        await server.read("/v0/config", Self.config(model: "sonnet"))
        await store.externalEvent(.object(["type": .string("config.updated"), "payload": .object([:])]))
        let moved = await next(&updates) { self.shown($0, "model")?.defaults?.modelId == "sonnet" }
        XCTAssertEqual(shown(moved, "model")?.defaults?.title, "Claude Sonnet · high")
        XCTAssertNil(shown(moved, "model")?.attempt)
        await conversation.stop()
    }

    /// A press whose request fails is that attempt again when pressed
    /// again, under its ID; once the computer has answered, the next press
    /// is a new attempt, and so is a press of something else.
    func testAPressThatFailedIsSentAgainUnderItsIdAndAnAnsweredOneIsNot() async throws {
        let server = ChatUiServer(history: Self.offering)
        await server.read("/v0/config", Self.config)
        await server.answer(.object(["record": Self.record("accepted"), "result": .null, "cursor": .null]))
        var (conversation, updates) = await open(server)
        let read = await next(&updates) { self.shown($0, "model")?.defaults != nil }
        let card = try XCTUnwrap(shown(read, "model"))

        await server.fail(actions: 2)
        let lost = await conversation.act(card, action: Self.set("sonnet"))
        XCTAssertFalse(lost)
        let failed = await next(&updates) { self.shown($0, "model")?.attempt?.outcome.status == "failed" }
        XCTAssertNotNil(shown(failed, "model")?.attempt?.outcome.reason)
        let lostAgain = await conversation.act(card, action: Self.set("sonnet"))
        XCTAssertFalse(lostAgain)
        let taken = await conversation.act(card, action: Self.set("sonnet"))
        XCTAssertTrue(taken)
        let again = await conversation.act(card, action: Self.set("sonnet"))
        XCTAssertTrue(again)
        let ids = await server.actions.map { $0["id"]?.stringValue }
        XCTAssertEqual(ids.count, 4)
        XCTAssertEqual(Set(ids[0...2]).count, 1, "the lost press, pressed again, is the same attempt")
        XCTAssertNotEqual(ids[3], ids[2], "answered, the next press is a new attempt")

        // Lost, then another model picked: a new intent.
        await server.fail(actions: 1)
        _ = await conversation.act(card, action: Self.set("opus"))
        _ = await conversation.act(card, action: Self.set("sonnet"))
        let later = await server.actions.map { $0["id"]?.stringValue }
        XCTAssertNotEqual(later[5], later[4])
        await conversation.stop()
    }

    /// The phone sends only the actions it knows, to the component they
    /// belong to.
    func testAnActionThePhoneDoesntKnowIsNotSent() async throws {
        let server = ChatUiServer(history: Self.offering)
        await server.read("/v0/config", Self.config)
        var (conversation, updates) = await open(server)
        let read = await next(&updates) { self.shown($0, "model") != nil }
        let card = try XCTUnwrap(shown(read, "model"))
        let unknown = await conversation.act(card, action: UiAction(type: "default_model.reset", payload: .object([:])))
        let other = await conversation.act(UiShown(offer: card.offer, type: "file_tree", kind: .line("x")), action: Self.set("opus"))
        XCTAssertFalse(unknown)
        XCTAssertFalse(other)
        let sent = await server.actions
        XCTAssertTrue(sent.isEmpty)
        await conversation.stop()
    }

    /// An attempt record's own finished run ends nothing: the agent's turn
    /// going on keeps working, and the record's run shows no "ended" row.
    private static func recordRun(kind: String?) -> JSONValue {
        var run: [String: JSONValue] = ["id": .string("k-run"), "status": .string("completed"), "startedAt": .number(6), "endedAt": .number(6), "messages": .array([record("accepted")])]
        if let kind { run["kind"] = .string(kind) }
        return .object(run)
    }

    func testAStandaloneRunEndsNoTurn() async throws {
        let server = ChatUiServer(history: Self.offering + [Self.recordRun(kind: "standalone")])
        await server.read("/v0/config", Self.config)
        var (conversation, updates) = await open(server)
        let read = await next(&updates) { self.shown($0, "model")?.attempt != nil }
        XCTAssertEqual(read?.items.map(\.id), ["a1"])
        XCTAssertEqual(shown(read, "model")?.attempt?.outcome.status, "accepted")
        await conversation.stop()
    }

    /// The marker says it, not what the run holds.
    func testARunOfRecordsWithoutTheMarkerEndsItsTurn() async throws {
        let server = ChatUiServer(history: Self.offering + [Self.recordRun(kind: nil)])
        await server.read("/v0/config", Self.config)
        var (conversation, updates) = await open(server)
        let read = await next(&updates) { self.shown($0, "model")?.attempt != nil }
        XCTAssertEqual(read?.items.map(\.id), ["a1", "k-run:status"])
        await conversation.stop()
    }

    func testAStandaloneRunFinishingLeavesTheAgentWorking() async throws {
        let server = ChatUiServer(history: Self.offering)
        await server.read("/v0/config", Self.config)
        var (conversation, updates, store) = await openWithStore(server)
        _ = await next(&updates) { self.shown($0, "model") != nil }
        func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
            .object(["type": .string(type), "payload": .object(payload.merging(["agentId": .string("agent")]) { old, _ in old })])
        }
        await store.externalEvent(event("run.started", ["run": .object(["id": .string("live"), "status": .string("running"), "startedAt": .number(10)])]))
        let working = await next(&updates) { $0.working }
        XCTAssertEqual(working?.working, true)
        await store.externalEvent(event("run.finished", ["run": .object(["id": .string("k-run"), "status": .string("completed"), "reason": .string("completed"), "kind": .string("standalone"), "startedAt": .number(11), "endedAt": .number(11)])]))
        await store.externalEvent(event("message.created", ["runId": .string("k-run"), "message": Self.record("accepted", at: 11)]))
        let recorded = await next(&updates) { self.shown($0, "model")?.attempt != nil }
        XCTAssertEqual(recorded?.working, true)
        XCTAssertEqual(recorded?.items.contains { $0.id == "k-run:status" }, false)
        await store.externalEvent(event("run.finished", ["run": .object(["id": .string("live"), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(10), "endedAt": .number(12)])]))
        let ended = await next(&updates) { !$0.working }
        XCTAssertEqual(ended?.working, false)
        await conversation.stop()
    }
}

/// A daemon with one conversation's history and a `/actions` answer, that
/// keeps what was sent there and every request's `Happy-Protocol`.
private actor ChatUiServer: AgentTransport {
    private(set) var history: [JSONValue]
    /// Other reads, by the path they end with.
    var reads: [String: JSONValue] = [:]
    private var answerBody: JSONValue = .object([:])
    private(set) var actions: [JSONValue] = []
    private(set) var sends: [JSONValue] = []
    private(set) var protocols: [String?] = []
    /// How many of the next presses are lost on their way.
    private var failing = 0

    init(history: [JSONValue]) { self.history = history }

    func answer(_ body: JSONValue) { answerBody = body }

    /// What the next read of the messages finds.
    func move(to history: [JSONValue]) { self.history = history }

    func read(_ path: String, _ body: JSONValue) { reads[path] = body }

    func fail(actions count: Int) { failing = count }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        protocols.append(headers[ChatUi.protocolHeader])
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(history)])
        } else if path.hasSuffix("/bootstrap") {
            value = reads["/bootstrap"] ?? .object(["agent": .object(["id": .string("agent"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else if path.hasSuffix("/actions") {
            if let body { actions.append(try JSONValue.decode(body)) }
            if failing > 0 {
                failing -= 1
                throw URLError(.timedOut)
            }
            // The record's id is the request's.
            var answer = answerBody
            if case .object(var object) = answer, case .object(var record)? = object["record"], let id = actions.last?["id"] {
                record["id"] = id
                object["record"] = .object(record)
                answer = .object(object)
            }
            value = answer
        } else if path.hasSuffix("/send") {
            if let body { sends.append(try JSONValue.decode(body)) }
            value = .object(["message": .object([:])])
        } else if let read = reads.first(where: { path.hasSuffix($0.key) })?.value {
            value = read
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
