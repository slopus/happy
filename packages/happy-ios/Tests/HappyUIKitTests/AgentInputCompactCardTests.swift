#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The card compact: the text in the action row, and the chips behind an
/// options button that does what each chip would.
@MainActor
final class AgentInputCompactCardTests: XCTestCase {
    private let width: CGFloat = 858

    private final class Recorder: AgentInputCardDelegate {
        var events: [String] = []
        func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) { events.append("select \(key) \(chip)") }
        func agentInputCard(_ card: AgentInputCardView, didPress chip: AgentInputChip) { events.append("press \(chip)") }
        func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip) { events.append("menu \(chip)") }
        func agentInputCardDidRefuse(_ card: AgentInputCardView, control: AgentInputControl) { events.append("refuse \(control)") }
    }

    private let permissionMenu = AgentInputMenu(sections: [.init(options: [
        .init(key: "read", label: "Read only"),
        .init(key: "write", label: "Write", isChecked: true),
    ])], selectedKey: nil)

    private func chips(permissionMenu: AgentInputMenu?) -> AgentInputCardConfiguration {
        AgentInputCardConfiguration(
            placeholder: "Type a message ...",
            showsAdd: true,
            permission: AgentInputChipConfiguration(content: .label("Write"), accessibilityLabel: "Permission: Write", menu: permissionMenu),
            model: AgentInputChipConfiguration(content: .label("Opus"), accessibilityLabel: "Model: Opus", menu: nil, opensPicker: true),
            effort: AgentInputChipConfiguration(content: .label("High"), accessibilityLabel: "Effort: High", menu: nil),
            showsExpand: true
        )
    }

    private func card(_ configuration: AgentInputCardConfiguration? = nil) -> AgentInputCardView {
        let card = AgentInputCardView(configuration: configuration ?? chips(permissionMenu: permissionMenu))
        card.frame = CGRect(x: 0, y: 0, width: width, height: card.height(fitting: width))
        card.layoutIfNeeded()
        return card
    }

    private func setCompact(_ card: AgentInputCardView, _ compact: Bool) {
        card.configuration.compact = compact
        card.frame.size.height = card.height(fitting: width)
        card.layoutIfNeeded()
    }

    /// Frames set through a transform and back differ in the last bits.
    private func assertFrame(_ actual: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        for (a, e) in [(actual.minX, expected.minX), (actual.minY, expected.minY), (actual.width, expected.width), (actual.height, expected.height)] {
            XCTAssertEqual(a, e, accuracy: 1e-6, "\(actual) is not \(expected)", file: file, line: line)
        }
    }

    private func options(_ view: UIView) -> ComposerOptionsButton? {
        (view as? ComposerOptionsButton) ?? view.subviews.lazy.compactMap(options).first
    }

    func testCompactIsOneRowAndTheSameText() async throws {
        let card = card()
        let textView = card.textView
        card.text = "hello there"
        textView.selectedRange = NSRange(location: 3, length: 2)
        await card.textMeasured()
        let full = card.height(fitting: width)
        let resting = card.restingHeight(fitting: width)

        setCompact(card, true)
        await card.textMeasured()
        let button = try XCTUnwrap(options(card))
        XCTAssertFalse(button.isHidden)
        XCTAssertEqual(button.accessibilityIdentifier, "composer-options")
        XCTAssertLessThan(card.height(fitting: width), full)
        XCTAssertEqual(card.height(fitting: width), card.layout(width: width).size.height)
        XCTAssertEqual(card.layout(width: width).options, button.frame)
        assertFrame(card.textView.frame, card.layout(width: width).text)
        // The text view is the same one, its text and selection kept.
        XCTAssertTrue(card.textView === textView)
        XCTAssertEqual(card.text, "hello there")
        XCTAssertEqual(card.selectedRange, NSRange(location: 3, length: 2))
        // What the owner decides from moves with neither.
        XCTAssertEqual(card.restingHeight(fitting: width), resting)

        setCompact(card, false)
        XCTAssertTrue(button.isHidden)
        XCTAssertTrue(card.textView === textView)
        XCTAssertEqual(card.height(fitting: width), full)
    }

    func testTheRestingHeightIgnoresTheText() async {
        let card = card()
        let resting = card.restingHeight(fitting: width)
        card.text = Array(repeating: "line", count: 8).joined(separator: "\n")
        await card.textMeasured()
        XCTAssertGreaterThan(card.height(fitting: width), resting)
        XCTAssertEqual(card.restingHeight(fitting: width), resting)
    }

    func testTheMenuHoldsEveryChipAsItActs() throws {
        let card = card()
        setCompact(card, true)
        let menu = try XCTUnwrap(options(card)?.menu)
        XCTAssertEqual(menu.children.map(\.title), ["Permission: Write", "Model: Opus", "Effort: High"])
        // A chip with a menu: its rows load as it opens.
        let permission = try XCTUnwrap(menu.children[0] as? UIMenu)
        XCTAssertTrue(permission.children.first is UIDeferredMenuElement)
        // A chip that opens its owner's picker.
        let model = try XCTUnwrap(menu.children[1] as? UIAction)
        XCTAssertFalse(model.attributes.contains(.disabled))
        // A chip with neither, dimmed on the card: dimmed here.
        let effort = try XCTUnwrap(menu.children[2] as? UIAction)
        XCTAssertTrue(effort.attributes.contains(.disabled))
    }

    func testEachRowReportsItsOwnChip() throws {
        let card = card()
        let recorder = Recorder()
        card.delegate = recorder
        setCompact(card, true)
        let button = try XCTUnwrap(options(card))
        let model = try XCTUnwrap(button.menu?.children[1] as? UIAction)
        button.sendAction(model)
        button.onSelect?("read", .permission)
        button.onMenu?(.permission)
        XCTAssertEqual(recorder.events, ["press model", "select read permission", "menu permission"])
    }

    func testTheMenuFollowsTheChips() throws {
        let card = card()
        setCompact(card, true)
        var configuration = card.configuration
        configuration.model = AgentInputChipConfiguration(content: .label("Sonnet"), accessibilityLabel: "Model: Sonnet", menu: nil, opensPicker: true)
        configuration.effort = nil
        card.configuration = configuration
        XCTAssertEqual(try XCTUnwrap(options(card)?.menu).children.map(\.title), ["Permission: Write", "Model: Sonnet"])
    }

    func testRefusingShakesAndSaysSo() throws {
        var configuration = chips(permissionMenu: permissionMenu)
        configuration.refusesControls = true
        let card = card(configuration)
        let recorder = Recorder()
        card.delegate = recorder
        setCompact(card, true)
        let button = try XCTUnwrap(options(card))
        XCTAssertNil(button.menu)
        XCTAssertFalse(button.showsMenuAsPrimaryAction)
        // A tap's action, as a touch sends it: a button outside a window
        // doesn't forward `sendActions(for:)` here.
        XCTAssertEqual(button.actions(forTarget: button, forControlEvent: .touchUpInside), ["tapped"])
        _ = button.perform(Selector(("tapped")))
        XCTAssertEqual(recorder.events, ["refuse options"])
    }

    func testNoChipsOrZenNoButton() throws {
        let plain = card(AgentInputCardConfiguration(placeholder: "Type a message ...", showsAdd: true))
        setCompact(plain, true)
        XCTAssertEqual(try XCTUnwrap(options(plain)).isHidden, true)
        var zen = chips(permissionMenu: nil)
        zen.zenMode = true
        let quiet = card(zen)
        setCompact(quiet, true)
        XCTAssertEqual(try XCTUnwrap(options(quiet)).isHidden, true)
    }

    /// The picker a chip opens stands over the button that holds it.
    func testAChipStandsWhereItsButtonIs() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 874, height: 402))
        let card = card()
        window.addSubview(card)
        setCompact(card, true)
        let button = try XCTUnwrap(options(card))
        XCTAssertEqual(card.chipFrame(.model, in: card), button.frame)
        setCompact(card, false)
        XCTAssertNotEqual(card.chipFrame(.model, in: card), button.frame)
    }

    func testTheFlatPanelIgnoresCompact() throws {
        var configuration = chips(permissionMenu: permissionMenu)
        configuration.desktop = AgentInputDesktopConfiguration(send: AgentInputDesktopSend(hasText: false, hasComposerContent: false, isSendBlocked: false))
        let panel = card(configuration)
        let height = panel.height(fitting: width)
        setCompact(panel, true)
        XCTAssertEqual(panel.height(fitting: width), height)
        XCTAssertEqual(try XCTUnwrap(options(panel)).isHidden, true)
    }
}
#endif
