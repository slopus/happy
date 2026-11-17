import Foundation
import HappyWire
import XCTest
@testable import HappyCore

final class GenUIMessageTests: XCTestCase {
    func testCanonicalDocumentSurvivesMessageHistoryAndTurnFolding() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "01-stats.render", withExtension: "json", subdirectory: "Fixtures/GenUI"))
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        let presentation = AgentWire.Presentation(type: "gen_ui", document: json)
        let message = AgentWire.Message(id: "m", role: "agent", createdAt: 0, content: [.toolCall(id: "call", name: "gen_ui", status: "completed", presentation: presentation)])
        let restored = try JSONDecoder().decode(AgentWire.Message.self, from: JSONEncoder().encode(message))
        guard case .toolCall(_, _, _, let read, _, _, _, _) = restored.content[0] else { return XCTFail("lost tool call") }
        XCTAssertEqual(read?.document, json)
        let document = GenUIMessage.document(read?.document)
        XCTAssertNotNil(document.tree())
        let tool = ChatItem.Tool(name: "gen_ui", status: "completed", presentation: read, callId: "call")
        let item = ChatItem(id: "ui", role: .tool(tool), pieces: [.genUI(toolCallId: "call", document: document)], delivery: .sent, turn: "run")
        let step = ChatItem(id: "step", role: .tool(.init(name: "read", status: "completed")), pieces: [], delivery: .sent, turn: "run")
        let answer = ChatItem(id: "answer", role: .agent, pieces: [.text("Done")], delivery: .sent, turn: "run")
        let end = ChatItem(id: "end", role: .turnEnd(.init(reason: "completed", durationMs: 10, tools: 2, copyText: "Done")), pieces: [], delivery: .sent, turn: "run")
        for grouped in [false, true] {
            var memory = ToolSections.Memory()
            let rows = TurnFold.shown([step, item, answer, end], working: false, queued: 0, grouped: grouped, expanded: [], memory: &memory)
            XCTAssertTrue(rows.contains { $0.id == "ui" })
        }
        XCTAssertFalse(ToolRaw.keeps(name: "gen_ui", presentation: "gen_ui"))
        XCTAssertTrue(ToolRaw.keeps(name: "ui", presentation: "ui"))
    }

    func testMalformedAndUnsupportedDocumentsFallBackAndActionsStayUnprivileged() {
        XCTAssertNil(GenUIMessage.document(.string("broken")).tree())
        XCTAssertEqual(GenUIMessage.document(.object(["genuiRender": .number(1)])).fallback, "Gen UI")
        let future = GenUIMessage.document(.object(["genuiRender": .number(2), "fallback": .string("Future summary")]))
        XCTAssertNil(future.tree())
        XCTAssertEqual(future.fallback, "Future summary")
        XCTAssertTrue(GenUIMessage.enables(.message("Continue")))
        XCTAssertTrue(GenUIMessage.enables(.copy("Copy")))
        XCTAssertTrue(GenUIMessage.enables(.open("https://example.com")))
        XCTAssertFalse(GenUIMessage.enables(.open("javascript:alert(1)")))
        XCTAssertFalse(GenUIMessage.enables(.open("file:///secret")))
        XCTAssertFalse(GenUIMessage.enables(.plugin(id: "p")))
        XCTAssertFalse(GenUIMessage.enables(.tool(name: "delete", input: .object([:]))))
        XCTAssertFalse(GenUIMessage.enables(.secret(.init(variables: [.init(name: "TOKEN")]))))
        XCTAssertFalse(GenUIMessage.enables(.clusterSecret(.init(kind: .environment, name: "secret"))))
        XCTAssertFalse(GenUIMessage.enables(.unsupported))
        for url in ["https:example.com", " https://example.com", "https://user:pass@example.com", "https://example.com\\evil", "https://example.com/\n"] {
            XCTAssertFalse(GenUIMessage.enables(.open(url)), url)
        }
    }

    func testMessageLimitsAndImageRefusal() {
        func document(_ elements: [String: JSONValue], version: Double = 1) -> GenUIRenderDocument {
            GenUIMessage.document(.object(["genuiRender": .number(version), "fallback": .string("Summary"), "root": .string("root"), "elements": .object(elements)]))
        }
        let text: JSONValue = .object(["type": .string("text"), "props": .object(["spans": .array([.object(["text": .string("Hello")])])])])
        XCTAssertNil(document(Dictionary(uniqueKeysWithValues: (0...4000).map { ("e\($0)", text) })).tree())
        let image: JSONValue = .object(["type": .string("image"), "props": .object(["file": .string("https://example.com/private.png")])])
        XCTAssertNil(document(["root": image]).tree())
        XCTAssertNil(document(["root": text], version: 1e100).tree())
        let large: JSONValue = .object(["type": .string("code"), "props": .object(["text": .string(String(repeating: "x", count: 4 * 1024 * 1024))])])
        XCTAssertEqual(document(["root": large]).fallback, "Summary")
        XCTAssertNil(document(["root": large]).tree())
    }
}