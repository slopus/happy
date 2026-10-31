import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// Inline `<menu>` actions and questions as ChoiceLists (API.md, "Inline actions").
final class ChatActionsTests: XCTestCase {
    static let example = "Ready to push?\n\n<menu>\n  <button data-action=\"reply\" data-emphasis>Push it</button>\n  <button data-action=\"reply\">Not yet</button>\n</menu>"

    /// happy-agent-client's vectors: each menu in order, null for a broken one; only `reply` acts.
    func testTheSharedVectors() throws {
        let url = Bundle.module.url(forResource: "chat-action-blocks", withExtension: "json", subdirectory: "Fixtures")!
        for vector in try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: url)) {
            let segments = ChatActions.split(vector["markdown"]?.stringValue ?? "", streaming: false)
            XCTAssertEqual(.array(segments.compactMap {
                switch $0 {
                case .text: nil
                case .broken: .null
                case .menu(let buttons): .object(["kind": "menu", "buttons": .array(buttons.map { .object(["label": .string($0.label)].merging($0.actionId != "reply" ? [:] : ["action": .object(
                    ["id": "reply", "params": .object($0.params.mapValues { .string($0) }), "text": .string($0.text)])]) { $1 }) })])
                }
            }), vector["blocks"], vector["name"]?.stringValue ?? "")
            XCTAssertEqual(segments.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n\n"), vector["stripped"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        XCTAssertEqual(ChatActions.split("Ready?\n\n<menu>\n  <button data-action=\"reply\">Go", streaming: true), [.text("Ready?")])
    }

    /// Beyond the vectors: no handlers, style or stray text; comments go, `<br>` is a space, the first button is primary whatever `data-emphasis` says.
    func testTheGrammarIsClosed() {
        for html in [#"<menu><button onclick="x">A</button></menu>"#, #"<menu><button style="x">A</button></menu>"#, "<menu>stray<button>A</button></menu>"] { XCTAssertNil(ChatActions.menu(html), html) }
        let buttons = ChatActions.menu("<menu><!-- c --><button>One<br>two</button><BUTTON data-emphasis>X</BUTTON></menu>")
        XCTAssertEqual(buttons, [.init(label: "One two"), .init(label: "X")])
        XCTAssertEqual(ChatActions.choices(buttons ?? [], messageId: "m", blockIndex: 0, choice: nil, pressed: nil).emphasized, 0)
        XCTAssertEqual(ChatActions.press(.init(label: "Shorter", actionId: "reply", params: ["tone": "short"]), messageId: "m", blockIndex: 1, controlIndex: 2), json(
            #"{"type":"action","messageId":"m","blockIndex":1,"controlIndex":2,"actionId":"reply","params":{"tone":"short"}}"#))
    }

    func testActionChoicesLockTheMenuAndOnlyKnownActionsPress() {
        func block(_ choice: JSONValue?, pressed: Int? = nil) -> ChoiceBlock { ChatActions.choices([.init(label: "Push", actionId: "reply"), .init(label: "Pick", actionId: "pick"), .init(label: "None")], messageId: "m", blockIndex: 0, choice: choice, pressed: pressed) }
        XCTAssertEqual(block(json(#"{"kind":"button","index":1}"#)).chosen, [1])
        XCTAssertEqual(block(json(#"{"kind":"checklist","values":[]}"#)).chosen, [])
        XCTAssertEqual([block(nil, pressed: 0).chosen, block(nil).chosen], [[0], nil])
        XCTAssertEqual(block(nil).options.map(\.pressable), [true, false, false])
    }

    func testAQuestionIsAChoiceList() {
        let tone = AgentQuestion(id: "q1", header: "Tone", question: "Which tones?", options: [.init(label: "Warm"), .init(label: "Plain"), .init(label: "Other")], multiSelect: true)
        let open = ChatActions.question(tone, source: .question(id: "Q", prompt: "q1"), answer: nil, picked: [1], typed: "Dry", context: "For the launch")
        XCTAssertEqual(open.options.map(\.label), ["Warm", "Plain", "Dry"])
        XCTAssertEqual([open.picked, open.multi ? [1] : []], [[1, 2], [1]])
        XCTAssertTrue(open.chosen == nil && open.context == "For the launch")
        XCTAssertEqual(ChatActions.question(tone, source: .answered, answer: ["Plain", "Dry"]).chosen, [1, 2])
    }

    /// Off, the chat is main's. On, a refused press (400) is taken back; one already chosen elsewhere
    /// (409) adopts the daemon's choice; one that lands settles into the person's text message.
    func testThePhonesPressLandsAsThePersonsMessage() async {
        let server = ActionServer(), (conversation, engine) = open(server)
        var updates = conversation.updates.makeAsyncIterator()
        func menu(_ snapshot: ChatSnapshot?, _ at: Int) -> ChoiceBlock? { if case .choices(let block) = snapshot?.items[at].pieces.last { block } else { nil } }
        await conversation.start(); await conversation.setVisible(true)
        let off = await Self.next(&updates) { $0.loaded && $0.items.count == 3 }
        XCTAssertTrue(off?.items.last?.pieces == [.text(Self.example)] && off?.items.first?.storyReply == nil)
        await conversation.setActions(true)
        let on = await Self.next(&updates) { $0.items.last?.pieces.count == 2 }
        XCTAssertEqual(on?.items.first?.storyReply, "s1")
        // The second is the manager's (`boss`): its lane stays, its menu presses as block 0.
        guard let first = menu(on, 1)?.source, let second = menu(on, 2)?.source, on?.items[2].role == .user else { return XCTFail() }
        await server.answering(400); await conversation.choose(second, 1)
        let refused = await Self.next(&updates) { $0.error != nil }
        XCTAssertTrue(refused?.items.count == 3 && menu(refused, 2)?.chosen == nil)
        await server.answering(409); await conversation.choose(first, 1)
        _ = await Self.next(&updates) { menu($0, 1)?.chosen == [0] && $0.items.count == 3 }
        await server.answering(200); await conversation.choose(second, 1)
        let sent = await server.sent, id = sent?["id"]?.stringValue ?? ""
        XCTAssertEqual(sent?["content"], json(#"[{"type":"action","messageId":"m2","blockIndex":0,"controlIndex":1,"actionId":"reply","params":{}}]"#))
        XCTAssertTrue(sent?["text"] == nil && sent?["mode"] != nil)
        await engine.spaces.externalEvent(json(#"{"type":"message.updated","payload":{"agentId":"a","message":\#(ActionServer.message("m2", "agent", Self.example, choice: 1))}}"#))
        let landed = await Self.next(&updates) { $0.items.last?.id == id && $0.items.last?.delivery == .sent && menu($0, 2)?.chosen == [1] }
        XCTAssertEqual(landed?.items.filter { $0.text == "Not yet" }.map(\.role), [.user])
        await conversation.stop()
    }

    /// Menus count as the daemon counts them, over the text as stored: one inside a media layout is
    /// no block, and a manager's 4-space-indented one after its sender line stays words.
    func testMenusCountOverTheStoredText() async {
        let layout = "<div><img src=\"a.png\">\n<menu><button data-action=\"reply\">In</button></menu>\n</div>\n\n" + Self.example
        let server = ActionServer(extra: [ActionServer.message("m3", "agent", layout), ActionServer.message("m2b", "agent", "Message from agent boss:\n    <menu><button data-action=\"reply\">Go</button></menu>")])
        let (conversation, _) = open(server)
        var updates = conversation.updates.makeAsyncIterator()
        await conversation.start(); await conversation.setVisible(true); await conversation.setActions(true)
        let on = await Self.next(&updates) { $0.items.count == 5 && $0.items[3].pieces.contains { if case .choices = $0 { true } else { false } } }
        let blocks = on?.items[3].pieces.compactMap { if case .choices(let block) = $0, case .menu(_, let index, _) = block.source { index } else { nil } }
        XCTAssertEqual(blocks, [0])
        XCTAssertFalse(on?.items[4].pieces.contains { if case .choices = $0 { true } else { false } } ?? true)
        await conversation.stop()
    }

    /// Words begun for a prompt answered elsewhere first stay in the composer, sent nowhere.
    func testWordsForAQuestionAnsweredElsewhereStay() async {
        let server = ActionServer(question: true), (conversation, engine) = open(server)
        var updates = conversation.updates.makeAsyncIterator()
        await conversation.start(); await conversation.setVisible(true)
        await conversation.setActions(true)
        let asked = await Self.next(&updates) { $0.answering == "Which day?" && $0.answeringFor != nil }
        await engine.spaces.externalEvent(json(#"{"type":"agent.updated","payload":{"agentId":"a","changes":{"pendingQuestionId":null}}}"#))
        _ = await Self.next(&updates) { $0.answeringFor == nil }
        let accepted = await conversation.send(text: "Friday", answering: asked?.answeringFor); XCTAssertFalse(accepted)
        let paths = await server.paths; XCTAssertFalse(paths.contains { $0.hasSuffix("/send") || $0.hasSuffix("/answer") })
        await conversation.stop()
    }

    private static func next(_ updates: inout AsyncStream<ChatSnapshot>.Iterator, _ until: (ChatSnapshot) -> Bool) async -> ChatSnapshot? {
        while let snapshot = await updates.next() { if until(snapshot) { return snapshot } }; return nil }
    private func open(_ server: ActionServer) -> (Conversation, SyncEngine) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        return (Conversation(client: client, store: engine.spaces, agentId: "a", mode: .init(providerId: "p", modelId: "m", effort: "e", serviceTier: nil, permissionMode: "default")), engine)
    }
}

private func json(_ text: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }

/// A daemon with two agent messages holding a menu, after a reply to a story; with `question`, one pending.
/// A press answers `status`; a 409 is another's choice of the first menu's first button.
private actor ActionServer: AgentTransport {
    var paths: [String] = [], sent: JSONValue?, status = 200, taken = false
    let question: Bool, extra: [String]; init(question: Bool = false, extra: [String] = []) { (self.question, self.extra) = (question, extra) }
    func answering(_ status: Int) { self.status = status }
    static func message(_ id: String, _ role: String, _ text: String, choice: Int? = nil) -> String {
        #"{"id":"\#(id)","role":"\#(role)","createdAt":1,"metadata":\#(id.hasPrefix("m2") ? #"{"senderAgentId":"boss"}"# : "{}"),"content":[{"type":"text","text":\#(String(decoding: try! JSONEncoder().encode(text), as: UTF8.self))}],"replyTo":{"kind":"story","artifactId":"s1"}\#(choice.map { #","actionChoices":{"0":{"kind":"button","index":\#($0)}}"# } ?? "")}"#
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        paths.append(path)
        var value = "{}"
        if path.contains("/messages?") {
            value = #"{"hasMore":false,"runs":[{"id":"r","status":"completed","startedAt":0,"messages":[\#(Self.message("u", "user", "Love it")),\#(Self.message("m", "agent", ChatActionsTests.example, choice: taken ? 0 : nil)),\#(([Self.message("m2", "agent", ChatActionsTests.example)] + extra).joined(separator: ","))]}]}"#
        } else if path.contains("/bootstrap") {
            value = #"{"agent":{"id":"a","workspaceId":"w","parentAgentId":"boss","status":"idle"\#(question ? #","pendingQuestionId":"q1""# : "")},"pending":[]}"#
        } else if path.hasSuffix("/question") {
            value = #"{"question":{"id":"q1","context":"For the launch","questions":[{"id":"p1","header":"Day","question":"Which day?","options":[]}]}}"#
        } else if path.hasSuffix("/send"), let body {
            taken = taken || status == 409; guard status == 200 else { return .init(status: status, body: Data("{}".utf8)) }
            sent = try JSONDecoder().decode(JSONValue.self, from: body)
            value = #"{"cursor":"c","message":{"id":"\#(sent?["id"]?.stringValue ?? "")","role":"user","createdAt":2,"metadata":{},"content":[{"type":"text","text":"Not yet"}]}}"#
        }
        return .init(status: 200, body: Data(value.utf8))
    }
    func close() {}
}
