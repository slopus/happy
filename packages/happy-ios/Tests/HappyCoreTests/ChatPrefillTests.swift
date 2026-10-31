@testable import HappyCore
import XCTest

final class ChatPrefillTests: XCTestCase {
    /// The two asks Settings opens the Chief of Staff with, to the
    /// character: the trailing space is part of each, so what the person
    /// types reads on from the ask.
    func testTheAsksAreExactlyWhatSettingsPromised() {
        XCTAssertEqual(ChatPrefill.agentName.prefix, "Change your name to ")
        XCTAssertEqual(ChatPrefill.agentAvatar.prefix, "Change your avatar to ")
    }

    /// Nothing typed yet: the ask alone, the caret at its end.
    func testAnEmptyDraftOpensOnTheAsk() {
        let shown = ChatPrefill.agentName.applied(to: "")
        XCTAssertEqual(shown.text, "Change your name to ")
        XCTAssertEqual(shown.caret, 20)
        XCTAssertEqual(shown.caret, (shown.text as NSString).length, "the caret is after the ask")
    }

    /// A draft the person left is kept, two lines under the ask, and the
    /// caret is still on the ask's line.
    func testADraftIsKeptTwoLinesUnder() {
        let shown = ChatPrefill.agentAvatar.applied(to: "ask about the invoice")
        XCTAssertEqual(shown.text, "Change your avatar to \n\nask about the invoice")
        XCTAssertEqual(shown.caret, 22)
        XCTAssertTrue(shown.text.hasSuffix("ask about the invoice"), "the draft is not dropped")
    }

    /// Coming back to a conversation that already opens with the ask does
    /// not stack it up: the text is left exactly as it was, caret on the ask.
    func testTheSameAskIsNotAddedTwice() {
        let ask = ChatPrefill.agentName
        let once = ask.applied(to: "").text
        let twice = ask.applied(to: once)
        XCTAssertEqual(twice.text, once)
        XCTAssertEqual(twice.caret, 20)
        let withDraft = ask.applied(to: "Change your name to Steve's laptop")
        XCTAssertEqual(withDraft.text, "Change your name to Steve's laptop")
        XCTAssertEqual(withDraft.caret, 20, "the caret is on the ask, before what was typed")
    }

    /// The other ask is a different ask: it goes in above a draft that
    /// opens with the first one.
    func testADifferentAskGoesAboveTheDraft() {
        let draft = ChatPrefill.agentName.applied(to: "").text
        let shown = ChatPrefill.agentAvatar.applied(to: draft)
        XCTAssertEqual(shown.text, "Change your avatar to \n\n" + draft)
    }

    /// The caret is counted as the text view counts, in UTF-16: an ask
    /// with characters outside the basic plane still lands after it.
    func testTheCaretIsCountedInUTF16() {
        let ask = ChatPrefill(prefix: "Pick an emoji 🎈 ")
        let shown = ask.applied(to: "hello")
        XCTAssertEqual(shown.caret, (ask.prefix as NSString).length)
        XCTAssertEqual((shown.text as NSString).substring(to: shown.caret), ask.prefix)
    }

    /// The Chief of Staff's conversation is the active bot with Happy's
    /// own system key; another bot, or one stopped, is not it.
    func testTheChiefOfStaffsConversationIsFound() {
        func bot(_ id: String, key: String?, status: String?, agent: String?) -> AgentWire.Bot {
            AgentWire.Bot(id: id, name: id, systemKey: key, status: status, avatar: nil, version: nil,
                          agent: agent.map { AgentWire.Agent(id: $0, workspaceId: "w", status: "idle") })
        }
        XCTAssertNil(Places().chiefOfStaffAgentId, "no bots read yet")
        XCTAssertEqual(Places(bots: [
            bot("other", key: nil, status: "active", agent: "other-agent"),
            bot("happy", key: "chief_of_staff", status: "active", agent: "bot-agent"),
        ]).chiefOfStaffAgentId, "bot-agent")
        XCTAssertEqual(Places(bots: [bot("happy", key: "chief_of_staff", status: nil, agent: "bot-agent")]).chiefOfStaffAgentId,
                       "bot-agent", "a status the account has not been told is taken as active")
        XCTAssertNil(Places(bots: [bot("happy", key: "chief_of_staff", status: "stopped", agent: "bot-agent")]).chiefOfStaffAgentId)
        XCTAssertNil(Places(bots: [bot("happy", key: "chief_of_staff", status: "active", agent: nil)]).chiefOfStaffAgentId,
                     "a bot with no conversation has nothing to type into")
        XCTAssertNil(Places(bots: [bot("other", key: "scheduler", status: "active", agent: "other-agent")]).chiefOfStaffAgentId)
    }
}
