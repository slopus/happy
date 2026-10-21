#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A message's code block takes SimpleSyntaxHighlighter's `getColors`, the
/// same as the file viewer. They need UIKit, so they run only in the
/// simulator.
@MainActor
final class ChatSyntaxTests: XCTestCase {
    func testBracketsCountFromTheOutermost() {
        // `(nestLevel || 1) % 5`: 1-4 take the first four, 5 the fifth.
        XCTAssertEqual(FileSyntax.color(SyntaxToken("(", .bracket, nestLevel: 1)), Palette.syntaxBracket1)
        XCTAssertEqual(FileSyntax.color(SyntaxToken("(", .bracket, nestLevel: 4)), Palette.syntaxBracket4)
        XCTAssertEqual(FileSyntax.color(SyntaxToken("(", .bracket, nestLevel: 5)), Palette.syntaxBracket5)
        XCTAssertEqual(FileSyntax.color(SyntaxToken("(", .bracket, nestLevel: 6)), Palette.syntaxBracket1)
        XCTAssertEqual(FileSyntax.color(SyntaxToken("(", .bracket)), Palette.syntaxBracket1)
    }

    func testDecoratorsAndOperatorWordsAreKeywords() {
        for kind in [SyntaxToken.Kind.decorator, .assignment, .comparison, .logical] {
            XCTAssertEqual(FileSyntax.color(SyntaxToken("x", kind)), Palette.syntaxKeyword, "\(kind)")
        }
    }

    func testTheCodeBlockColoursEveryTokenAsTheFileViewerDoes() {
        let code = "@cached\ndef f(a, b):\n    return [a == (b or 1)]"
        let string = ChatSyntax.string(code, language: "python", service: CodeSyntaxService(), in: nil)
        XCTAssertEqual(string.string, code)
        let light = UITraitCollection(userInterfaceStyle: .light)
        var offset = 0
        for token in SyntaxHighlighter.tokenize(code, language: "python") {
            let length = (token.text as NSString).length
            defer { offset += length }
            guard length > 0 else { continue }
            let color = string.attribute(.foregroundColor, at: offset, effectiveRange: nil) as? UIColor
            XCTAssertEqual(
                color?.resolvedColor(with: light),
                UIColor(FileSyntax.color(token)).resolvedColor(with: light),
                "\(token.text) \(token.kind)"
            )
        }
    }

    /// A block not coloured yet (or never: a closed account's service) is
    /// the same text, plain, at the size it takes coloured, so the row
    /// keeps its height when the colour comes in.
    func testAPlainBlockTakesTheColouredBlocksSize() {
        let code = "@cached\ndef f(a, b):\n    return [a == (b or 1)]\nclass Widget: pass"
        let coloured = ChatSyntax.string(code, language: "python", service: CodeSyntaxService(), in: nil)
        let closed = CodeSyntaxService()
        closed.close()
        let plain = ChatSyntax.string(code, language: "python", service: closed, in: nil)
        XCTAssertEqual(plain.string, code)
        let light = UITraitCollection(userInterfaceStyle: .light)
        let color = plain.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        XCTAssertEqual(color?.resolvedColor(with: light), UIColor(FileSyntax.color(SyntaxToken("", .plain))).resolvedColor(with: light))
        XCTAssertEqual(ChatTextLayout(unwrapped: plain).size, ChatTextLayout(unwrapped: coloured).size)
    }

    /// CommandView's panel stays dark: tokens take the dark theme's diff
    /// colours in light appearance too; plain runs keep the output's colour.
    func testTerminalTokensTakeTheDarkDiffColours() {
        let string = MessageDetailRenderer.terminalString(
            [("echo", .function), (" hi ", .plain), ("# note", .comment)],
            style: ChatTextStyles.terminal, color: Palette.terminalStdout, lineBreakMode: .byCharWrapping, in: nil
        )
        XCTAssertEqual(string.string, "echo hi # note")
        let light = UITraitCollection(userInterfaceStyle: .light)
        func color(at offset: Int) -> UIColor? {
            (string.attribute(.foregroundColor, at: offset, effectiveRange: nil) as? UIColor)?.resolvedColor(with: light)
        }
        XCTAssertEqual(color(at: 0), UIColor(DiffPalette.Syntax.function.dark))
        XCTAssertEqual(color(at: 5), UIColor(Palette.terminalStdout).resolvedColor(with: light))
        XCTAssertEqual(color(at: 8), UIColor(DiffPalette.Syntax.comment.dark))
    }
}
#endif
