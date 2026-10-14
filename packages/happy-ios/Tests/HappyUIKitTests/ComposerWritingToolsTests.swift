#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The composers' text views are TextKit 2, as RN's `RCTUITextView` is, so
/// UIKit resolves their Writing Tools to the complete, inline experience,
/// where a TextKit 1 view gets the limited panel. This is the behavior
/// UIKit resolves, not Writing Tools running: that needs a device with
/// Apple Intelligence.
@MainActor
final class ComposerWritingToolsTests: XCTestCase {
    /// The view's resolved Writing Tools behavior. Its coordinator is asked
    /// for only where the view answers for it, through a call that takes a
    /// nil: it is declared nonnull, and may be missing without Writing Tools.
    @available(iOS 18.2, *)
    func resolved(_ view: UITextView, file: StaticString = #filePath, line: UInt = #line) -> UIWritingToolsBehavior? {
        let selector = NSSelectorFromString("writingToolsCoordinator")
        guard view.responds(to: selector), let object = view.perform(selector)?.takeUnretainedValue() else {
            XCTFail("no Writing Tools coordinator", file: file, line: line)
            return nil
        }
        guard let coordinator = object as? UIWritingToolsCoordinator else {
            XCTFail("not a Writing Tools coordinator: \(type(of: object))", file: file, line: line)
            return nil
        }
        return coordinator.behavior
    }

    func testTheCardGetsInlineWritingTools() throws {
        guard #available(iOS 18.2, *) else { throw XCTSkip("Writing Tools' coordinator is iOS 18.2+") }
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."))
        XCTAssertEqual(card.textView.writingToolsBehavior, .default)
        XCTAssertEqual(resolved(card.textView), .complete)
        XCTAssertNotNil(card.textView.textLayoutManager)
    }

    func testTheFlatPanelGetsInlineWritingTools() throws {
        guard #available(iOS 18.2, *) else { throw XCTSkip("Writing Tools' coordinator is iOS 18.2+") }
        let send = AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false)
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
            placeholder: "Type a message ...", desktop: AgentInputDesktopConfiguration(send: send)
        ))
        card.frame = CGRect(x: 0, y: 0, width: 800, height: card.height(fitting: 800))
        card.layoutIfNeeded()
        XCTAssertEqual(resolved(card.textView), .complete)
        XCTAssertNotNil(card.textView.textLayoutManager)
    }

    func testTheNewSessionPromptGetsInlineWritingTools() throws {
        guard #available(iOS 18.2, *) else { throw XCTSkip("Writing Tools' coordinator is iOS 18.2+") }
        let composer = NewSessionComposerView(frame: .zero)
        XCTAssertEqual(composer.textView.writingToolsBehavior, .default)
        XCTAssertEqual(resolved(composer.textView), .complete)
        XCTAssertNotNil(composer.textView.textLayoutManager)
    }

    /// The control: what a TextKit 1 view, as the card's was, resolves to.
    func testATextKit1ViewGetsThePanel() throws {
        guard #available(iOS 18.2, *) else { throw XCTSkip("Writing Tools' coordinator is iOS 18.2+") }
        let view = UITextView(usingTextLayoutManager: false)
        XCTAssertEqual(view.writingToolsBehavior, .default)
        XCTAssertEqual(resolved(view), .limited)
    }
}
#endif
