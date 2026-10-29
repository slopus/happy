import Foundation
import XCTest
@testable import HappyCore

/// `message.delta` applied exactly as happy-agent's API asks.
final class StemCellConversationTests: XCTestCase {
    private func message(_ text: String) -> AgentWire.Message {
        AgentWire.Message(id: "m", role: "agent", createdAt: 0, content: [.reasoning("…"), .text(text)])
    }

    private func text(_ message: AgentWire.Message?) -> String? {
        guard let message, case .text(let text) = message.content[1] else { return nil }
        return text
    }

    func testAnAppendAtTheEndGrowsTheBlock() {
        XCTAssertEqual(text(StemCellConversation.grow(message("Hel"), block: 1, offset: 3, append: "lo")), "Hello")
    }

    func testAReplayChangesNothing() {
        XCTAssertEqual(text(StemCellConversation.grow(message("Hello"), block: 1, offset: 3, append: "lo")), "Hello")
    }

    func testAPartlyAppliedAppendAddsOnlyWhatIsMissing() {
        XCTAssertEqual(text(StemCellConversation.grow(message("Hell"), block: 1, offset: 3, append: "lo!")), "Hello!")
    }

    func testOffsetsCountUTF16() {
        // "👋" is two UTF-16 units.
        XCTAssertEqual(text(StemCellConversation.grow(message("👋"), block: 1, offset: 2, append: " hi")), "👋 hi")
    }

    func testAGapOrAConflictAsksForHistory() {
        XCTAssertNil(StemCellConversation.grow(message("He"), block: 1, offset: 3, append: "lo"))
        XCTAssertNil(StemCellConversation.grow(message("Help"), block: 1, offset: 3, append: "lo"))
        XCTAssertNil(StemCellConversation.grow(message("Hel"), block: 2, offset: 0, append: "x"))
    }

    func testAnotherAgentsMessageIsACollaboratorsButNeverItsOwnOrItsParents() throws {
        let json = #"{"id":"m","role":"agent","createdAt":1,"content":[{"type":"text","text":"Collaborator c1 finished working."}],"metadata":{"senderAgentId":"c1","senderAgentExplanation":"Finished: final answer"}}"#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.metadata, AgentWire.MessageMetadata(senderAgentId: "c1", senderAgentExplanation: "Finished: final answer"))
        let sender = StemCellConversation.collaborator(message, agentId: "me", parentAgentId: "boss")
        XCTAssertEqual(sender?.agentId, "c1")
        XCTAssertEqual(sender?.explanation, "Finished: final answer")
        // Driving itself, or the agent that manages it: dialogue, not a row.
        XCTAssertNil(StemCellConversation.collaborator(message, agentId: "c1", parentAgentId: nil))
        XCTAssertNil(StemCellConversation.collaborator(message, agentId: "me", parentAgentId: "c1"))
        // Typed by the person: no sender at all.
        XCTAssertNil(StemCellConversation.collaborator(self.message("hi"), agentId: "me", parentAgentId: nil))
    }

    func testTheDaemonsAddressingLineIsTrimmed() {
        XCTAssertEqual(StemCellConversation.inboundText("Message from agent c1:\n\nDone.", agentId: "c1"), "Done.")
        XCTAssertEqual(StemCellConversation.inboundText("Message from agent c2: Done.", agentId: "c1"), "Message from agent c2: Done.")
    }

    /// The phone keeps a conversation's newest page of runs, as desktop keeps
    /// one nobody reads; what is pending stays whatever run it is in.
    func testThePhoneKeepsTheNewestRuns() {
        let runs = (0..<150).map { (id: "r\($0)", messageIds: ["u\($0)", "a\($0)"]) }
        var messages = Dictionary(uniqueKeysWithValues: runs.flatMap(\.messageIds).map { ($0, AgentWire.Message(id: $0, role: "user", createdAt: 0, content: [.text($0)])) })
        messages["p"] = AgentWire.Message(id: "p", role: "user", createdAt: 0, content: [.text("p")])
        let kept = StemCellConversation.kept(runs: runs, messages: messages, pending: ["p", "u3"])
        XCTAssertTrue(kept.trimmed)
        XCTAssertEqual(kept.runs.map(\.id), (50..<150).map { "r\($0)" })
        XCTAssertEqual(Set(kept.messages.keys), Set((50..<150).flatMap { ["u\($0)", "a\($0)"] } + ["p", "u3"]))
        // A short one is kept whole.
        let short = StemCellConversation.kept(runs: Array(runs.prefix(100)), messages: messages, pending: [])
        XCTAssertFalse(short.trimmed)
        XCTAssertEqual(short.runs.count, 100)
        XCTAssertEqual(short.messages.count, messages.count)
    }

    func testAMessageWithoutAPictureBytesStillDecodes() throws {
        let json = #"{"id":"m","role":"user","createdAt":1,"content":[{"type":"text","text":"hi"},{"type":"image","mimeType":"image/png"}],"metadata":{}}"#
        let decoded = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.content, [.text("hi"), .unknown("image")])
    }
}

/// Soft breaks as remark reads them on desktop.
final class StemCellMarkdownTests: XCTestCase {
    private func join(_ text: String) -> String { StemCellMarkdown.joiningSoftBreaks(text) }

    func testASoftBreakIsASpace() {
        XCTAssertEqual(join("Spiky-dreamed,\nit envies thorns,\nbut syrup drips."), "Spiky-dreamed, it envies thorns, but syrup drips.")
    }

    func testABlankLineStartsAParagraph() {
        XCTAssertEqual(join("One\ntwo\n\nThree"), "One two\n\nThree")
    }

    func testBlocksKeepTheirLines() {
        let text = "Intro\n- a\n- b\n1. c\n# Head\nAfter\n> quote\n| a | b |\n| - | - |\n---"
        XCTAssertEqual(join(text), text)
    }

    func testCodeIsLeftAlone() {
        let text = "Run\n```sh\nline one\nline two\n```\nthen\nthis"
        XCTAssertEqual(join(text), "Run\n```sh\nline one\nline two\n```\nthen this")
    }

    func testAHardBreakKeepsItsLine() {
        XCTAssertEqual(join("End  \nNext\\\nLast"), "End  \nNext\\\nLast")
    }

    func testAListItemRunsOnLazily() {
        XCTAssertEqual(join("- first\n  more\n- second"), "- first more\n- second")
    }
}
