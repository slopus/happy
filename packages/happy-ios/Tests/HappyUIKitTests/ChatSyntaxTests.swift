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
        let string = ChatSyntax.string(code, language: "python")
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
}
#endif
