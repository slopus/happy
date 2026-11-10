import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Chat UI against `@slopus/happy-agent-client`'s own vectors
/// (`fixtures/ui/actions.fixtures.json` and `ui.schema.json`, copied as
/// `chat-ui-actions.json` and `chat-ui-schema.json` from happy-agent
/// `chat-ui-actions` 8417cce23), and a conversation drawing and pressing it.
final class ChatUiTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.decode(Data(contentsOf: url))
    }

    private func action(_ value: JSONValue?) throws -> UiAction {
        try XCTUnwrap(value).decode(as: UiAction.self)
    }

    // MARK: The client's vectors

    /// The owner holds every permission, a member the member set, a viewer
    /// none: only reading the conversation is left to them.
    func testPermissionsResolveAsTheClientsForOwnerMemberAndViewer() throws {
        let schema = try fixture("chat-ui-schema")
        let member = Set(try XCTUnwrap(schema["memberPermissions"]?.arrayValue).compactMap(\.stringValue))
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["permission"]?.arrayValue)
        XCTAssertEqual(vectors.count, 30)
        for vector in vectors {
            let type = try XCTUnwrap(vector["action"]?.stringValue)
            let props = vector["props"] ?? .object([:])
            let definition = try XCTUnwrap(UiCatalog.actions[type], type)
            let permission = UiCatalog.permission(definition, props: props)
            XCTAssertEqual(permission.map(JSONValue.string) ?? .object(["conversation": .string("read")]), vector["permission"], type)
            XCTAssertEqual(UiCatalog.allowed(type, props: props, granted: nil), vector["allowed"]?["owner"]?.boolValue, type)
            XCTAssertEqual(UiCatalog.allowed(type, props: props, granted: member), vector["allowed"]?["member"]?.boolValue, type)
            XCTAssertEqual(UiCatalog.allowed(type, props: props, granted: []), vector["allowed"]?["viewer"]?.boolValue, type)
        }
    }

    /// Quick replies normalize and are checked as the client's.
    func testQuickRepliesAreTheClients() throws {
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["quickReplies"]?.arrayValue)
        XCTAssertEqual(vectors.count, 8)
        for vector in vectors {
            let options = try XCTUnwrap(vector["options"]?.arrayValue).compactMap(\.stringValue)
            let normalized = options.map(QuickReplies.normalize)
            XCTAssertEqual(normalized.map(JSONValue.string), vector["normalized"]?.arrayValue, "\(vector)")
            XCTAssertEqual(QuickReplies.problems(normalized).map(JSONValue.string), vector["problems"]?.arrayValue, "\(vector)")
        }
        XCTAssertEqual(try fixture("chat-ui-schema")["quickReplies"]?["block"]?["properties"]?["options"]?["maxItems"]?.numberValue, Double(QuickReplies.max))
    }

    /// Each stored suggestion of the client's reply vectors reads: a
    /// `provider` option has its provider, any other type is a plain option.
    func testReplyComponentsReadAsTheClientStoresThem() throws {
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["replies"]?.arrayValue)
        XCTAssertEqual(vectors.count, 6)
        for vector in vectors {
            let stored = try XCTUnwrap(vector["stored"])
            let block = try JSONDecoder().decode(AgentWire.Block.self, from: JSONEncoder().encode(JSONValue.object(["type": .string("quick_replies"), "options": stored["options"] ?? .null, "ui": stored["ui"] ?? .null])))
            guard case .quickReplies(let options, let ui) = block else { return XCTFail("\(vector)") }
            let replies = QuickReplies(messageId: "m", options: options, ui: ui)
            let expected = (stored["ui"]?.arrayValue ?? options.map { _ in .null }).map { one -> String? in
                one["type"]?.stringValue == "provider" ? one["props"]?["provider"]?.stringValue : nil
            }
            XCTAssertEqual(replies.providers, expected, "\(vector)")
        }
    }

    /// Every action the schema declares, with its permission, and no other.
    func testTheCatalogIsTheSchemas() throws {
        let components = try XCTUnwrap(fixture("chat-ui-schema")["components"]?.objectValue)
        var declared: Set<String> = []
        for (type, component) in components {
            for (name, definition) in component["actions"]?.objectValue ?? [:] {
                let key = "\(type).\(name)"
                declared.insert(key)
                let ours = try XCTUnwrap(UiCatalog.actions[key], key)
                let permission: JSONValue = switch ours.permission {
                case .id(let id): .string(id)
                case .conversationRead: .object(["conversation": .string("read")])
                case .byProp(let prop, let map, let fallback): .object(["prop": .string(prop), "map": .object(map.mapValues(JSONValue.string)), "default": .string(fallback)])
                }
                XCTAssertEqual(permission, definition["permission"], key)
            }
        }
        XCTAssertEqual(declared, Set(UiCatalog.actions.keys))
        XCTAssertEqual(try fixture("chat-ui-schema")["catalogVersion"]?.numberValue, Double(UiCatalog.version))
    }

    /// Every document reads, an unknown or broken component included, and
    /// its fallback text is the client's.
    func testEveryDocumentReadsAndFallsBackAsTheClients() throws {
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["documents"]?.arrayValue)
        for vector in vectors {
            let block = JSONValue.object(["type": .string("ui"), "ui": try XCTUnwrap(vector["document"])])
            guard case .ui(let document) = try block.decode(as: AgentWire.Block.self) else { return XCTFail("\(vector)") }
            XCTAssertEqual(ChatUi.fallback(document), vector["fallback"]?.stringValue)
        }
    }

    // MARK: Blocks

    func testActionBlocksUiAndQuickRepliesReadAndKeep() throws {
        let json = #"""
        {"id":"m","role":"agent","createdAt":1,"content":[
          {"type":"action","messageId":"a1","uiId":"u1","componentId":"sign","action":{"type":"provider_sign_in.submit_token","payload":{}},"outcome":{"status":"rejected","code":"token_rejected","reason":"Claude didn't accept this token."}},
          {"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u2","components":[{"id":"x","type":"slideshow","fallback":"Slides","props":{}}]},"items":[]}},
          {"type":"ui","ui":{"components":[]}},
          {"type":"quick_replies","options":["Yes","Not now"]},
          {"type":"tool_call","id":"c2","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Fix it"]}}
        ]}
        """#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        guard case .action(let block) = message.content[0] else { return XCTFail("no action") }
        XCTAssertEqual(block.offer, UiOffer(messageId: "a1", uiId: "u1", componentId: "sign"))
        XCTAssertEqual(block.outcome, UiOutcome(status: "rejected", code: "token_rejected", reason: "Claude didn't accept this token."))
        guard case .toolCall(_, _, _, let presentation, _, _, _, _) = message.content[1] else { return XCTFail("no call") }
        XCTAssertEqual(presentation?.ui?.components.first?.type, "slideshow")
        // A document that can't be read is skipped, never the message.
        XCTAssertEqual(message.content[2], .unknown("ui"))
        XCTAssertEqual(message.content[3], .quickReplies(["Yes", "Not now"]))
        guard case .toolCall(_, _, _, let suggested, _, _, _, _) = message.content[4] else { return XCTFail("no call") }
        XCTAssertEqual(suggested?.options, ["Fix it"])
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

    func testAComponentThePhoneDoesntDrawIsItsFallbackLineAndThePhoneAppNothing() {
        // choice, checklist and text_field are gone from the catalog: a fallback line.
        guard case .ui(let choice)? = UiShown.pieces(component("choice", .object(["options": .array([.object(["id": .string("a"), "label": .string("A")])])])), document: "u1", message: "a1", media: []).first
        else { return XCTFail() }
        XCTAssertEqual(choice.kind, .line("Fallback"))
        let fallback = "Sign in to Claude in Happy on your computer"
        let live = UiShown.pieces(component("provider_sign_in", .object(["provider": .string("claude")]), fallback: fallback), document: "u1", message: "a1", media: [])
        XCTAssertEqual(live, [.ui(UiShown(offer: offer, type: "provider_sign_in", props: .object(["provider": .string("claude")]), kind: .live, fallback: fallback))])
        guard case .ui(let link)? = UiShown.pieces(component("server_link", .object([:])), document: "u1", message: "a1", media: []).first else { return XCTFail() }
        XCTAssertEqual(link.kind, .line("Fallback"))
        XCTAssertEqual(UiShown.pieces(component("slideshow", .object([:])), document: "u1", message: "a1", media: []).count, 1)
        XCTAssertEqual(UiShown.pieces(component("phone_app", .object([:])), document: "u1", message: "a1", media: []), [])
        XCTAssertEqual(UiShown.pieces(component("phone_pair", .object([:])), document: "u1", message: "a1", media: []), [])
        // Props a known type can't be drawn from: its fallback too.
        guard case .ui(let broken)? = UiShown.pieces(component("file_tree", .object(["paths": .array([])])), document: "u1", message: "a1", media: []).first else { return XCTFail() }
        XCTAssertEqual(broken.kind, .line("Fallback"))
    }

    func testMediaIsTheCallsItemsInRowsWithTheirLabels() {
        let item = AgentWire.MediaItem(kind: "image", name: "a.png", mimeType: "image/png")
        let media = (0..<3).map { Media(toolCallId: "call", index: $0, item: item) }
        let props: JSONValue = .object(["items": .array([
            .object(["mediaIndex": .number(2), "label": .string("Login")]), .object(["mediaIndex": .number(0), "label": .string("  ")]),
        ])])
        XCTAssertEqual(UiShown.pieces(component("media", props), document: "u1", message: "a1", media: media), [.mediaRows([media[2], media[0]], labels: ["Login", nil])])
        // An index past the items: the fallback, never a hole.
        let missing = UiShown.pieces(component("media", .object(["items": .array([.object(["mediaIndex": .number(5)])])])), document: "u1", message: "a1", media: media)
        guard case .ui(let line)? = missing.first else { return XCTFail() }
        XCTAssertEqual(line.kind, .line("Fallback"))
        // The old `images` is gone: its fallback.
        guard case .ui(let old)? = UiShown.pieces(component("images", .object(["images": .array([.object(["mediaIndex": .number(0)])])])), document: "u1", message: "a1", media: media).first
        else { return XCTFail() }
        XCTAssertEqual(old.kind, .line("Fallback"))
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

    /// A suggestion's reply components come in its `ui`, one per option:
    /// a `provider` option's mark goes before its words, and its note
    /// follows its CLI's live state, the stack's row moved in place.
    func testAProviderReplyHasItsMarkAndANoteFromItsCli() async throws {
        let ui: JSONValue = .array([.object(["type": .string("provider"), "props": .object(["provider": .string("claude")])]), .null])
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([
                .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([
                    .object(["type": .string("text"), "text": .string("Which AI should I work with?")]),
                    .object(["type": .string("quick_replies"), "options": .array([.string("Add another Claude Code account"), .string("That's all for now")]), "ui": ui]),
                ])]),
            ])]),
        ])
        await server.read("/v0/provider-clis/claude", .object(["providerCli": Self.providerCli(version: "01991f3a-0000")]))
        var (conversation, updates, store) = await openWithStore(server)
        let read = await next(&updates) { (self.replies($0)?.notes.first ?? nil) != nil }
        let shown = try XCTUnwrap(replies(read))
        XCTAssertEqual(shown.providers, ["claude", nil])
        XCTAssertEqual(shown.notes, ["Not signed in", nil])

        guard case .object(var signedIn) = Self.providerCli(version: "01991f3a-0001", signIn: "signed_in") else { return XCTFail() }
        signedIn["accounts"] = .array([
            .object(["id": .string("a"), "label": .string("Work"), "signIn": .string("signed_in")]),
            .object(["id": .string("b"), "label": .string("Home"), "signIn": .string("signed_in")]),
        ])
        await store.externalEvent(.object(["type": .string("provider_cli.updated"), "payload": .object(["providerCli": .object(signedIn)])]))
        let moved = await next(&updates) { self.replies($0)?.notes.first == "2 accounts" }
        XCTAssertEqual(moved?.items.map(\.id), read?.items.map(\.id), "nothing moved")
        let before = Dictionary(uniqueKeysWithValues: (read?.items ?? []).map { ($0.id, $0) })
        XCTAssertEqual(moved?.items.filter { before[$0.id] != $0 }.map(\.id), ["replies:a1:"])
        await conversation.stop()
    }

    func testAReplyComponentReadsAndKeepsAndANoteSaysWhatItsCliHas() throws {
        let json = #"""
        {"id":"m","role":"agent","createdAt":1,"content":[
          {"type":"quick_replies","options":["Set up Grok","No"],"ui":[{"type":"provider","props":{"provider":"grok"}},null]},
          {"type":"tool_call","id":"c2","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Codex","Later"],"ui":[{"type":"provider","props":{"provider":"codex"}},{"type":"sparkle","props":{}}]}}
        ]}
        """#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        let grok = ReplyUi(type: "provider", props: .object(["provider": .string("grok")]))
        XCTAssertEqual(message.content[0], .quickReplies(["Set up Grok", "No"], ui: [grok, nil]))
        guard case .toolCall(_, _, _, let presentation, _, _, _, _) = message.content[1] else { return XCTFail("no call") }
        XCTAssertNil(presentation?.ui)
        // A type this build doesn't know is a plain option.
        XCTAssertEqual(QuickReplies(messageId: "m", options: presentation?.options ?? [], ui: presentation?.replyUi).providers, ["codex", nil])
        // Components that don't match the options are dropped, not misplaced.
        XCTAssertEqual(QuickReplies(messageId: "m", options: ["A", "B"], ui: [grok]).providers, [nil, nil])
        let kept = try JSONDecoder().decode(AgentWire.Message.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(kept.content, message.content)

        func note(_ extra: [String: JSONValue]) throws -> String? {
            guard case .object(var base) = Self.providerCli(version: "v") else { throw CocoaError(.coderInvalidValue) }
            for (key, value) in extra { base[key] = value }
            return QuickReplies.note(try XCTUnwrap(UiProviderCli(.object(base))))
        }
        XCTAssertEqual(try note(["installation": .object(["status": .string("not_installed")])]), "Not installed")
        XCTAssertEqual(try note([:]), "Not signed in")
        XCTAssertEqual(try note(["signIn": .object(["status": .string("signed_in")])]), "1 account")
        XCTAssertEqual(try note(["accounts": .array([.object(["id": .string("a"), "signIn": .string("signed_out")])])]), "Not signed in")
        // Not knowing, with no accounts listed: no note.
        XCTAssertNil(try note(["signIn": .object(["status": .string("unknown")])]))
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

    // MARK: Live components

    private static func providerCli(version: String, signIn: String = "signed_out", operation: JSONValue = .null) -> JSONValue {
        .object([
            "id": .string("claude"), "name": .string("Claude Code"), "version": .string(version),
            "installation": .object(["status": .string("installed")]),
            "installer": .object(["command": .string("curl -fsSL https://claude.ai/install.sh | bash")]),
            "signIn": .object(["status": .string(signIn), "account": .null, "methods": .array([.string("browser")])]),
            "operation": operation,
        ])
    }

    private static let waiting: JSONValue = .object([
        "id": .string("op1"), "kind": .string("sign_in"), "status": .string("waiting"),
        "message": .string("Waiting for you to finish signing in to Claude in your browser."),
        "authorization": .object(["method": .string("browser"), "url": .string("https://claude.com/cai/oauth/authorize?x=1"), "userCode": .null,
                                  "openedByProgram": .bool(false), "acceptsCode": .bool(true), "expiresAt": .number(1)]),
    ])

    private func live(_ type: String, _ props: JSONValue = .object([:]), live: UiLive? = nil, attempt: UiAttempt? = nil, result: JSONValue? = nil) -> UiShown {
        var shown = UiShown(offer: offer, type: type, props: props, kind: .live, fallback: "Do it on your computer", state: .init(attempt: attempt))
        shown.live = live
        shown.result = result
        return shown
    }

    /// A sign-in is one row: its name, one line, and the control it
    /// needs now; a token only while a sign-in waits or after one failed,
    /// and no installer line, "Set up" installing.
    func testASignInRowOffersWhatItsStateAllows() throws {
        let claude: JSONValue = .object(["provider": .string("claude")])
        let out = try XCTUnwrap(UiProviderCli(Self.providerCli(version: "a")))
        var card = UiCard.make(live("provider_sign_in", claude, live: .provider(out)), granted: nil)
        XCTAssertEqual(card.title, "Claude Code")
        XCTAssertEqual(card.row, UiCard.Row(provider: "claude", tone: .quiet))
        XCTAssertEqual(card.lines, [.init("Not signed in", .muted)])
        XCTAssertEqual(card.buttons.map(\.label), ["Sign in"])
        XCTAssertEqual(card.buttons.first?.tap, .act(UiAction(type: "provider_sign_in.sign_in", payload: .object([:]))))

        // Waiting for a code the page shows: the page, the code, and a cross.
        let waiting = try XCTUnwrap(UiProviderCli(Self.providerCli(version: "b", operation: Self.waiting)))
        card = UiCard.make(live("provider_sign_in", claude, live: .provider(waiting)), granted: nil)
        XCTAssertEqual(card.lines, [.init("Paste the code from the page")])
        XCTAssertEqual(card.row?.tone, .busy)
        XCTAssertEqual(card.buttons.map(\.label), ["Open page", "Paste code", "Cancel"])
        XCTAssertEqual(card.buttons.map(\.rank), [1, 0, 2], "the cross goes first when they don't all fit")
        XCTAssertEqual(card.buttons.first?.tap, .open(URL(string: "https://claude.com/cai/oauth/authorize?x=1")!))
        XCTAssertEqual(card.buttons.map(\.glyph), ["open-outline", nil, "close"])

        // A page that isn't https never opens.
        var http = Self.waiting
        if case .object(var object) = http, case .object(var authorization)? = object["authorization"] {
            authorization["url"] = .string("http://evil.example")
            object["authorization"] = .object(authorization)
            http = .object(object)
        }
        let unsafe = try XCTUnwrap(UiProviderCli(Self.providerCli(version: "c", operation: http)))
        XCTAssertEqual(UiCard.make(live("provider_sign_in", claude, live: .provider(unsafe)), granted: nil).buttons.map(\.label), ["Paste code", "Cancel"])

        // A browser page only the computer can finish: a token, or a cross.
        var browser = Self.waiting
        if case .object(var object) = browser, case .object(var authorization)? = object["authorization"] {
            authorization["acceptsCode"] = .bool(false)
            object["authorization"] = .object(authorization)
            browser = .object(object)
        }
        card = UiCard.make(live("provider_sign_in", claude, live: .provider(try XCTUnwrap(UiProviderCli(Self.providerCli(version: "d", operation: browser))))), granted: nil)
        XCTAssertEqual(card.lines, [.init("Finish in the browser on your computer")])
        XCTAssertEqual(card.buttons.map(\.label), ["Use a token", "Cancel"])
        XCTAssertEqual(card.buttons.first?.tap, .secret(action: "provider_sign_in.submit_token", field: "token", title: "Paste a setup token or API key"))

        // Missing: where it comes from, and Set up; never the installer itself.
        guard case .object(var missingJSON) = Self.providerCli(version: "e") else { return XCTFail() }
        missingJSON["installation"] = .object(["status": .string("missing")])
        missingJSON["installer"] = .object(["command": .string("curl -fsSL https://x.ai/cli/install.sh | bash"), "sourceHost": .string("x.ai")])
        card = UiCard.make(live("provider_sign_in", claude, live: .provider(try XCTUnwrap(UiProviderCli(.object(missingJSON))))), granted: nil)
        XCTAssertEqual(card.lines, [.init("Not on this computer yet · comes from x.ai", .muted)])
        XCTAssertEqual(card.buttons.map(\.label), ["Set up"])
        XCTAssertEqual(card.buttons.first?.tap, .act(UiAction(type: "provider_sign_in.install", payload: .object([:]))))
        XCTAssertFalse(String(describing: card).contains("curl"))

        // Signed in: its account; adding another, Add account; two, counted.
        guard case .object(var two) = Self.providerCli(version: "f", signIn: "signed_in") else { return XCTFail() }
        two["accounts"] = .array([
            .object(["id": .string("a"), "label": .string("Current CLI"), "email": .string("ada@example.com"), "plan": .string("Max"), "signIn": .string("signed_in")]),
            .object(["id": .string("b"), "label": .string("Work"), "signIn": .string("signed_in")]),
        ])
        let both = try XCTUnwrap(UiProviderCli(.object(two)))
        card = UiCard.make(live("provider_sign_in", claude, live: .provider(both)), granted: nil)
        XCTAssertEqual(card.lines, [.init("2 accounts · ada@example.com +1")])
        XCTAssertEqual(card.row?.tone, .done)
        XCTAssertEqual(card.buttons.map(\.label), ["Use Claude Code"])
        let accepted = UiAttempt(type: "provider_sign_in.sign_in", outcome: UiOutcome(status: "accepted"))
        XCTAssertEqual(UiCard.make(live("provider_sign_in", claude, live: .provider(both), attempt: accepted), granted: nil).buttons, [], "once used, nothing to do")
        let adding: JSONValue = .object(["provider": .string("claude"), "account": .string("new")])
        XCTAssertEqual(UiCard.make(live("provider_sign_in", adding, live: .provider(both)), granted: nil).buttons.map(\.label), ["Add account"])
        var addingNow = both
        addingNow.operation = UiProviderCli.Operation(kind: "sign_in", status: "running", message: "opening the sign-in page", url: nil, userCode: nil, acceptsCode: false, device: false, openedByProgram: false)
        XCTAssertEqual(UiCard.make(live("provider_sign_in", adding, live: .provider(addingNow)), granted: nil).lines, [.init("Adding account 3 · opening the sign-in page")])

        // Nothing read (an older server): its fallback, with a sign-in.
        card = UiCard.make(live("provider_sign_in", claude), granted: nil)
        XCTAssertEqual(card.lines, [.init("Do it on your computer", .muted)])
        XCTAssertEqual(card.buttons.map(\.label), ["Sign in"])

        // On its way, then refused by the computer: the reason, a token, or again.
        card = UiCard.make(live("provider_sign_in", claude, live: .provider(out), attempt: UiAttempt(type: "provider_sign_in.sign_in", outcome: UiOutcome(status: "pending"))), granted: nil)
        XCTAssertEqual(card.lines, [.init("Starting…")])
        XCTAssertEqual(card.buttons, [])
        let rejected = UiOutcome(status: "rejected", code: "token_rejected", reason: "Claude didn't accept this token.")
        card = UiCard.make(live("provider_sign_in", claude, live: .provider(out), attempt: UiAttempt(type: "provider_sign_in.submit_token", outcome: rejected)), granted: nil)
        XCTAssertEqual(card.lines, [.init("Claude didn't accept this token.", .error)])
        XCTAssertEqual(card.buttons.map(\.label), ["Use a token", "Try again"])
        XCTAssertTrue(card.buttons.allSatisfy(\.enabled))
    }

    func testControlsTheViewerMayNotUseAreDisabledAndSayWhoCan() {
        let member: Set<String> = ["content.write", "providers.own"]
        let team = UiCard.make(live("provider_sign_in", .object(["provider": .string("claude"), "target": .string("team")]), live: .provider(try! XCTUnwrap(UiProviderCli(Self.providerCli(version: "a"))))), granted: member)
        XCTAssertTrue(team.buttons.allSatisfy { !$0.enabled })
        XCTAssertEqual(team.lines, [.init("Owners and admins can connect AIs for the team", .muted)])
        XCTAssertTrue(UiCard.make(live("provider_sign_in", .object(["provider": .string("claude")])), granted: member).buttons.allSatisfy(\.enabled))
        let invite = UiCard.make(live("invite"), granted: member)
        XCTAssertEqual(invite.buttons.map(\.enabled), [false])
        XCTAssertEqual(invite.lines.last, .init("Owners and admins can invite teammates", .muted))
        // Linking one's own GitHub needs only to read the conversation.
        XCTAssertEqual(UiCard.make(live("github_connect"), granted: []).buttons.map(\.enabled), [true])
    }

    func testResultCardsShowTheirSecretsOnlyFromTheResultHeld() {
        let invite = UiCard.make(live("invite", .object(["role": .string("admin")]), result: .object([
            "inviteId": .string("i1"), "code": .string("J7K-Q2"), "expiresAt": .number(0), "serverName": .string("Acme"),
        ])), granted: nil)
        XCTAssertEqual(invite.lines.first, .init("J7K-Q2", .code))
        XCTAssertEqual(invite.lines[1], .init("Joins Acme as admin", .muted))
        XCTAssertEqual(invite.buttons, [.init("Copy code", .copy("J7K-Q2"), primary: true),
                                        .init("Revoke", .act(UiAction(type: "invite.revoke", payload: .object(["inviteId": .string("i1")]))))])
        XCTAssertEqual(UiCard.make(live("invite"), granted: nil).buttons, [.init("Create invite", .act(UiAction(type: "invite.create", payload: .object(["role": .string("member")]))), primary: true)])

        let github = UiCard.make(live("github_connect", result: .object(["userCode": .string("WDJB-MJHT"), "verificationUri": .string("https://github.com/login/device"), "expiresAt": .number(0)])), granted: nil)
        XCTAssertEqual(github.lines.prefix(2), [.init("Enter this code on GitHub", .muted), .init("WDJB-MJHT", .code)])
        XCTAssertEqual(github.buttons.map(\.label), ["Copy code", "Open GitHub"])
        XCTAssertEqual(UiCard.make(live("github_connect", live: .github(connected: true)), granted: nil).lines, [.init("Connected")])

        let join = UiCard.make(live("compute_join", .object(["pool": .string("gpu")]), result: .object(["commands": .array([.string("happy join abc")]), "expiresAt": .number(0)])), granted: nil)
        XCTAssertEqual(join.title, "Add a machine to gpu")
        XCTAssertEqual(join.lines.prefix(2), [.init("Run on the machine", .muted), .init("happy join abc", .code)])
        XCTAssertEqual(join.buttons.map(\.label), ["Copy commands"])
    }

    func testAJoinCardListsItsPoolsMachinesLive() throws {
        func node(_ id: String, _ name: String, _ status: String) -> JSONValue {
            .object(["id": .string(id), "pool": .string("gpu"), "name": .string(name), "status": .string(status),
                     "sandboxCapacity": .object(["used": .number(0), "total": .null]), "activeSandboxes": .array([])])
        }
        let counts: JSONValue = .object(["total": .number(2), "online": .number(1), "offline": .number(0), "draining": .number(0), "enrolling": .number(1), "revoked": .number(1)])
        let detail = try JSONValue.object([
            "pool": .object(["id": .string("gpu"), "name": .string("GPU boxes"), "kind": .string("self_hosted"), "default": .bool(false), "nodeCounts": counts,
                             "sandboxCapacity": .object(["used": .number(0), "total": .null])]),
            "nodes": .array([node("n1", "studio", "online"), node("n2", "attic", "enrolling"), node("n3", "old", "revoked")]),
        ]).decode(as: ComputePoolDetail.self)
        let pool = UiPool(detail)
        XCTAssertEqual(UiLive.source("compute_join", props: .object(["pool": .string("gpu")])), "pool:gpu")
        XCTAssertEqual(UiLive.source("compute_join", props: .object([:])), "pool:")
        let card = UiCard.make(live("compute_join", .object(["pool": .string("gpu")]), live: .pool(pool),
                                    result: .object(["commands": .array([.string("happy join abc")]), "expiresAt": .number(0)])), granted: nil)
        XCTAssertEqual(card.title, "Add a machine to GPU boxes")
        XCTAssertEqual(Array(card.lines.suffix(3)), [.init("Machines", .muted), .init("studio · online"), .init("attic · enrolling")])
        let empty = UiCard.make(live("compute_join", live: .pool(UiPool(try JSONValue.object(["pool": .object(["id": .string("d"), "name": .string("Default"), "kind": .string("k"), "default": .bool(true),
            "nodeCounts": counts, "sandboxCapacity": .object(["used": .number(0), "total": .null])]), "nodes": .array([])]).decode(as: ComputePoolDetail.self)))), granted: nil)
        XCTAssertEqual(empty.lines.last, .init("No machines yet", .muted))
        XCTAssertEqual(empty.buttons.map(\.label), ["Create join commands"])
    }

    func testTheDefaultModelCardReadsTheConfiguration() throws {
        let config: JSONValue = .object(["config": .object([
            "defaults": .object(["providerId": .string("claude"), "modelId": .string("opus"), "effort": .string("high"), "permissionMode": .string("auto")]),
            "models": .object(["opus": .object(["name": .string("Claude Opus"), "efforts": .array([.string("low"), .string("high")])])]),
            "providers": .object(["claude": .object(["type": .string("claude"), "enabled": .bool(true), "models": .array([.object(["id": .string("opus"), "enabled": .bool(true)])])])]),
        ])])
        let defaults = try XCTUnwrap(UiModelDefaults(response: JSONEncoder().encode(config)))
        XCTAssertEqual(defaults.title, "Claude Opus · high")
        XCTAssertEqual(defaults.choices.map(\.model.id), ["opus"])
        let card = UiCard.make(live("default_model", live: .defaults(defaults)), granted: nil)
        XCTAssertEqual(card.lines, [.init("Claude Opus · high")])
        XCTAssertEqual(card.buttons, [.init("Change", .pickModel)])
        XCTAssertEqual(UiCard.make(live("default_model", live: .defaults(defaults)), granted: ["content.write"]).buttons.map(\.enabled), [false])
    }

    func testASecretPayloadIsLeftOutOfWhatIsKept() {
        let token = UiAction(type: "provider_sign_in.submit_token", payload: .object(["token": .string("sk-ant-oat-1")]))
        XCTAssertEqual(UiCatalog.redacted(token), UiAction(type: "provider_sign_in.submit_token", payload: .object([:])))
        let model = UiAction(type: "default_model.set", payload: .object(["providerId": .string("claude"), "modelId": .string("opus"), "effort": .string("high")]))
        XCTAssertEqual(UiCatalog.redacted(model), model)
    }

    /// A sign-in drawn from the computer's provider CLI, moved by its
    /// events (an older one ignored); a pasted token goes to `/actions`
    /// alone, never into what the conversation draws, and its refusal is
    /// the card's last line.
    func testALiveSignInFollowsItsProviderCliAndShowsItsAttempt() async throws {
        let document: JSONValue = .object(["id": .string("u1"), "components": .array([
            .object(["id": .string("sign"), "type": .string("provider_sign_in"), "fallback": .string("Sign in to Claude"), "props": .object(["provider": .string("claude")])]),
        ])])
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([
                .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([.object(["type": .string("ui"), "ui": document])])]),
            ])]),
        ])
        await server.read("/v0/provider-clis/claude", .object(["providerCli": Self.providerCli(version: "01991f3a-0000")]))
        await server.answer(.object([
            "record": .object(["id": .string("k1"), "role": .string("service"), "createdAt": .number(5), "content": .array([.object([
                "type": .string("action"), "messageId": .string("a1"), "uiId": .string("u1"), "componentId": .string("sign"),
                "action": .object(["type": .string("provider_sign_in.submit_token"), "payload": .object([:])]),
                "outcome": .object(["status": .string("rejected"), "code": .string("token_rejected"), "reason": .string("Claude didn't accept this token.")]),
            ])])]),
            "result": .null, "cursor": .null,
        ]))
        var (conversation, updates, store) = await openWithStore(server)
        let read = await next(&updates) { self.shown($0, "sign")?.live != nil }
        guard case .provider(let cli)? = shown(read, "sign")?.live else { return XCTFail() }
        XCTAssertEqual(cli.signIn, "signed_out")

        await store.externalEvent(.object(["type": .string("provider_cli.updated"), "payload": .object(["providerCli": Self.providerCli(version: "01991f3a-0002", operation: Self.waiting)])]))
        let moved = await next(&updates) { if case .provider(let cli)? = self.shown($0, "sign")?.live { cli.operation != nil } else { false } }
        XCTAssertEqual(UiCard.make(try XCTUnwrap(shown(moved, "sign")), granted: nil).buttons.map(\.label), ["Open page", "Paste code", "Cancel"])
        // An older reading changes nothing.
        await store.externalEvent(.object(["type": .string("provider_cli.updated"), "payload": .object(["providerCli": Self.providerCli(version: "01991f3a-0001", signIn: "signed_in")])]))

        let secret = "sk-ant-oat01-secret"
        let sign = try XCTUnwrap(shown(moved, "sign"))
        let pressing = Task { await conversation.act(sign, action: UiAction(type: "provider_sign_in.submit_token", payload: .object(["token": .string(secret)]))) }
        var seen: [ChatSnapshot] = []
        let refused = await next(&updates) { snapshot in
            seen.append(snapshot)
            return self.shown(snapshot, "sign")?.state.attempt?.outcome.status == "rejected"
        }
        _ = await pressing.value
        XCTAssertFalse(seen.contains { String(describing: $0.items).contains(secret) })
        let card = UiCard.make(try XCTUnwrap(shown(refused, "sign")), granted: nil)
        XCTAssertEqual(card.lines, [.init("Claude didn't accept this token.", .error)])
        XCTAssertEqual(card.buttons.map(\.label), ["Use a token", "Try again"])
        guard case .provider(let still)? = shown(refused, "sign")?.live else { return XCTFail() }
        XCTAssertNotNil(still.operation, "the older reading was ignored")
        // No bubble for a silent action.
        XCTAssertFalse(refused?.items.contains { $0.role == .user } ?? true)
        let sent = await server.actions
        XCTAssertEqual(sent.first?["action"]?["payload"]?["token"], .string(secret))
        await conversation.stop()
    }

    /// A result, the one place a secret comes back, goes to the caller and
    /// never into the conversation.
    func testAResultGoesToTheCallerAlone() async throws {
        let document: JSONValue = .object(["id": .string("u1"), "components": .array([
            .object(["id": .string("invite"), "type": .string("invite"), "fallback": .string("Invite a teammate"), "props": .object([:])]),
        ])])
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([
                .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([.object(["type": .string("ui"), "ui": document])])]),
            ])]),
        ])
        let result: JSONValue = .object(["inviteId": .string("i1"), "code": .string("J7K-Q2"), "expiresAt": .number(9), "serverName": .null])
        await server.answer(.object([
            "record": .object(["id": .string("k1"), "role": .string("service"), "createdAt": .number(5), "content": .array([.object([
                "type": .string("action"), "messageId": .string("a1"), "uiId": .string("u1"), "componentId": .string("invite"),
                "action": .object(["type": .string("invite.create"), "payload": .object(["role": .string("member")])]),
                "outcome": .object(["status": .string("accepted")]),
            ])])]),
            "result": result, "cursor": .null,
        ]))
        var (conversation, updates) = await open(server)
        let first = await next(&updates) { self.shown($0, "invite") != nil }
        let invite = try XCTUnwrap(shown(first, "invite"))
        let answer = await conversation.act(invite, action: UiAction(type: "invite.create", payload: .object(["role": .string("member")])))
        XCTAssertEqual(answer.accepted, true)
        XCTAssertEqual(answer.result, result)
        let after = await next(&updates) { self.shown($0, "invite")?.state.attempt?.outcome.status == "accepted" }
        XCTAssertFalse(String(describing: after?.items ?? []).contains("J7K-Q2"))
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

    init(history: [JSONValue]) { self.history = history }

    func answer(_ body: JSONValue) { answerBody = body }

    /// What the next read of the messages finds.
    func move(to history: [JSONValue]) { self.history = history }

    func read(_ path: String, _ body: JSONValue) { reads[path] = body }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        protocols.append(headers[ChatUi.protocolHeader])
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(history)])
        } else if path.hasSuffix("/bootstrap") {
            value = reads["/bootstrap"] ?? .object(["agent": .object(["id": .string("agent"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else if path.hasSuffix("/actions") {
            if let body { actions.append(try JSONValue.decode(body)) }
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
