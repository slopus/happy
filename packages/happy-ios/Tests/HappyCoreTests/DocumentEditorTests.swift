import Foundation
@testable import HappyCore
import XCTest

/// Editing writes the Yjs structure BlockNote reads, only the difference,
/// and concurrent edits from other replicas merge without losing either.
final class DocumentEditorTests: XCTestCase {
    static func fixture(_ name: String) -> [UInt8] {
        DocumentFixtureTests.bytes(DocumentFixtureTests.fixtures.documents.first { $0["name"] as? String == name }!["update"])
    }

    static func editor(_ update: [UInt8], client: Int = 77) throws -> (DocumentEditor, Box) {
        let doc = YDoc(clientID: client)
        try doc.applyUpdate(update)
        let editor = DocumentEditor(doc: doc)
        let box = Box()
        editor.onLocalUpdate = { box.updates.append($0) }
        editor.onLinesChange = { box.changes.append($0) }
        return (editor, box)
    }

    final class Box { var updates: [[UInt8]] = []; var changes: [DocumentLinesChange] = [] }

    /// What another replica reads after receiving every update.
    static func replay(_ base: [UInt8], _ updates: [[UInt8]]) throws -> [DocumentBlock] {
        let doc = YDoc(clientID: 5)
        try doc.applyUpdate(base)
        for update in updates { try doc.applyUpdate(update) }
        return DocumentReader.blocks(doc)
    }

    func testOpeningAndWritingBackChangesNothing() throws {
        for fixture in DocumentFixtureTests.fixtures.documents {
            let name = fixture["name"] as! String
            let update = DocumentFixtureTests.bytes(fixture["update"])
            let (editor, box) = try Self.editor(update)
            let markdown = DocumentMarkdown.markdown(editor.blocks)
            editor.reconcile(editor.blocks)
            for line in editor.lines where line.block.isInline { editor.setRuns(line.id, line.block.runs) }
            editor.replaceLines(0..<editor.lines.count, with: editor.lines)
            XCTAssertEqual(box.updates.count, 0, name)
            XCTAssertEqual(DocumentMarkdown.markdown(editor.blocks), markdown, name)
            XCTAssertEqual(DocumentMarkdown.markdown(editor.blocks), fixture["markdown"] as? String, name)
        }
    }

    func testTypingWritesOnlyTheNewText() throws {
        let base = Self.fixture("desktop-short")
        let (editor, box) = try Self.editor(base)
        let line = editor.lines[1]
        var runs = line.block.runs
        runs[0].text.insert(contentsOf: "Really, ", at: runs[0].text.startIndex)
        editor.setRuns(line.id, runs)
        XCTAssertEqual(box.updates.count, 1)
        XCTAssertLessThan(box.updates[0].count, 40, "one insert, not the paragraph again")
        XCTAssertEqual(editor.lines[1].block.plainText.prefix(14), "Really, Two pa")
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
        XCTAssertEqual(box.changes.last?.range, 1..<2)
        XCTAssertEqual(box.changes.last?.local, true)
    }

    func testFormattingARangeSetsFormatsOnly() throws {
        let base = Self.fixture("desktop-short")
        let (editor, box) = try Self.editor(base)
        let line = editor.lines[1]
        let text = line.block.plainText
        let runs = [DocumentRun(String(text.prefix(3)), marks: ["bold": .object([])]), DocumentRun(String(text.dropFirst(3)))]
        editor.setRuns(line.id, runs)
        XCTAssertEqual(editor.lines[1].block.runs, runs)
        XCTAssertEqual(editor.lines[1].block.plainText, text)
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
        XCTAssertTrue(DocumentMarkdown.markdown(editor.blocks).contains("**Two** paragraphs"))
        // And off again.
        editor.setRuns(line.id, [DocumentRun(text)])
        XCTAssertEqual(editor.lines[1].block.runs, [DocumentRun(text)])
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
    }

    func testHardBreaksBecomeHardBreakElements() throws {
        let base = Self.fixture("desktop-short")
        let (editor, box) = try Self.editor(base)
        let id = editor.lines[1].id
        editor.setRuns(id, [DocumentRun("Line one\nline two")])
        XCTAssertEqual(editor.lines[1].block.runs, [DocumentRun("Line one\nline two")])
        XCTAssertTrue(DocumentMarkdown.markdown(editor.blocks).contains("Line one\\\nline two"))
        editor.setRuns(id, [DocumentRun("Line oneline two")])
        XCTAssertEqual(editor.lines[1].block.plainText, "Line oneline two")
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
    }

