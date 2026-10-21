#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

/// The rows say their words in the language their input carries, the one
/// the screens spoke when the chat was built, and are planned again in
/// another. The words themselves are held to happy-app's keys on Linux
/// (ChatWordsTests).
@MainActor
final class ChatRowWordsTests: XCTestCase {
    private var russian = ChatWords.english

    override func setUp() async throws {
        try await super.setUp()
        Fonts.registerBundledFonts()
        // Decoded off the main thread, as the app decodes every catalog.
        russian = ChatWords(catalog: await TranslationCatalog.load("ru"))
    }

    /// Every text the plan draws, sideways strips' content included.
    private func strings(_ plan: ChatRowPlan) -> [String] {
        plan.items.flatMap { item -> [String] in
            switch item {
            case .text(let layout, _): [layout.string.string]
            case .scroller(let content, _, _, _): strings(content)
            default: []
            }
        }
    }

    private func input(_ item: ChatListItem, words: ChatWords, _ change: (inout ChatRowInput) -> Void = { _ in }) -> ChatRowInput {
        var style = ChatRowStyle(render: .isolated())
        style.text = ChatRowText(environment: nil, words: words)
        var input = ChatRowInput(item: item, style: style)
        change(&input)
        return input
    }

    private func plan(_ item: ChatListItem, words: ChatWords, _ change: (inout ChatRowInput) -> Void = { _ in }) -> [String] {
        strings(ChatRowRenderer.plan(input(item, words: words, change), width: 393))
    }

    /// Whether `strings` draw `word`, in capitals where a style asks for them.
    private func says(_ strings: [String], _ word: String) -> Bool {
        strings.contains(word) || strings.contains(word.uppercased())
    }

    private func tool(_ id: String, _ call: ToolCall) -> ChatListItem {
        .message(.toolCall(ToolCallMessage(id: id, createdAt: 0, tool: call)))
    }

    func testARowSaysItsWordsInItsLanguage() {
        XCTAssertEqual(russian.language, "ru")
        XCTAssertNotEqual(russian.sending, ChatWords.english.sending)
        XCTAssertNotEqual(russian.permission(.allow), ChatWords.english.permission(.allow))
        let asking = ToolCall(
            name: "Bash", state: .running, input: .object(["command": .string("rm -rf build")]), createdAt: 0,
            permission: ToolPermission(id: "p1", status: .pending)
        )
        let question = ToolCall(
            name: "AskUserQuestion", state: .running,
            input: .object(["questions": .array([.object([
                "question": .string("Which build?"), "header": .string("Build"),
                "options": .array([.object(["label": .string("Debug")]), .object(["label": .string("Release")])]),
            ])])]),
            createdAt: 0
        )
        let done = ToolCall(name: "Bash", state: .completed, input: .object(["command": .string("ls")]), createdAt: 0, startedAt: 0, completedAt: 3000)
        let group = ChatWorkGroup(id: "g1", turnUserMessageId: nil, messages: [.toolCall(ToolCallMessage(id: "g1-t", createdAt: 0, tool: done))], startedAt: 0, completedAt: 12_000)
        for words in [ChatWords.english, russian] {
            let at = words.language
            let sending = plan(.message(.userText(UserTextMessage(id: "u1", createdAt: 0, text: "Run the tests"))), words: words) {
                $0.userStatus = UserMessageStatus(line: .sending, dimmed: true)
            }
            XCTAssertTrue(sending.contains(words.sending), "\(sending), \(at)")
            let failed = plan(.message(.userText(UserTextMessage(id: "u2", createdAt: 0, text: "Run the tests"))), words: words) {
                $0.userStatus = UserMessageStatus(line: .failed("offline"), dimmed: false)
            }
            XCTAssertTrue(failed.contains(words.sendFailed("offline")), "\(failed), \(at)")

            let footer = plan(tool("t1", asking), words: words)
            XCTAssertTrue(says(footer, words.permission(.allow)), "\(footer), \(at)")
            XCTAssertTrue(says(footer, words.permission(.deny)), "\(footer), \(at)")

            let form = plan(tool("t2", question), words: words) { input in
                input.question = InlineQuestionForm.askUserQuestion(question).map { ChatQuestionState(form: $0) }
            }
            XCTAssertTrue(says(form, words.submitAnswer), "\(form), \(at)")

            let worked = plan(.workHeader(group, placement: .leading), words: words)
            XCTAssertEqual(worked, [words.workedFor(ChatDisplay.formatWorkDuration(milliseconds: 12_000))], at)
            let hide = plan(.workHeader(group, placement: .trailing), words: words) { $0.expanded = true }
            XCTAssertEqual(hide, [words.hide], at)

            let mode = plan(.message(.agentEvent(AgentEventMessage(id: "e1", createdAt: 0, event: .modeSwitch(mode: "plan")))), words: words)
            XCTAssertTrue(mode.contains(words.switchedToMode("plan")), "\(mode), \(at)")
        }
    }

    /// Another language is another input, so the planner measures the row
    /// again in it, once, as a reconfigure in place.
    func testAnotherLanguagePlansTheRowAgain() {
        let item = ChatListItem.message(.userText(UserTextMessage(id: "u1", createdAt: 0, text: "Run the tests")))
        let english = input(item, words: .english) { $0.userStatus = UserMessageStatus(line: .sending, dimmed: true) }
        let other = input(item, words: russian) { $0.userStatus = UserMessageStatus(line: .sending, dimmed: true) }
        XCTAssertNotEqual(english, other)
        let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
        let first = planner.plan([english], id: \.id, width: 393, applied: PlannedRows())
        let same = planner.plan([english], id: \.id, width: 393, applied: first.rows)
        XCTAssertEqual(same.measured, 0)
        let replanned = planner.plan([other], id: \.id, width: 393, applied: same.rows)
        XCTAssertEqual(replanned.measured, 1)
        XCTAssertEqual(replanned.changeset.reconfigures, [0])
        XCTAssertTrue(replanned.changeset.inserts.isEmpty && replanned.changeset.deletes.isEmpty)
        XCTAssertTrue(strings(replanned.rows.plans[0]).contains(russian.sending))
    }
}
#endif
