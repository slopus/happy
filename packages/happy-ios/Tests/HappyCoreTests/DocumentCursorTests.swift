import Foundation
@testable import HappyCore
import XCTest

/// Carets and presence against what desktop's y-prosemirror and y-protocols
/// produce (`scripts/generate-document-fixtures.mjs`, `cursors` and `presence`).
final class DocumentCursorTests: XCTestCase {
    nonisolated(unsafe) static let object: [String: Any] = {
        let url = Bundle.module.url(forResource: "documents", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }()

    static func json(_ value: Any) -> YAny {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return try! YAny.parseJSON(String(decoding: data, as: UTF8.self))
    }

    static func sorted(_ value: YAny) -> YAny { json(try! JSONSerialization.jsonObject(with: Data(value.jsonString.utf8))) }

    func testCaretsBecomeTheRelativePositionsDesktopMakes() throws {
        let cases = Self.object["cursors"] as! [[String: Any]]
        XCTAssertEqual(cases.count, 6)
        for c in cases {
            let name = c["name"] as! String
            let (editor, _) = try DocumentEditorTests.editor(DocumentFixtureTests.bytes(c["base"]))
            let positions = c["positions"] as! [[String: Any]]
            var relatives: [YRelativePosition] = []
            for p in positions {
                let caret = DocumentCaret(id: p["id"] as! String, offset: p["offset"] as! Int)
                let ours = try XCTUnwrap(editor.relativePosition(caret), "\(name) \(caret)")
                XCTAssertEqual(Self.sorted(ours.json), Self.json(p["relative"]!), "\(name) \(caret)")
                XCTAssertEqual(YRelativePosition(json: Self.json(p["relative"]!)), ours, name)
                XCTAssertEqual(editor.caret(ours), caret, "\(name) resolves back")
                relatives.append(ours)
            }
            try editor.apply(remote: DocumentFixtureTests.bytes(c["edit"]))
            for (p, relative) in zip(positions, relatives) {
                let expected = (p["after"] as? [String: Any]).map { DocumentCaret(id: $0["id"] as! String, offset: $0["offset"] as! Int) }
                XCTAssertEqual(editor.caret(relative), expected, "\(name) \(p["id"]!) \(p["offset"]!) after the edit")
            }
        }
    }

    func testAwarenessUpdatesReadAndWriteAsY_protocols() throws {
        let presence = Self.object["presence"] as! [String: Any]
        let bytes = DocumentFixtureTests.bytes(presence["update"])
        let states = try YAwarenessState.decode(bytes)
        XCTAssertEqual(states.count, 1)
        XCTAssertEqual(states[0].clientID, presence["clientID"] as! Int)
        XCTAssertEqual(states[0].state.map(Self.sorted), Self.json(presence["state"]!))
        XCTAssertEqual(YAwarenessState.encode(states), bytes)
        let anchor = try XCTUnwrap(states[0].state?["cursor"]?["anchor"].flatMap(YRelativePosition.init(json:)))
        XCTAssertEqual(anchor.item, YID(client: 4242, clock: 6))
        XCTAssertEqual(YAwarenessState.encode([YAwarenessState(clientID: 9, clock: 3, state: nil)]), [1, 9, 3, 4] + Array("null".utf8))
    }
}