    func testSplittingJoiningAndRetypingBlocks() throws {
        let base = Self.fixture("desktop-short")
        let (editor, box) = try Self.editor(base)
        let line = editor.lines[1]
        // Enter after "Two paragraphs".
        var head = line
        head.block.content = .inline([DocumentRun("Two paragraphs")])
        var tail = DocumentLine(block: DocumentBlock(id: "new-block", type: "paragraph", props: [:], content: .inline([DocumentRun(String(line.block.plainText.dropFirst(14)))])))
        tail.depth = 0
        editor.replaceLines(1..<2, with: [head, tail])
        XCTAssertEqual(editor.lines.map(\.id)[1...2], [line.id, "new-block"])
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
        // A heading, then a check item ticked.
        editor.setType("new-block", "heading", props: ["level": .number(2)])
        XCTAssertEqual(editor.line("new-block")?.block.type, "heading")
        XCTAssertEqual(editor.line("new-block")?.block.level, 2)
        editor.setType("new-block", "checkListItem")
        editor.toggleChecked("new-block")
        XCTAssertEqual(editor.line("new-block")?.block.checked, true)
        // Backspace at its start joins it onto the line above.
        let index = editor.lineIndex("new-block")!
        var joined = editor.lines[index - 1]
        joined.block.content = .inline(joined.block.runs + editor.lines[index].block.runs)
        editor.replaceLines((index - 1)..<(index + 1), with: [joined])
        XCTAssertNil(editor.line("new-block"))
        XCTAssertEqual(editor.lines[1].block.plainText, line.block.plainText)
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
    }

    func testIndentingMakesAChildAndOutdentingBringsItBack() throws {
        let base = Self.fixture("desktop-short")
        let (editor, box) = try Self.editor(base)
        let items = editor.lines.indices.filter { editor.lines[$0].block.type == "numberedListItem" }
        XCTAssertEqual(items.count, 3)
        var second = editor.lines[items[1]]
        second.depth = 1
        editor.replaceLines(items[1]..<(items[1] + 1), with: [second])
        XCTAssertEqual(editor.blocks.last(where: { $0.type == "numberedListItem" })?.id, editor.lines[items[2]].id)
        let parent = editor.blocks.first { $0.id == editor.lines[items[0]].id }!
        XCTAssertEqual(parent.children.map(\.id), [second.id])
        XCTAssertTrue(DocumentMarkdown.markdown(editor.blocks).contains("1. Files open inside Happy\n   1. Markdown renders\n2. Chat links"))
        second.depth = 0
        editor.replaceLines(items[1]..<(items[1] + 1), with: [second])
        XCTAssertEqual(DocumentMarkdown.markdown(editor.blocks), DocumentFixtureTests.fixtures.documents.first { $0["name"] as? String == "desktop-short" }!["markdown"] as? String)
        XCTAssertEqual(try Self.replay(base, box.updates), editor.blocks)
    }

    func testRemoteEditsArriveAsTheLinesTheyChange() throws {
        let base = Self.fixture("desktop-short")
        let (mine, myBox) = try Self.editor(base, client: 10)
        let (theirs, theirBox) = try Self.editor(base, client: 20)
        // Both type in the same paragraph at once.
        let id = mine.lines[1].id
        mine.setRuns(id, [DocumentRun("Mine. ")] + mine.lines[1].block.runs)
        theirs.setRuns(id, theirs.lines[1].block.runs + [DocumentRun(" Theirs.")])
        myBox.changes.removeAll()
        for update in theirBox.updates { try mine.apply(remote: update) }
        for update in myBox.updates { try theirs.apply(remote: update) }
        XCTAssertEqual(mine.blocks, theirs.blocks)
        XCTAssertTrue(mine.lines[1].block.plainText.hasPrefix("Mine. Two"))
        XCTAssertTrue(mine.lines[1].block.plainText.hasSuffix("dragged to. Theirs."))
        XCTAssertEqual(myBox.changes.map(\.range), [1..<2])
        XCTAssertEqual(myBox.changes.first?.local, false)
    }

    func testConcurrentStructureEditsConverge() throws {
        let base = Self.fixture("blocks")
        let (a, boxA) = try Self.editor(base, client: 1)
        let (b, boxB) = try Self.editor(base, client: 2)
        // A deletes the third line; B types in it and ticks a box elsewhere.
        a.replaceLines(2..<3, with: [])
        b.setRuns(b.lines[2].id, [DocumentRun("Third, edited")])
        let check = b.lines.first { $0.block.type == "checkListItem" }!.id
        b.toggleChecked(check)
        // A turns the first heading into a quote while B renames it.
        a.setType(a.lines[0].id, "quote")
        b.setRuns(b.lines[0].id, [DocumentRun("Renamed")])
        for update in boxB.updates { try a.apply(remote: update) }
        for update in boxA.updates { try b.apply(remote: update) }
        XCTAssertEqual(a.blocks, b.blocks)
        XCTAssertEqual(a.line(check)?.block.checked, !(DocumentEditor.flatten(try Self.replay(base, [])).first { $0.id == check }!.block.checked))
    }

    func testUnsupportedBlocksAreNeverWrittenOver() throws {
        let base = Self.fixture("outside-model")
        let (editor, box) = try Self.editor(base)
        XCTAssertEqual(editor.lines.last?.block.content, .unsupported("futureBlock"))
        var lines = editor.lines
        lines[0].block.content = .inline([DocumentRun("Kept, edited")])
        editor.replaceLines(0..<lines.count, with: lines)
        XCTAssertEqual(editor.lines.last?.block.content, .unsupported("futureBlock"))
        XCTAssertEqual(try Self.replay(base, box.updates).last?.content, .unsupported("futureBlock"))
    }
}
