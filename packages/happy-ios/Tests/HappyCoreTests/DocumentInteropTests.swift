import Foundation
@testable import HappyCore
import XCTest

/// Documents this editor wrote, for the real BlockNote and the daemon's
/// Markdown code to read back: with `HAPPY_DOCUMENT_INTEROP=<dir>` set,
/// each case is written there, and
/// `node scripts/generate-document-fixtures.mjs verify <dir>` checks that
/// BlockNote reads the same blocks and the daemon the same Markdown.
/// Without it, the same cases still run against this phone's own reader.
final class DocumentInteropTests: XCTestCase {
    struct Case { let name: String; let state: [UInt8]; let markdown: String; let blocks: [DocumentBlock] }

    static func cases() throws -> [Case] {
        var out: [Case] = []
        func run(_ name: String, _ fixture: String, _ edit: (DocumentEditor) -> Void) throws {
            let base = fixture.isEmpty ? [0, 0] : DocumentEditorTests.fixture(fixture)
            let (editor, box) = try DocumentEditorTests.editor(base, client: 3_141_592)
            edit(editor)
            XCTAssertFalse(box.updates.isEmpty, name)
            let replica = YDoc(clientID: 1)
            try replica.applyUpdate(base)
            for update in box.updates { try replica.applyUpdate(update) }
            let blocks = DocumentReader.blocks(replica)
            XCTAssertEqual(blocks, editor.blocks, name)
            out.append(Case(name: name, state: replica.encodeStateAsUpdate(), markdown: DocumentMarkdown.markdown(blocks), blocks: blocks))
        }
        try run("type-in-paragraph", "desktop-short") { e in
            e.setRuns(e.lines[1].id, [DocumentRun("Typed on a phone. ")] + e.lines[1].block.runs)
        }
        try run("bold-italic-strike-code-link", "desktop-short") { e in
            e.setRuns(e.lines[1].id, [
                DocumentRun("Bold", marks: ["bold": .object([])]), DocumentRun(" and "),
                DocumentRun("italic", marks: ["italic": .object([])]), DocumentRun(", "),
                DocumentRun("struck", marks: ["strike": .object([])]), DocumentRun(", "),
                DocumentRun("code", marks: ["code": .object([])]), DocumentRun(" and "),
                DocumentRun("a link", marks: ["link": .object([("href", .string("https://happy.engineering"))])]), DocumentRun("."),
            ])
        }
        try run("unformat-keeps-text", "formatting") { e in
            e.setRuns(e.lines[0].id, [DocumentRun(e.lines[0].block.plainText)])
        }
        try run("hard-break", "desktop-short") { e in
            e.setRuns(e.lines[1].id, [DocumentRun("First line\nsecond line")])
        }
        try run("split-into-heading-and-list", "desktop-short") { e in
            var lines = e.lines
            lines[1].block.content = .inline([DocumentRun("Two paragraphs")])
            let heading = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "heading", props: ["level": .number(3)], content: .inline([DocumentRun("A new heading")])))
            let bullet = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "bulletListItem", content: .inline([DocumentRun("A bullet")])))
            let nested = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "checkListItem", props: ["checked": .bool(true)], content: .inline([DocumentRun("Nested and done")])), depth: 1)
            lines.insert(contentsOf: [heading, bullet, nested], at: 2)
            e.replaceLines(0..<e.lines.count, with: lines)
        }
        try run("change-types", "blocks") { e in
            e.setType(e.lines[0].id, "heading", props: ["level": .number(2)])
            e.setType(e.lines[3].id, "quote")
            e.setType(e.lines[5].id, "numberedListItem")
            let check = e.lines.first { $0.block.type == "checkListItem" }!.id
            e.toggleChecked(check)
            let code = e.lines.first { $0.block.type == "codeBlock" }!.id
            e.setRuns(code, [DocumentRun("let y = 2\nprint(y)\n")])
            e.setType(e.lines[4].id, "codeBlock", props: ["language": .string("python")])
        }
        try run("indent-outdent", "desktop-short") { e in
            var lines = e.lines
            let items = lines.indices.filter { lines[$0].block.type == "numberedListItem" }
            lines[items[1]].depth = 1
            lines[items[2]].depth = 2
            e.replaceLines(0..<e.lines.count, with: lines)
            var again = e.lines
            again[again.count - 1].depth = 1
            e.replaceLines(0..<e.lines.count, with: again)
        }
        try run("insert-divider-and-delete-lines", "desktop-readme") { e in
            var lines = e.lines
            lines.removeSubrange(2..<4)
            lines.insert(DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "divider", content: .none)), at: 2)
            e.replaceLines(0..<e.lines.count, with: lines)
        }
        try run("new-document", "") { e in
            e.replaceLines(0..<e.lines.count, with: [
                DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "heading", props: ["level": .number(1)], content: .inline([DocumentRun("Fresh")]))),
                DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "paragraph", content: .inline([DocumentRun("Written on iOS 😀 with ünïcödé.")]))),
            ])
        }
        try run("emoji-edits", "escape-25") { e in
            e.setRuns(e.lines[0].id, [DocumentRun("emoji 😃 and ünïcödé!")])
        }
        return out
    }

    func testCasesReadBackTheSame() throws {
        let cases = try Self.cases()
        XCTAssertEqual(cases.count, 10)
        guard let dir = ProcessInfo.processInfo.environment["HAPPY_DOCUMENT_INTEROP"] else { return }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let json: [[String: Any]] = cases.map { c in
            ["name": c.name, "state": Data(c.state).base64EncodedString(), "markdown": c.markdown,
             "blocks": BlockNoteJSON.normalize(c.blocks.map(BlockNoteJSON.block))]
        }
        let data = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .prettyPrinted])
        try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("editor.json"))
    }
}
