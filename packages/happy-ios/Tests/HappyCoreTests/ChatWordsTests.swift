import Foundation
import XCTest
@testable import HappyCore

/// The chat's rows' words (`ChatWords`): each read under the key of
/// happy-app's own `t()` call, in every language, with its English written
/// out exactly as _default.ts has it.
final class ChatWordsTests: XCTestCase {
    /// One word: how the rows ask for it, and the key and values happy-app
    /// reads it with.
    private struct Word: Sendable {
        var ask: @Sendable (ChatWords) -> String
        var key: String
        var values: [String: TranslationValue] = [:]
    }

    private static let words: [Word] = [
        Word(ask: { $0.switchedToMode("plan") }, key: "message.switchedToMode", values: ["mode": "plan"]),
        Word(ask: { $0.unknownEvent }, key: "message.unknownEvent"),
        Word(ask: { $0.usageLimitUntil("17:30") }, key: "message.usageLimitUntil", values: ["time": "17:30"]),
        Word(ask: { $0.unknownTime }, key: "message.unknownTime"),
        Word(ask: { $0.sentAsGoal }, key: "message.sentAsGoal"),
        Word(ask: { $0.sendsAfterThisTurn }, key: "message.sendsAfterThisTurn"),
        Word(ask: { $0.sending }, key: "message.sending"),
        Word(ask: { $0.sendFailed("offline") }, key: "message.sendFailed", values: ["reason": "offline"]),
        Word(ask: { $0.toolActions.ran }, key: "toolGroup.ran"),
        Word(ask: { $0.toolActions.edited }, key: "toolGroup.edited"),
        Word(ask: { $0.toolActions.read }, key: "toolGroup.read"),
        Word(ask: { $0.toolActions.searched }, key: "toolGroup.searched"),
        Word(ask: { $0.toolActions.fetched }, key: "toolGroup.fetched"),
        Word(ask: { $0.toolActions.ranTask }, key: "toolGroup.ranTask"),
        Word(ask: { $0.workedFor("3m12s") }, key: "toolGroup.workedFor", values: ["duration": "3m12s"]),
        Word(ask: { $0.hide }, key: "toolGroup.hide"),
        Word(ask: { $0.codeCopied }, key: "markdown.codeCopied"),
        Word(ask: { $0.copyFailed }, key: "markdown.copyFailed"),
        Word(ask: { $0.mermaidRenderFailed }, key: "markdown.mermaidRenderFailed"),
        Word(ask: { $0.input }, key: "toolView.input"),
        Word(ask: { $0.output }, key: "toolView.output"),
        Word(ask: { $0.moreTools(1) }, key: "tools.taskView.moreTools", values: ["count": 1]),
        Word(ask: { $0.moreTools(4) }, key: "tools.taskView.moreTools", values: ["count": 4]),
        Word(ask: { $0.moreTools(22) }, key: "tools.taskView.moreTools", values: ["count": 22]),
        Word(ask: { $0.readingFile("a.swift") }, key: "tools.desc.readingFile", values: ["file": "a.swift"]),
        Word(ask: { $0.writingFile("a.swift") }, key: "tools.desc.writingFile", values: ["file": "a.swift"]),
        Word(ask: { $0.submitAnswer }, key: "tools.askUserQuestion.submit"),
        Word(ask: { $0.message }, key: "common.message"),
        Word(ask: { $0.fullDescription }, key: "tools.fullView.description"),
        Word(ask: { $0.fullInputParams }, key: "tools.fullView.inputParams"),
        Word(ask: { $0.fullOutput }, key: "tools.fullView.output"),
        Word(ask: { $0.fullError }, key: "tools.fullView.error"),
        Word(ask: { $0.fullCompleted }, key: "tools.fullView.completed"),
        Word(ask: { $0.fullNoOutput }, key: "tools.fullView.noOutput"),
        Word(ask: { $0.fullRawJson }, key: "tools.fullView.rawJsonDevMode"),
        Word(ask: { $0.editNumber(2, of: 5) }, key: "tools.multiEdit.editNumber", values: ["index": 2, "total": 5]),
        Word(ask: { $0.replaceAll }, key: "tools.multiEdit.replaceAll"),
        Word(ask: { $0.text(.multiEditEdits(path: "a.swift", count: 3)) }, key: "tools.desc.multiEditEdits", values: ["path": "a.swift", "count": 3]),
        Word(ask: { $0.text(.modifyingMultipleFiles(file: "a.swift", count: 2)) }, key: "tools.desc.modifyingMultipleFiles", values: ["file": "a.swift", "count": 2]),
        Word(ask: { $0.text(.multipleQuestions(3)) }, key: "tools.askUserQuestion.multipleQuestions", values: ["count": 3]),
        Word(ask: { $0.permission(.allow) }, key: "common.yes"),
        Word(ask: { $0.permission(.codexAllow) }, key: "common.yes"),
        Word(ask: { $0.permission(.allowAllEdits) }, key: "claude.permissions.yesAllowAllEdits"),
        Word(ask: { $0.permission(.allowEverything) }, key: "claude.permissions.yesAllowEverything"),
        Word(ask: { $0.permission(.allowForTool) }, key: "claude.permissions.yesForTool"),
        Word(ask: { $0.permission(.deny) }, key: "claude.permissions.noTellClaude"),
        Word(ask: { $0.permission(.codexAllowForSession) }, key: "codex.permissions.yesForSession"),
        Word(ask: { $0.permission(.codexAbort) }, key: "codex.permissions.stopAndExplain"),
    ] + ToolName.allCases.filter { $0 != .searchContent }.map { name in
        Word(ask: { $0.name(name) }, key: "tools.names.\(name.rawValue)")
    }

