#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The chat's main-thread words in the language the screens speak, its
/// English as happy-app's _default.ts has it. The rows' words are in the
/// language their input carries (`ChatRowWordsTests`).
@MainActor
final class ChatLocalizedStringsTests: XCTestCase {
    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    func testEnglishIsHappyAppsOwn() async {
        AppLocalization.use(nil)
        // Decoded off the main thread, as the app decodes every catalog:
        // decoding on it stops Debug builds.
        let english = await TranslationCatalog.load("en")
        XCTAssertEqual(Strings.Chat.retry, "Retry")
        XCTAssertEqual(Strings.Chat.worktreeTabs(1), "1 tab")
        XCTAssertEqual(Strings.Chat.worktreeTabs(4), "4 tabs")
        XCTAssertEqual(Strings.Chat.startingChat, "Starting a new chat…")
        XCTAssertEqual(Strings.AgentGoal.accessibilityLabel("ship"), "Current goal: ship")
        XCTAssertEqual(Strings.AgentQuestion.moreQuestions(1), "1 more question")
        XCTAssertEqual(Strings.AgentQuestion.moreQuestions(2), "2 more questions")
        // _default.ts's straight quotes, which the English catalog has too.
        XCTAssertEqual(Strings.AgentQuestion.unsupportedDescription("form"), "This version of Happy cannot show a \"form\" request. Update the app to respond.")
        XCTAssertEqual(Strings.AgentQuestion.unsupportedDescription("form"), english("agentQuestion.unsupportedDescription", ["kind": "form"]))
        // A function's English is not a literal the strings check can read:
        // each is compared with the English catalog here.
        for count in [0, 1, 2, 11] {
            XCTAssertEqual(Strings.Chat.worktreeTabs(count), english("sessionsFilter.worktreeTabs", ["count": .number(count)]))
            XCTAssertEqual(Strings.AgentQuestion.moreQuestions(count), english("agentQuestion.moreQuestions", ["count": .number(count)]))
        }
        XCTAssertEqual(Strings.AgentGoal.accessibilityLabel("ship"), english("components.agentGoalBar.accessibilityLabel", ["goal": "ship"]))
    }

    func testAnotherLanguageReadsItsCatalog() async {
        let russian = await TranslationCatalog.load("ru")
        AppLocalization.use(russian)
        XCTAssertEqual(Strings.Chat.retry, russian("common.retry"))
        XCTAssertEqual(Strings.Chat.loadMore, russian("common.loadMore"))
        XCTAssertEqual(Strings.TextSelection.title, russian("textSelection.title"))
        XCTAssertEqual(Strings.Chat.inactiveArchived, russian("session.inactiveArchived"))
        XCTAssertEqual(Strings.AgentGoal.currentGoal, russian("components.agentGoalBar.currentGoal"))
        XCTAssertEqual(Strings.AgentQuestion.submit, russian("agentQuestion.submit"))
        for count in [1, 3, 5, 21] {
            XCTAssertEqual(Strings.Chat.worktreeTabs(count), russian("sessionsFilter.worktreeTabs", ["count": .number(count)]))
            XCTAssertEqual(Strings.AgentQuestion.moreQuestions(count), russian("agentQuestion.moreQuestions", ["count": .number(count)]))
        }
        XCTAssertNotEqual(Strings.Chat.retry, "Retry")
        // The words a screen built now hands its rows.
        XCTAssertEqual(ChatWords(catalog: AppLocalization.screens).toolActions.ran, russian("toolGroup.ran"))
        XCTAssertEqual(ChatWords(catalog: AppLocalization.screens).sending, russian("message.sending"))
    }

    func testAViewBuiltInAnotherLanguageSpeaksIt() async {
        let russian = await TranslationCatalog.load("ru")
        AppLocalization.use(russian)
        let end = ChatOlderEndView(frame: CGRect(x: 0, y: 0, width: 393, height: 32))
        end.status = .loadMore
        let button = end.subviews.compactMap { $0 as? RoundButton }.first
        XCTAssertEqual(button?.title, russian("common.loadMore"))
        end.status = .error
        XCTAssertEqual(button?.title, russian("common.retry"))
    }
}
#endif
