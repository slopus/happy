import Foundation
@testable import HappyCore
import XCTest

/// `findActiveWord(units:)` reads a text view's storage in place. It must
/// agree with the String version, which has findActiveWord.test.ts's cases,
/// at every caret.
final class ComposerActiveWordUnitsTests: XCTestCase {
    private let corpus: [String] = [
        "",
        "/",
        "@",
        "Hello @john",
        "Type /help for info",
        "email@domain.com",
        "Hello\n@user",
        "Hi, @user",
        "(@user) [@user] {@user} <@user>",
        "text;@user",
        "Hello  @user",
        "text @user name",
        "Hello @username!",
        "Hey @john, use :smile: and /help",
        "hello @foo bar",
        "hello @foo  bar",
        "see @src/comp.ts now",
        "run /comp.act",
        "hi @john ",
        "hi @john.",
        "a\t@x",
        "I feel :hap",
        // UTF-16 beyond one unit a character: pairs, flags, combining
        // marks, joined emoji.
        "😀 @fi",
        "🇩🇪 @dé /x",
        "e\u{301} @e\u{301}e\u{301}",
        "👩‍👩‍👧 /compact @a/b.c",
        "漢字 @漢字/ファイル.ts",
        // A long word with no break: the search walks all of it.
        "@" + String(repeating: "a/b.", count: 200),
        String(repeating: "word ", count: 100) + "@tail",
        "line\n/one\n@two\n  @three",
    ]

    func testTheStorageAndTheStringAgreeAtEveryCaret() {
        for content in corpus {
            let units = NSMutableString(string: content)
            let length = units.length
            for prefixes in [ComposerAutocomplete.chatPrefixes, ComposerAutocomplete.defaultPrefixes] {
                // Past the end too: the offset isn't clamped.
                for caret in 0...(length + 2) {
                    for selected in [0, 1] {
                        let selection = NSRange(location: caret, length: selected)
                        XCTAssertEqual(
                            ComposerAutocomplete.findActiveWord(units: units, selection: selection, prefixes: prefixes),
                            ComposerAutocomplete.findActiveWord(content, selection: selection, prefixes: prefixes),
                            "\(content.debugDescription) at \(caret)+\(selected), prefixes \(prefixes)"
                        )
                    }
                }
            }
        }
    }

    func testItReadsTheStorageAsItIsNow() {
        let units = NSMutableString(string: "see @src")
        XCTAssertEqual(
            ComposerAutocomplete.findActiveWord(units: units, selection: NSRange(location: 8, length: 0), prefixes: ComposerAutocomplete.chatPrefixes)?.activeWord,
            "@src"
        )
        units.append("/main.swift")
        let word = ComposerAutocomplete.findActiveWord(units: units, selection: NSRange(location: 13, length: 0), prefixes: ComposerAutocomplete.chatPrefixes)
        XCTAssertEqual(word?.activeWord, "@src/main")
        XCTAssertEqual(word?.word, "@src/main.swift")
        XCTAssertEqual(word?.endOffset, 19)
    }

    func testAFoundWordInALongTextIsTheSame() {
        let content = String(repeating: "Lorem ipsum dolor sit amet. ", count: 4_000) + "see @Sources/Happy"
        let caret = (content as NSString).length
        let word = ComposerAutocomplete.findActiveWord(
            units: NSMutableString(string: content),
            selection: NSRange(location: caret, length: 0),
            prefixes: ComposerAutocomplete.chatPrefixes
        )
        XCTAssertEqual(word, ComposerAutocomplete.findActiveWord(content, selection: NSRange(location: caret, length: 0), prefixes: ComposerAutocomplete.chatPrefixes))
        XCTAssertEqual(word?.activeWord, "@Sources/Happy")
        XCTAssertEqual(word?.offset, caret - 14)
    }
}
