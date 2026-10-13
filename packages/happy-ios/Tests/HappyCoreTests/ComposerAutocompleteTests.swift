import Foundation
@testable import HappyCore
import XCTest

// The cases are findActiveWord.test.ts and applySuggestion.test.ts, plus a
// few "extra:" ones, each with what the TypeScript returns for it.

private struct FindCase {
    var name: String
    var content: String
    var start: Int
    var end: Int
    var prefixes: [Character]?
    var expected: ActiveWord?

    init(_ name: String, _ content: String, _ start: Int, _ end: Int, _ prefixes: [Character]?, _ expected: ActiveWord?) {
        (self.name, self.content, self.start, self.end, self.prefixes, self.expected) = (name, content, start, end, prefixes, expected)
    }
}

private struct ApplyCase {
    var name: String
    var content: String
    var start: Int
    var end: Int
    var suggestion: String
    var prefixes: [Character]?
    var addSpace: Bool
    var text: String
    var cursor: Int

    init(_ name: String, _ content: String, _ start: Int, _ end: Int, _ suggestion: String, _ prefixes: [Character]?, _ addSpace: Bool, _ text: String, _ cursor: Int) {
        (self.name, self.content, self.start, self.end, self.suggestion) = (name, content, start, end, suggestion)
        (self.prefixes, self.addSpace, self.text, self.cursor) = (prefixes, addSpace, text, cursor)
    }
}