    override func setUp() async throws {
        // Decoding is off-main work; Debug builds stop if it happens on the
        // main thread, where these tests run.
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
    }

    func testEnglishIsWrittenAsDefaultTsHasIt() {
        let read = ChatWords(reading: .english)
        for word in Self.words {
            XCTAssertEqual(word.ask(.english), word.ask(read), word.key)
            XCTAssertEqual(word.ask(.english), TranslationCatalog.english(word.key, word.values), word.key)
        }
        XCTAssertEqual(Self.words.count, 66)
    }

    func testEveryLanguageReadsHappyAppsKeys() {
        for language in AppLanguage.supported.map(\.code) where language != "en" {
            let catalog = TranslationCatalog.catalog(for: language)
            let words = ChatWords(language: language)
            XCTAssertEqual(words.language, language)
            for word in Self.words {
                XCTAssertEqual(word.ask(words), catalog(word.key, word.values), "\(language) \(word.key)")
            }
        }
    }

    func testWordsInAnotherLanguage() {
        let russian = ChatWords(language: "ru")
        XCTAssertEqual(russian.toolActions.ran, TranslationCatalog.catalog(for: "ru")("toolGroup.ran"))
        XCTAssertNotEqual(russian.toolActions.ran, "Ran")
        let chinese = ChatWords(language: "zh-Hans")
        XCTAssertEqual(chinese.toolActions.ran, "已执行")
        XCTAssertEqual(chinese.name(.terminal), "终端")
        XCTAssertEqual(chinese.permission(.allow), "是")
        XCTAssertEqual(chinese.editNumber(2, of: 5), "编辑 2/5")
        XCTAssertEqual(chinese.moreTools(4), "+4 个更多工具")
        // Where a catalog keeps happy-app's English, so do the rows.
        XCTAssertEqual(chinese.sending, "Sending…")
        XCTAssertEqual(chinese.workedFor("12s"), "Worked 12s")
    }

    /// What happy-app spells out stays English in every language.
    func testLiteralsStayEnglish() {
        for language in AppLanguage.supported.map(\.code) {
            let words = ChatWords(language: language)
            XCTAssertEqual(words.name(.searchContent), "Search Content", language)
            XCTAssertEqual(words.text(.literal("grep(pattern: x)")), "grep(pattern: x)", language)
        }
    }

    func testWordsAreTheirLanguage() {
        XCTAssertEqual(ChatWords(language: "en"), .english)
        XCTAssertEqual(ChatWords(catalog: .english), .english)
        XCTAssertEqual(ChatWords(catalog: .english).language, "en")
        // An unknown language is English, as the catalogs answer it.
        XCTAssertEqual(ChatWords(language: "xx"), .english)
        XCTAssertEqual(ChatWords(language: "ja"), ChatWords(catalog: TranslationCatalog.catalog(for: "ja")))
        XCTAssertNotEqual(ChatWords(language: "ja"), .english)
    }

    func testWordsAreReadFromAnyThread() async {
        let languages = AppLanguage.supported.map(\.code)
        let answers = await withTaskGroup(of: String.self) { group in
            for index in 0..<40 {
                group.addTask { ChatWords(language: languages[index % languages.count]).hide }
            }
            var answers: Set<String> = []
            for await answer in group { answers.insert(answer) }
            return answers
        }
        XCTAssertEqual(answers, Set(languages.map { TranslationCatalog.catalog(for: $0)("toolGroup.hide") }))
    }
}
