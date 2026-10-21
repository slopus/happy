#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Return and a hardware keyboard's Tab go to the card's owner, which may
/// swallow them to pick a suggestion (AgentInput's handleKeyPress).
@MainActor
final class AgentInputCardKeyTests: XCTestCase {
    private final class Picker: AgentInputCardDelegate {
        var keys: [String] = []

        func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool {
            keys.append("return")
            return false
        }

        func agentInputCardShouldInsertTab(_ card: AgentInputCardView) -> Bool {
            keys.append("tab")
            return false
        }
    }

    /// Home's dock: Return only.
    private final class ReturnOnly: AgentInputCardDelegate {
        func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool { false }
    }

    private func type(_ text: String, into card: AgentInputCardView) -> Bool {
        card.textView(card.textView, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: text)
    }

    func testReturnAndTabReachTheOwner() {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        let picker = Picker()
        card.delegate = picker
        XCTAssertFalse(type("\n", into: card))
        XCTAssertFalse(type("\t", into: card))
        XCTAssertTrue(type("a", into: card))
        // Only a lone tab is a key; pasted text with one in it is text.
        XCTAssertTrue(type("a\tb", into: card))
        XCTAssertEqual(picker.keys, ["return", "tab"])
    }

    func testAnOwnerThatOnlyTakesReturnGetsItsTabsTyped() {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        let owner = ReturnOnly()
        card.delegate = owner
        XCTAssertFalse(type("\n", into: card))
        XCTAssertTrue(type("\t", into: card))
    }
}
#endif
