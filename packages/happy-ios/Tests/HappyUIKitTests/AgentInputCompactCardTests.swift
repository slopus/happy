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

    private func host(_ card: AgentInputCardView) -> UIViewController {
        let controller = UIViewController()
        controller.view.frame = CGRect(x: 0, y: 0, width: 874, height: 402)
        controller.view.addSubview(card)
        card.frame.origin = CGPoint(x: 8, y: 320)
        controller.view.layoutIfNeeded()
        return controller
    }

    private func descendants(_ view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func panel(_ controller: UIViewController, id: String = "composer-options-panel") throws -> PickerPanelView {
        try XCTUnwrap(descendants(controller.view).compactMap { $0 as? PickerPanelView }.last { $0.accessibilityIdentifier == id })
    }

    private func lines(_ panel: PickerPanelView) -> [PickerLineView] {
        descendants(panel).compactMap { $0 as? PickerLineView }
    }

    private func tap(_ key: String, in panel: PickerPanelView) throws {
        let row = try XCTUnwrap(lines(panel).first { $0.accessibilityIdentifier == "picker-row:\(key)" })
        XCTAssertTrue(row.isEnabled)
        row.sendActions(for: .touchUpInside)
    }

    private func openOptions(_ card: AgentInputCardView) throws {
        let button = try XCTUnwrap(options(card))
        XCTAssertNil(button.menu)
        XCTAssertFalse(button.showsMenuAsPrimaryAction)
        _ = button.perform(Selector(("tapped")))
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

    /// Scrolled to its caret at the end, the third line shows whole under
    /// the second and no part of the first.
    func testAScrolledTextShowsWholeLines() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 874, height: 402))
        let card = card()
        window.addSubview(card)
        setCompact(card, true)
        card.text = "first line\nsecond line\nthird line"
        await card.textMeasured()
        card.frame.size.height = card.height(fitting: width)
        card.layoutIfNeeded()
        let layout = card.layout(width: width)
        XCTAssertTrue(layout.textScrolls)
        XCTAssertEqual(card.textView.textContainerInset.top, 0)
        XCTAssertEqual(card.textView.textContainerInset.bottom, 0)
        // Two lines tall and nothing around them, so the text scrolled to
        // its end shows the last two lines. TextKit 2 lays three 22-point
        // lines out in 64 or 66 here from run to run, so the content's
        // height isn't judged; the UI test's still is what shows it.
        let line = layout.text.height / 2
        XCTAssertEqual(line, 22)
        XCTAssertEqual(card.textView.bounds.height, 2 * line, accuracy: 0.01, "the view is two lines")

        setCompact(card, false)
        XCTAssertEqual(card.textView.textContainerInset.top, MobileComposerMetrics.mobile.inputPaddingTop)
        XCTAssertEqual(card.textView.textContainerInset.bottom, MobileComposerMetrics.mobile.inputPaddingBottom)
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
        let controller = host(card)
        try openOptions(card)
        let rows = lines(try panel(controller))
        XCTAssertEqual(rows.map(\.accessibilityLabel), ["Model: Opus", "Effort: High"])
        XCTAssertEqual(rows.map(\.isEnabled), [true, false])
        XCTAssertNil(card.layout(width: width).middleContent.permission, "permissions belong to the header")
    }

    func testEachRowReportsItsOwnChip() throws {
        let card = card()
        let recorder = Recorder()
        card.delegate = recorder
        card.configuration.effort = AgentInputChipConfiguration(content: .label("High"), accessibilityLabel: "Effort: High", menu: AgentInputMenu(sections: [.init(options: [
            .init(key: "low", label: "Low"), .init(key: "high", label: "High", isChecked: true),
        ])], selectedKey: nil))
        setCompact(card, true)
        let controller = host(card)
        try openOptions(card)
        try tap("chip:0", in: panel(controller))
        XCTAssertFalse(descendants(controller.view).contains { $0.accessibilityIdentifier == "composer-options-panel" })
        try openOptions(card)
        try tap("chip:1", in: panel(controller))
        try tap("low", in: panel(controller, id: "composer-chip-panel"))
        XCTAssertEqual(recorder.events, ["press model", "menu effort", "select low effort"])
    }

    func testTheMenuFollowsTheChips() throws {
        let card = card()
        setCompact(card, true)
        let controller = host(card)
        try openOptions(card)
        var configuration = card.configuration
        configuration.model = AgentInputChipConfiguration(content: .label("Sonnet"), accessibilityLabel: "Model: Sonnet", menu: nil, opensPicker: true)
        configuration.effort = nil
        card.configuration = configuration
        XCTAssertEqual(lines(try panel(controller)).map(\.accessibilityLabel), ["Model: Sonnet"])
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
