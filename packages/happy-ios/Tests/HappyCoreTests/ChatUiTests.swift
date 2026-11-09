import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Chat UI against `@slopus/happy-agent-client`'s own vectors
/// (`fixtures/ui/actions.fixtures.json` and `ui.schema.json`, copied as
/// `chat-ui-actions.json` and `chat-ui-schema.json` from happy-agent
/// `chat-ui-actions` 39bb1c512), and a conversation drawing and pressing it.
final class ChatUiTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.decode(Data(contentsOf: url))
    }

    private func action(_ value: JSONValue?) throws -> UiAction {
        try XCTUnwrap(value).decode(as: UiAction.self)
    }

    // MARK: The client's vectors

    func testActionTextIsTheClientsWordForWord() throws {
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["actionText"]?.arrayValue)
        XCTAssertEqual(vectors.count, 5)
        for vector in vectors {
            let component = try XCTUnwrap(vector["component"])
            let text = UiCatalog.text(type: component["type"]?.stringValue ?? "", props: component["props"] ?? .null, action: try action(vector["action"]))
            XCTAssertEqual(text, vector["text"]?.stringValue, "\(vector)")
        }
    }

    func testTheOpenOfferRuleIsTheClients() throws {
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["openOffer"]?.arrayValue)
        XCTAssertEqual(vectors.count, 6)
        for vector in vectors {
            let state = UiCatalog.offerState(
                once: vector["once"]?.boolValue ?? false, accepted: try vector["accepted"].map { try $0.decode(as: UiAction.self) },
                personSpokeAfter: vector["personSpokeAfter"]?.boolValue ?? false, action: try action(vector["action"])
            )
            XCTAssertEqual(state.rawValue, vector["state"]?.stringValue, "\(vector)")
        }
    }

    /// The owner holds every permission, a member the member set, a viewer
    /// none: only reading the conversation is left to them.
    func testPermissionsResolveAsTheClientsForOwnerMemberAndViewer() throws {
        let schema = try fixture("chat-ui-schema")
        let member = Set(try XCTUnwrap(schema["memberPermissions"]?.arrayValue).compactMap(\.stringValue))
        let vectors = try XCTUnwrap(fixture("chat-ui-actions")["permission"]?.arrayValue)
        XCTAssertEqual(vectors.count, 28)
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

    /// Every action the schema declares, with its transcript, `once` and
    /// permission, and no other.
    func testTheCatalogIsTheSchemas() throws {
        let components = try XCTUnwrap(fixture("chat-ui-schema")["components"]?.objectValue)
        var declared: Set<String> = []
        for (type, component) in components {
            for (name, definition) in component["actions"]?.objectValue ?? [:] {
                let key = "\(type).\(name)"
                declared.insert(key)
                let ours = try XCTUnwrap(UiCatalog.actions[key], key)
                XCTAssertEqual(ours.message, definition["transcript"]?.stringValue == "message", key)
                XCTAssertEqual(ours.once, definition["once"]?.boolValue ?? false, key)
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

    func testActionBlocksAndUiPresentationsReadAndKeep() throws {
        let json = #"""
        {"id":"m","role":"agent","createdAt":1,"content":[
          {"type":"action","messageId":"a1","uiId":"u1","componentId":"pick","action":{"type":"choice.choose","payload":{"optionId":"fix"}},"outcome":{"status":"rejected","code":"offer_closed","reason":"Already answered.","messageId":"m9"}},
          {"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u2","components":[{"id":"x","type":"slideshow","fallback":"Slides","props":{}}]},"items":[]}},
          {"type":"ui","ui":{"components":[]}}
        ]}
        """#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        guard case .action(let block) = message.content[0] else { return XCTFail("no action") }
        XCTAssertEqual(block.offer, UiOffer(messageId: "a1", uiId: "u1", componentId: "pick"))
        XCTAssertEqual(block.outcome, UiOutcome(status: "rejected", code: "offer_closed", reason: "Already answered.", messageId: "m9"))
        guard case .toolCall(_, _, _, let presentation, _, _, _, _) = message.content[1] else { return XCTFail("no call") }
        XCTAssertEqual(presentation?.ui?.components.first?.type, "slideshow")
        // A document that can't be read is skipped, never the message.
        XCTAssertEqual(message.content[2], .unknown("ui"))
        let kept = try JSONDecoder().decode(AgentWire.Message.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(kept.content[0], message.content[0])
        XCTAssertEqual(kept.content[1], message.content[1])
    }

    // MARK: Pieces

    private let offer = UiOffer(messageId: "a1", uiId: "u1", componentId: "c")

    private func component(_ type: String, _ props: JSONValue, fallback: String = "Fallback") -> UiComponent {
        UiComponent(id: "c", type: type, fallback: fallback, props: props)
    }

    func testAComponentThePhoneDoesntDrawIsItsFallbackLineAndThePhoneAppNothing() {
        let live = UiShown.pieces(component("provider_sign_in", .object(["provider": .string("claude")]), fallback: "Sign in to Claude in Happy on your computer"), document: "u1", message: "a1", media: [])
        XCTAssertEqual(live, [.ui(UiShown(offer: offer, type: "provider_sign_in", props: .object(["provider": .string("claude")]), kind: .line("Sign in to Claude in Happy on your computer")))])
        XCTAssertEqual(UiShown.pieces(component("slideshow", .object([:])), document: "u1", message: "a1", media: []).count, 1)
        XCTAssertEqual(UiShown.pieces(component("phone_app", .object([:])), document: "u1", message: "a1", media: []), [])
        // Props a known type can't be drawn from: its fallback too.
        guard case .ui(let broken)? = UiShown.pieces(component("choice", .object(["options": .array([])])), document: "u1", message: "a1", media: []).first else { return XCTFail() }
        XCTAssertEqual(broken.kind, .line("Fallback"))
    }

    func testImagesAreAGridOfTheCallsItemsWithTheirCaptions() {
        let item = AgentWire.MediaItem(kind: "image", name: "a.png", mimeType: "image/png")
        let media = (0..<3).map { Media(toolCallId: "call", index: $0, item: item) }
        let props: JSONValue = .object(["columns": .number(3), "images": .array([
            .object(["mediaIndex": .number(2), "caption": .string("Login")]), .object(["mediaIndex": .number(0)]),
        ])])
        let pieces = UiShown.pieces(component("images", props), document: "u1", message: "a1", media: media)
        XCTAssertEqual(pieces.first, .gallery([media[2], media[0]], columns: 3))
        XCTAssertEqual(pieces.count, 2)
        // An index past the items: the fallback, never a hole.
        let missing = UiShown.pieces(component("images", .object(["images": .array([.object(["mediaIndex": .number(5)])])])), document: "u1", message: "a1", media: media)
        guard case .ui(let line)? = missing.first else { return XCTFail() }
        XCTAssertEqual(line.kind, .line("Fallback"))
    }

    func testAFileTreeIsItsFoldersOnceBeforeWhatIsInThem() {
        XCTAssertEqual(UiFileTree.rows(["src/app/main.ts", "src/app/util.ts", "README.md", "src/lib/"]), [
            .init(depth: 0, name: "src", folder: true), .init(depth: 1, name: "app", folder: true),
            .init(depth: 2, name: "main.ts", folder: false), .init(depth: 2, name: "util.ts", folder: false),
            .init(depth: 1, name: "lib", folder: true), .init(depth: 0, name: "README.md", folder: false),
        ])
    }

    // MARK: A conversation

    private static let choiceDocument: JSONValue = .object(["id": .string("u1"), "components": .array([
        .object(["id": .string("pick"), "type": .string("choice"), "fallback": .string("Fix · Tests"), "props": .object(["options": .array([
            .object(["id": .string("fix"), "label": .string("Fix the login redirect"), "primary": .bool(true)]),
            .object(["id": .string("tests"), "label": .string("Run the tests")]),
        ])])]),
        .object(["id": .string("sign"), "type": .string("provider_sign_in"), "fallback": .string("Sign in to Claude in Happy on your computer"), "props": .object(["provider": .string("claude")])]),
    ])])

    private func open(_ server: ChatUiServer) async -> (Conversation, AsyncStream<ChatSnapshot>.AsyncIterator) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let mode = AgentWire.Mode(providerId: "claude", modelId: "opus", effort: "high", serviceTier: nil, permissionMode: "auto")
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "agent", mode: mode)
        let updates = conversation.updates.makeAsyncIterator()
        await conversation.start()
        return (conversation, updates)
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

    /// A choice in the daemon's message is drawn, with the live component
    /// beside it as its fallback line; a press is the person's bubble at
    /// once, sent through `/actions` with `Happy-Protocol: 35` like every
    /// request, and then the answer ticks the option and closes the offer.
    func testAPressIsTheBubbleAtOnceThenTheAnswer() async throws {
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "messages": .array([
                .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([
                    .object(["type": .string("text"), "text": .string("What next?")]), .object(["type": .string("ui"), "ui": Self.choiceDocument]),
                ])]),
            ])]),
        ])
        await server.answer(.object([
            "record": .object(["id": .string("k1"), "role": .string("service"), "createdAt": .number(2), "content": .array([.object([
                "type": .string("action"), "messageId": .string("a1"), "uiId": .string("u1"), "componentId": .string("pick"),
                "action": .object(["type": .string("choice.choose"), "payload": .object(["optionId": .string("fix")])]),
                "outcome": .object(["status": .string("accepted"), "messageId": .string("m2")]),
            ])])]),
            "message": .object(["id": .string("m2"), "role": .string("user"), "createdAt": .number(2), "status": .string("pending"), "content": .array([
                .object(["type": .string("text"), "text": .string("Fix the login redirect")]),
            ])]),
            "result": .null, "cursor": .null,
        ]))
        var (conversation, updates) = await open(server)
        let first = await next(&updates) { self.shown($0) != nil }
        let choice = try XCTUnwrap(shown(first))
        XCTAssertEqual(choice.kind, .choice([.init(id: "fix", label: "Fix the login redirect", primary: true), .init(id: "tests", label: "Run the tests")]))
        XCTAssertEqual(choice.state, UiShown.State())
        XCTAssertEqual(shown(first, "sign")?.kind, .line("Sign in to Claude in Happy on your computer"))
        XCTAssertEqual(first?.items.first?.text, "What next?")

        await conversation.act(choice, action: UiAction(type: "choice.choose", payload: .object(["optionId": .string("fix")])))
        let answered = await next(&updates) { self.shown($0)?.state.answer != nil }
        XCTAssertEqual(shown(answered)?.state.answer, .object(["optionId": .string("fix")]))
        XCTAssertEqual(shown(answered)?.state.closed, true)
        let bubble = answered?.items.last
        XCTAssertEqual(bubble?.id, "m2")
        XCTAssertEqual(bubble?.text, "Fix the login redirect")
        XCTAssertEqual(bubble?.delivery, .pending)

        let sent = await server.actions
        XCTAssertEqual(sent.count, 1)
        let body = try XCTUnwrap(sent.first)
        XCTAssertEqual(body["messageId"], .string("a1"))
        XCTAssertEqual(body["uiId"], .string("u1"))
        XCTAssertEqual(body["componentId"], .string("pick"))
        XCTAssertEqual(body["action"], .object(["type": .string("choice.choose"), "payload": .object(["optionId": .string("fix")])]))
        XCTAssertEqual(body["mode"]?["modelId"], .string("opus"))
        let protocols = await server.protocols
        XCTAssertFalse(protocols.isEmpty)
        XCTAssertTrue(protocols.allSatisfy { $0 == "35" }, "\(protocols)")

        // Answered, it takes no second press.
        await conversation.act(try XCTUnwrap(shown(answered)), action: UiAction(type: "choice.choose", payload: .object(["optionId": .string("tests")])))
        let after = await server.actions
        XCTAssertEqual(after.count, 1)
        await conversation.stop()
    }

    /// A press the computer refuses stays as its greyed bubble, and so does
    /// a refused record read from history; a person's message after an
    /// offer closes it.
    func testARefusedPressStaysGreyed() async throws {
        let rejected: JSONValue = .object(["status": .string("rejected"), "code": .string("offer_closed"), "reason": .string("Already answered.")])
        func record(_ id: String, option: String) -> JSONValue {
            .object(["id": .string(id), "role": .string("service"), "createdAt": .number(3), "content": .array([.object([
                "type": .string("action"), "messageId": .string("a1"), "uiId": .string("u1"), "componentId": .string("pick"),
                "action": .object(["type": .string("choice.choose"), "payload": .object(["optionId": .string(option)])]), "outcome": rejected,
            ])])])
        }
        let server = ChatUiServer(history: [
            .object(["id": .string("r1"), "status": .string("completed"), "endedAt": .number(2), "messages": .array([
                .object(["id": .string("a1"), "role": .string("agent"), "createdAt": .number(1), "content": .array([.object(["type": .string("ui"), "ui": Self.choiceDocument])])]),
            ])]),
            .object(["id": .string("r2"), "status": .string("completed"), "endedAt": .number(3), "messages": .array([
                .object(["id": .string("u2"), "role": .string("user"), "createdAt": .number(2), "content": .array([.object(["type": .string("text"), "text": .string("Never mind")])])]),
            ])]),
            .object(["id": .string("r3"), "status": .string("completed"), "endedAt": .number(3), "messages": .array([record("k0", option: "tests")])]),
        ])
        await server.answer(.object(["record": record("k1", option: "fix"), "message": .null, "result": .null, "cursor": .null]))
        var (conversation, updates) = await open(server)
        let first = await next(&updates) { self.shown($0) != nil }
        // The record's run is no turn: no "Completed" row for it.
        XCTAssertNil(first?.items.first { $0.id == "r3:status" })
        let old = try XCTUnwrap(first?.items.first { $0.id == "k0" })
        XCTAssertEqual(old.text, "Run the tests")
        XCTAssertEqual(old.delivery, .refused("Already answered."))
        var choice = try XCTUnwrap(shown(first))
        XCTAssertTrue(choice.state.closed, "the person wrote after it")

        // Pressed anyway (a stale screen): sent, refused, kept greyed.
        choice.state = UiShown.State()
        await conversation.act(choice, action: UiAction(type: "choice.choose", payload: .object(["optionId": .string("fix")])))
        let refused = await next(&updates) { $0.items.contains { $0.text == "Fix the login redirect" && $0.delivery == .refused("Already answered.") } }
        let bubble = try XCTUnwrap(refused?.items.last)
        XCTAssertEqual(bubble.text, "Fix the login redirect")
        XCTAssertEqual(bubble.delivery, .refused("Already answered."))
        await conversation.stop()
    }
}

/// A daemon with one conversation's history and a `/actions` answer, that
/// keeps what was sent there and every request's `Happy-Protocol`.
private actor ChatUiServer: AgentTransport {
    let history: [JSONValue]
    private var answerBody: JSONValue = .object([:])
    private(set) var actions: [JSONValue] = []
    private(set) var protocols: [String?] = []

    init(history: [JSONValue]) { self.history = history }

    func answer(_ body: JSONValue) { answerBody = body }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        protocols.append(headers[ChatUi.protocolHeader])
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(history)])
        } else if path.hasSuffix("/bootstrap") {
            value = .object(["agent": .object(["id": .string("agent"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
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
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