final class FindActiveWordTests: XCTestCase {
    private let cases: [FindCase] = [
        FindCase("should detect @ mention at cursor", "Hello @john", 11, 11, nil, ActiveWord(word: "@john", activeWord: "@john", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should detect : emoji at cursor", "I feel :happy", 13, 13, nil, ActiveWord(word: ":happy", activeWord: ":happy", offset: 7, length: 6, activeLength: 6, endOffset: 13)),
        FindCase("should detect / command at cursor", "Type /help for info", 10, 10, nil, ActiveWord(word: "/help", activeWord: "/help", offset: 5, length: 5, activeLength: 5, endOffset: 10)),
        FindCase("should detect # tag at cursor", "This is #important", 18, 18, ["@", ":", "/", "#"], ActiveWord(word: "#important", activeWord: "#important", offset: 8, length: 10, activeLength: 10, endOffset: 18)),
        FindCase("should return just the prefix when typed alone", "Hello @", 7, 7, nil, ActiveWord(word: "@", activeWord: "@", offset: 6, length: 1, activeLength: 1, endOffset: 7)),
        FindCase("should only detect prefix at word boundary", "email@domain.com", 16, 16, nil, nil),
        FindCase("should detect prefix after space", "Hello @user", 11, 11, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should detect prefix at start of line", "@user hello", 5, 5, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 0, length: 5, activeLength: 5, endOffset: 5)),
        FindCase("should detect prefix after newline", "Hello\n@user", 11, 11, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should stop at newline", "Hello\n@user", 11, 11, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should stop at comma", "Hi, @user", 9, 9, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 4, length: 5, activeLength: 5, endOffset: 9)),
        FindCase("should stop at parentheses", "(@user)", 6, 6, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 1, length: 5, activeLength: 5, endOffset: 6)),
        FindCase("should stop at brackets", "[@user]", 6, 6, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 1, length: 5, activeLength: 5, endOffset: 6)),
        FindCase("should stop at braces", "{@user}", 6, 6, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 1, length: 5, activeLength: 5, endOffset: 6)),
        FindCase("should stop at angle brackets", "<@user>", 6, 6, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 1, length: 5, activeLength: 5, endOffset: 6)),
        FindCase("should stop at semicolon", "text;@user", 10, 10, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 5, length: 5, activeLength: 5, endOffset: 10)),
        FindCase("should handle single space before prefix", "Hello @user", 11, 11, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should stop at multiple spaces", "Hello  @user", 12, 12, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 7, length: 5, activeLength: 5, endOffset: 12)),
        FindCase("should handle spaces within active word search", "text @user name", 10, 10, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 5, length: 5, activeLength: 5, endOffset: 10)),
        FindCase("should return undefined when cursor at beginning", "@user", 0, 0, nil, nil),
        FindCase("should return undefined when text is selected", "Hello @user", 6, 11, nil, nil),
        FindCase("should handle empty content", "", 0, 0, nil, nil),
        FindCase("should handle cursor in middle of word without prefix", "Hello world", 8, 8, nil, nil),
        FindCase("should handle prefix not in the prefix list", "Hello $user", 11, 11, nil, nil),
        FindCase("should work with custom prefix array", "Hello $user", 11, 11, ["$"], ActiveWord(word: "$user", activeWord: "$user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should work with multiple custom prefixes", "Hello $user", 11, 11, ["$", "%"], ActiveWord(word: "$user", activeWord: "$user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should work with multiple custom prefixes", "Hello %task", 11, 11, ["$", "%"], ActiveWord(word: "%task", activeWord: "%task", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should use default prefixes when none provided", "Hello @user", 11, 11, nil, ActiveWord(word: "@user", activeWord: "@user", offset: 6, length: 5, activeLength: 5, endOffset: 11)),
        FindCase("should return full word and active part when cursor in middle", "Hello @username!", 10, 10, nil, ActiveWord(word: "@username", activeWord: "@use", offset: 6, length: 9, activeLength: 4, endOffset: 15)),
        FindCase("should handle cursor at different positions in word", "Type @mention here", 7, 7, nil, ActiveWord(word: "@mention", activeWord: "@m", offset: 5, length: 8, activeLength: 2, endOffset: 13)),
        FindCase("should handle cursor at different positions in word", "Type @mention here", 10, 10, nil, ActiveWord(word: "@mention", activeWord: "@ment", offset: 5, length: 8, activeLength: 5, endOffset: 13)),
        FindCase("should stop at stop characters after cursor", "Hello @user, welcome", 9, 9, nil, ActiveWord(word: "@user", activeWord: "@us", offset: 6, length: 5, activeLength: 3, endOffset: 11)),
        FindCase("should handle word ending with space after cursor", "Use :smile face", 8, 8, nil, ActiveWord(word: ":smile", activeWord: ":smi", offset: 4, length: 6, activeLength: 4, endOffset: 10)),
        FindCase("should handle multiple prefixes in same line", "Hey @john, use :smile: and /help", 9, 9, nil, ActiveWord(word: "@john", activeWord: "@john", offset: 4, length: 5, activeLength: 5, endOffset: 9)),
        FindCase("should handle multiple prefixes in same line", "Hey @john, use :smile: and /help", 22, 22, nil, ActiveWord(word: ":smile:", activeWord: ":smile:", offset: 15, length: 7, activeLength: 7, endOffset: 22)),
        FindCase("should handle multiple prefixes in same line", "Hey @john, use :smile: and /help", 32, 32, nil, ActiveWord(word: "/help", activeWord: "/help", offset: 27, length: 5, activeLength: 5, endOffset: 32)),
        FindCase("should handle prefix at end of text", "Hello @", 7, 7, nil, ActiveWord(word: "@", activeWord: "@", offset: 6, length: 1, activeLength: 1, endOffset: 7)),
        FindCase("should handle long active words", "Hello @very_long_username_here", 30, 30, nil, ActiveWord(word: "@very_long_username_here", activeWord: "@very_long_username_here", offset: 6, length: 24, activeLength: 24, endOffset: 30)),
        FindCase("should handle cursor positions within active word", "Hello @username", 10, 10, nil, ActiveWord(word: "@username", activeWord: "@use", offset: 6, length: 9, activeLength: 4, endOffset: 15)),
        FindCase("extra: one space between prefix and caret", "hello @foo bar", 14, 14, ["@", "/"], ActiveWord(word: "@foo bar", activeWord: "@foo bar", offset: 6, length: 8, activeLength: 8, endOffset: 14)),
        FindCase("extra: two spaces end it", "hello @foo  bar", 15, 15, ["@", "/"], nil),
        FindCase("extra: a file path runs through dots and slashes", "see @src/comp.ts now", 9, 9, ["@", "/"], ActiveWord(word: "@src/comp.ts", activeWord: "@src/", offset: 4, length: 12, activeLength: 5, endOffset: 16)),
        FindCase("extra: a command stops at a dot", "run /comp.act", 7, 7, ["@", "/"], ActiveWord(word: "/comp", activeWord: "/co", offset: 4, length: 5, activeLength: 3, endOffset: 9)),
        FindCase("extra: a prefix at the very start", "/", 1, 1, ["@", "/"], ActiveWord(word: "/", activeWord: "/", offset: 0, length: 1, activeLength: 1, endOffset: 1)),
        FindCase("extra: UTF-16 offsets after an emoji", "😀 @fi", 5, 5, ["@", "/"], ActiveWord(word: "@fi", activeWord: "@f", offset: 3, length: 3, activeLength: 2, endOffset: 6)),
        FindCase("extra: a colon is not a chat prefix", "I feel :hap", 11, 11, ["@", "/"], nil),
        FindCase("extra: the caret past a trailing space", "hi @john ", 9, 9, ["@", "/"], nil),
        FindCase("extra: a stop character right before the caret", "hi @john.", 9, 9, ["@", "/"], nil),
        FindCase("extra: a prefix after a tab is not at a boundary", "a\t@x", 4, 4, ["@", "/"], nil),
        FindCase("extra: the caret past the end", "hi @x", 7, 7, ["@", "/"], ActiveWord(word: "@x", activeWord: "@x", offset: 3, length: 2, activeLength: 2, endOffset: 7)),
    ]

    func testEveryCase() {
        for c in cases {
            let selection = NSRange(location: c.start, length: c.end - c.start)
            let result = ComposerAutocomplete.findActiveWord(
                c.content, selection: selection, prefixes: c.prefixes ?? ComposerAutocomplete.defaultPrefixes
            )
            XCTAssertEqual(result, c.expected, c.name)
        }
    }
}

final class ApplySuggestionTests: XCTestCase {
    private let cases: [ApplyCase] = [
        ApplyCase("should replace @ mention at end of text", "Hello @joh", 10, 10, "@john_smith", nil, true, "Hello @john_smith ", 18),
        ApplyCase("should replace : emoji at end of text", "I feel :hap", 11, 11, ":happy:", nil, true, "I feel :happy: ", 15),
        ApplyCase("should replace / command at end of text", "Type /hel", 9, 9, "/help", nil, true, "Type /help ", 11),
        ApplyCase("should replace entire word when cursor is in middle", "Hello @username here", 10, 10, "@john_smith", nil, true, "Hello @john_smith here", 17),
        ApplyCase("should handle cursor at beginning of word after prefix", "Hello @username", 7, 7, "@john_smith", nil, true, "Hello @john_smith ", 18),
        ApplyCase("should add space when there is more text after", "Hello @user,welcome", 11, 11, "@john_smith", nil, true, "Hello @john_smith ,welcome", 18),
        ApplyCase("should not add double space if space already exists", "Hello @user welcome", 11, 11, "@john_smith", nil, true, "Hello @john_smith welcome", 17),
        ApplyCase("should respect addSpace parameter when false", "Hello @user", 11, 11, "@john_smith", ["@", ":", "/"], false, "Hello @john_smith", 17),
        ApplyCase("should insert suggestion at cursor when no active word", "Hello world", 6, 6, "@john_smith", nil, true, "Hello @john_smith world", 18),
        ApplyCase("should handle text selection replacement", "Hello world", 6, 11, "@john_smith", nil, true, "Hello @john_smith ", 18),
        ApplyCase("should handle empty content", "", 0, 0, "@john_smith", nil, true, "@john_smith ", 12),
        ApplyCase("should handle suggestion at start of text", "@use", 4, 4, "@john_smith", nil, true, "@john_smith ", 12),
        ApplyCase("should handle multiple words with same prefix", "Hi @user1, meet @user2", 9, 9, "@alice", nil, true, "Hi @alice , meet @user2", 10),
        ApplyCase("should work with custom prefixes", "Use $var", 8, 8, "$variable", ["$"], true, "Use $variable ", 14),
        ApplyCase("should properly replace word before stop character", "Hello @user!", 11, 11, "@john_smith", nil, true, "Hello @john_smith !", 18),
        ApplyCase("should handle parentheses", "(@user)", 6, 6, "@john_smith", nil, true, "(@john_smith )", 13),
        ApplyCase("extra: a file replaces the whole path word", "see @src/co.ts now", 10, 10, "@src/components/", ["@", "/"], true, "see @src/components/ now", 20),
        ApplyCase("extra: a command mid-text keeps the following space", "run /com now", 8, 8, "/compact", ["@", "/"], true, "run /compact now", 12),
        ApplyCase("extra: no active word inserts at the caret", "plain text", 5, 5, "/compact", ["@", "/"], true, "plain/compact  text", 14),
        ApplyCase("extra: no active word replaces a selection", "plain text", 0, 5, "@a.ts", ["@", "/"], true, "@a.ts  text", 6),
        ApplyCase("extra: without the space", "hi @jo", 6, 6, "@john", ["@", "/"], false, "hi @john", 8),
        ApplyCase("extra: after an emoji", "😀 @fi", 5, 5, "@file.ts", ["@", "/"], true, "😀 @file.ts ", 12),
    ]

    func testEveryCase() {
        for c in cases {
            let selection = NSRange(location: c.start, length: c.end - c.start)
            let result = ComposerAutocomplete.applySuggestion(
                c.content, selection: selection, suggestion: c.suggestion,
                prefixes: c.prefixes ?? ComposerAutocomplete.defaultPrefixes, addSpace: c.addSpace
            )
            XCTAssertEqual(result.text, c.text, c.name)
            XCTAssertEqual(result.cursor, c.cursor, c.name)
        }
    }
}
