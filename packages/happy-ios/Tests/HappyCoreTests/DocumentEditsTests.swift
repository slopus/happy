import Foundation
@testable import HappyCore
import XCTest

/// Enter, Backspace, Tab and Markdown shortcuts as BlockNote makes them.
final class DocumentEditsTests: XCTestCase {
    static func line(_ type: String, _ text: String, depth: Int = 0, id: String? = nil, props: [String: YAny] = [:]) -> DocumentLine {
        DocumentLine(block: DocumentBlock(id: id ?? text, type: type, props: props, content: .inline(text.isEmpty ? [] : [DocumentRun(text)])), depth: depth)
    }

    func testEnterSplitsAndCarriesTheListType() throws {
        let lines = [Self.line("checkListItem", "Buy milk", props: ["checked": .bool(true)])]
        let result = try XCTUnwrap(DocumentEdits.enter(lines, at: 0, offset: 3, newID: "n"))
        XCTAssertEqual(result.range, 0..<1)
        XCTAssertEqual(result.lines.map(\.block.plainText), ["Buy", " milk"])
        XCTAssertEqual(result.lines.map(\.block.type), ["checkListItem", "checkListItem"])
        XCTAssertEqual(result.lines[0].id, "Buy milk", "the first half keeps the block")
        XCTAssertEqual(result.lines[1].id, "n")
        XCTAssertEqual(result.lines[1].block.checked, false, "a new task starts open")
        XCTAssertEqual(result.caretLine, 1)
    }

    func testEnterAfterAHeadingStartsAParagraph() throws {
        let lines = [Self.line("heading", "Title", props: ["level": .number(2)])]
        let result = try XCTUnwrap(DocumentEdits.enter(lines, at: 0, offset: 5, newID: "n"))
        XCTAssertEqual(result.lines.map(\.block.type), ["heading", "paragraph"])
        XCTAssertEqual(result.lines[1].block.props, [:])
    }

    func testEnterAtTheStartPutsTheNewLineAbove() throws {
        let lines = [Self.line("paragraph", "Text")]
        let result = try XCTUnwrap(DocumentEdits.enter(lines, at: 0, offset: 0, newID: "n"))
        XCTAssertEqual(result.range, 0..<0)
        XCTAssertEqual(result.lines.map(\.id), ["n"])
        XCTAssertEqual(result.caretLine, 1)
    }

    func testEnterInAnEmptyItemLiftsItOut() throws {
        let nested = [Self.line("bulletListItem", "a"), Self.line("paragraph", "", depth: 1, id: "e")]
        XCTAssertEqual(DocumentEdits.enter(nested, at: 1, offset: 0)?.lines.first?.depth, 0)
        let item = [Self.line("bulletListItem", "", id: "e")]
        let lifted = try XCTUnwrap(DocumentEdits.enter(item, at: 0, offset: 0))
        XCTAssertEqual(lifted.lines.map(\.block.type), ["paragraph"])
        XCTAssertEqual(lifted.lines[0].id, "e")
    }

    func testBackspaceAtTheStartUnformatsThenJoins() throws {
        let lines = [Self.line("paragraph", "One"), Self.line("bulletListItem", "Two")]
        let unformatted = try XCTUnwrap(DocumentEdits.backspaceAtStart(lines, at: 1))
        XCTAssertEqual(unformatted.lines.map(\.block.type), ["paragraph"])
        var after = lines
        after.replaceSubrange(unformatted.range, with: unformatted.lines)
        let joined = try XCTUnwrap(DocumentEdits.backspaceAtStart(after, at: 1))
        XCTAssertEqual(joined.range, 0..<2)
        XCTAssertEqual(joined.lines.map(\.block.plainText), ["OneTwo"])
        XCTAssertEqual(joined.lines[0].id, "One")
        XCTAssertEqual(joined.caretOffset, 3)
    }

    func testIndentTakesChildrenAlongAndOutdentAdoptsSiblings() throws {
        let lines = [Self.line("bulletListItem", "a"), Self.line("bulletListItem", "b"), Self.line("bulletListItem", "c", depth: 1), Self.line("bulletListItem", "d")]
        let indented = try XCTUnwrap(DocumentEdits.indent(lines, 1..<2, caret: 0))
        XCTAssertEqual(indented.range, 1..<3)
        XCTAssertEqual(indented.lines.map(\.depth), [1, 2])
        XCTAssertNil(DocumentEdits.indent(lines, 0..<1, caret: 0), "nothing above to go under")
        let flat = [Self.line("bulletListItem", "a"), Self.line("bulletListItem", "b", depth: 1), Self.line("bulletListItem", "c", depth: 1)]
        let outdented = try XCTUnwrap(DocumentEdits.outdent(flat, 1..<2, caret: 0))
        XCTAssertEqual(outdented.range, 1..<2)
        var all = flat
        all.replaceSubrange(outdented.range, with: outdented.lines)
        XCTAssertEqual(all.map(\.depth), [0, 0, 1], "c is now b's child")
        let tree = DocumentEditor.tree(all)
        XCTAssertEqual(tree.map(\.id), ["a", "b"])
        XCTAssertEqual(tree[1].children.map(\.id), ["c"])
    }

    func testMarksToggleOverARange() {
        let runs = [DocumentRun("hello world")]
        let bold = DocumentEdits.toggling(runs, "bold", in: 0..<5)
        XCTAssertEqual(bold, [DocumentRun("hello", marks: ["bold": .object([])]), DocumentRun(" world")])
        XCTAssertTrue(DocumentEdits.has(bold, "bold", in: 1..<3))
        XCTAssertFalse(DocumentEdits.has(bold, "bold", in: 3..<7))
        XCTAssertEqual(DocumentEdits.toggling(bold, "bold", in: 0..<5), runs)
        let code = DocumentEdits.toggling(bold, "code", in: 0..<11)
        XCTAssertEqual(code, [DocumentRun("hello world", marks: ["code": .object([])])], "code drops the other marks")
    }

    func testTypingAfterALinkDoesNotExtendIt() {
        let link: [String: YAny] = ["link": .object([("href", .string("https://happy.engineering"))])]
        let runs = [DocumentRun("see "), DocumentRun("here", marks: link)]
        XCTAssertEqual(DocumentEdits.typing(runs, "!", replacing: 8..<8), [DocumentRun("see "), DocumentRun("here", marks: link), DocumentRun("!")])
        XCTAssertEqual(DocumentEdits.typing(runs, "e", replacing: 6..<6), [DocumentRun("see "), DocumentRun("heere", marks: link)])
    }

    func testBlockShortcuts() {
        func shortcut(_ text: String, _ type: String = "paragraph") -> DocumentShortcuts.Block? {
            DocumentShortcuts.block(Self.line(type, text), caret: text.utf16.count)
        }
        XCTAssertEqual(shortcut("# "), .type("heading", props: ["level": .number(1)], remove: 2))
        XCTAssertEqual(shortcut("### "), .type("heading", props: ["level": .number(3)], remove: 4))
        XCTAssertEqual(shortcut("## ", "heading"), .type("heading", props: ["level": .number(2)], remove: 3))
        XCTAssertEqual(shortcut("- "), .type("bulletListItem", props: [:], remove: 2))
        XCTAssertEqual(shortcut("* "), .type("bulletListItem", props: [:], remove: 2))
        XCTAssertEqual(shortcut("1. "), .type("numberedListItem", props: [:], remove: 3))
        XCTAssertEqual(shortcut("4. "), .type("numberedListItem", props: ["start": .number(4)], remove: 3))
        XCTAssertEqual(shortcut("[] "), .type("checkListItem", props: ["checked": .bool(false)], remove: 3))
        XCTAssertEqual(shortcut("[ ] "), .type("checkListItem", props: ["checked": .bool(false)], remove: 4))
        XCTAssertEqual(shortcut("[x] "), .type("checkListItem", props: ["checked": .bool(true)], remove: 4))
        XCTAssertEqual(shortcut("> "), .type("quote", props: [:], remove: 2))
        XCTAssertEqual(shortcut("```swift "), .type("codeBlock", props: ["language": .string("swift")], remove: 9))
        XCTAssertEqual(shortcut("---"), .divider)
        XCTAssertNil(shortcut("a - "))
        XCTAssertNil(shortcut("- ", "bulletListItem"))
        XCTAssertNil(shortcut("#hashtag "))
        XCTAssertNil(shortcut("- ", "codeBlock"))
    }

    func testInlineShortcutsCloseAsTyped() {
        func close(_ text: String) -> DocumentShortcuts.Inline? { DocumentShortcuts.inline([DocumentRun(text)], caret: text.utf16.count) }
        XCTAssertEqual(close("make **this**")?.runs, [DocumentRun("make "), DocumentRun("this", marks: ["bold": .object([])])])
        XCTAssertEqual(close("make **this**")?.caret, 9)
        XCTAssertEqual(close("an *idea*")?.runs, [DocumentRun("an "), DocumentRun("idea", marks: ["italic": .object([])])])
        XCTAssertEqual(close("~~old~~")?.runs, [DocumentRun("old", marks: ["strike": .object([])])])
        XCTAssertEqual(close("run `ls`")?.runs, [DocumentRun("run "), DocumentRun("ls", marks: ["code": .object([])])])
        XCTAssertNil(close("2 * 3 *"), "spaces inside the delimiters")
        XCTAssertNil(close("**"))
        XCTAssertNil(close("snake_case_"), "an underscore inside a word")
        XCTAssertNil(close("**bold*"), "half a bold is not an italic")
    }

    func testFlatTextOffsets() {
        let lines = [Self.line("paragraph", "ab"), DocumentLine(block: DocumentBlock(id: "d", type: "divider", content: .none)), Self.line("paragraph", "c\nd")]
        let starts = DocumentText.starts(lines)
        XCTAssertEqual(starts, [0, 3, 5, 9])
        XCTAssertEqual(DocumentText.paragraph(lines[2]), "c\u{2028}d")
        XCTAssertEqual(DocumentText.locate(0, starts: starts).line, 0)
        XCTAssertEqual(DocumentText.locate(2, starts: starts).offset, 2)
        XCTAssertEqual(DocumentText.locate(3, starts: starts).line, 1)
        XCTAssertEqual(DocumentText.locate(7, starts: starts).line, 2)
        XCTAssertEqual(DocumentText.locate(7, starts: starts).offset, 2)
        XCTAssertEqual(DocumentText.locate(99, starts: starts).offset, 3, "clamped to the last line's end")
    }
}
