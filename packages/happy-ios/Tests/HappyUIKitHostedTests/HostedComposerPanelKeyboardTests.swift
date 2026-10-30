#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// VoiceOver Escape and marked-text preservation use UIKit's actual
/// responder and composition APIs. Finger-driven opening, selection and
/// outside dismissal are covered separately by the UI tests.
@MainActor
final class HostedComposerPanelKeyboardTests: XCTestCase {
    private final class Keyboard: NSObject {
        var frame = CGRect.zero
        var hides = 0
        var editingEnds = 0
        weak var editor: UITextView?

        override init() {
            super.init()
            let center = NotificationCenter.default
            center.addObserver(self, selector: #selector(change(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
            center.addObserver(self, selector: #selector(hide), name: UIResponder.keyboardWillHideNotification, object: nil)
            center.addObserver(self, selector: #selector(end(_:)), name: UITextView.textDidEndEditingNotification, object: nil)
        }
        @objc private func change(_ note: Notification) {
            if let value = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue { frame = value.cgRectValue }
        }
        @objc private func hide() { hides += 1 }
        @objc private func end(_ note: Notification) {
            if let field = note.object as? UITextView, field === editor { editingEnds += 1 }
        }
    }

    private func fixture() async throws -> (UIWindow, UIViewController, AgentInputCardView, Keyboard) {
        LegacyFonts.registerBundledFonts()
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let controller = UIViewController()
        let window = hostedKeyWindow(in: scene, root: controller)
        window.layoutIfNeeded()
        let menu = AgentInputMenu(sections: [.init(options: [
            .init(key: "more", label: "More", children: [.init(options: [.init(key: "second", label: "Second model")])]),
            .init(key: "first", label: "First model", isChecked: true),
        ])], selectedKey: "first")
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
            placeholder: "Panel keyboard fixture", showsAdd: true,
            model: AgentInputChipConfiguration(content: .label("First model"), accessibilityLabel: "Model: First model", menu: menu), compact: true
        ))
        controller.view.addSubview(card)
        card.frame = CGRect(x: 8, y: 300, width: controller.view.bounds.width - 16, height: card.height(fitting: controller.view.bounds.width - 16))
        card.layoutIfNeeded()
        let notes = Keyboard()
        notes.editor = card.textView
        card.text = "Draft before composition "
        XCTAssertTrue(card.textView.becomeFirstResponder())
        let deadline = ContinuousClock.now + .seconds(5)
        while notes.frame.intersection(window.bounds).height <= 1, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertGreaterThan(notes.frame.intersection(window.bounds).height, 1, "a software keyboard is required")
        card.frame.origin.y = notes.frame.minY - card.frame.height - 8
        card.layoutIfNeeded()
        card.textView.setMarkedText("かな", selectedRange: NSRange(location: 2, length: 0))
        XCTAssertNotNil(card.textView.markedTextRange)
        addTeardownBlock { @MainActor in
            card.textView.unmarkText()
            card.textView.resignFirstResponder()
            window.isHidden = true
            previous?.makeKey()
            withExtendedLifetime(notes) {}
        }
        return (window, controller, card, notes)
    }

    private func marked(_ editor: UITextView) -> NSRange? {
        editor.markedTextRange.map { range in
            NSRange(location: editor.offset(from: editor.beginningOfDocument, to: range.start), length: editor.offset(from: range.start, to: range.end))
        }
    }

    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }

    func testNestedMenuEscapePreservesMarkedTextAndKeyboard() async throws {
        let (_, controller, card, keyboard) = try await fixture()
        let editor = card.textView
        let before = (editor.text, editor.selectedRange, marked(editor), keyboard.frame, keyboard.hides, keyboard.editingEnds)
        let button = try XCTUnwrap(descendants(card).compactMap { $0 as? ComposerOptionsButton }.first)
        _ = button.perform(Selector(("tapped")))
        let root = try XCTUnwrap(descendants(controller.view).compactMap { $0 as? PickerOverlay }.last)
        let model = try XCTUnwrap(descendants(root).compactMap { $0 as? PickerLineView }.first { $0.accessibilityLabel == "Model: First model" })
        model.sendActions(for: .touchUpInside)
        let more = try XCTUnwrap(descendants(root).compactMap { $0 as? PickerLineView }.first { $0.accessibilityIdentifier == "picker-row:more" })
        more.sendActions(for: .touchUpInside)
        XCTAssertEqual(root.panels.count, 3)
        XCTAssertTrue(root.accessibilityPerformEscape())
        XCTAssertEqual(root.panels.count, 2, "Escape should dismiss only the top page")
        XCTAssertTrue(root.accessibilityPerformEscape())
        XCTAssertEqual(root.panels.count, 1)
        XCTAssertTrue(root.accessibilityPerformEscape())
        XCTAssertNil(root.superview)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(card.textView === editor)
        XCTAssertTrue(editor.isFirstResponder)
        XCTAssertEqual(editor.text, before.0)
        XCTAssertEqual(editor.selectedRange, before.1)
        XCTAssertEqual(marked(editor), before.2)
        XCTAssertEqual(keyboard.frame, before.3)
        XCTAssertEqual(keyboard.hides, before.4)
        XCTAssertEqual(keyboard.editingEnds, before.5)
    }

    func testEmbeddedPanelEscapePreservesMarkedTextAndKeyboard() async throws {
        let (_, controller, card, keyboard) = try await fixture()
        let editor = card.textView
        let before = (editor.text, editor.selectedRange, marked(editor), keyboard.frame, keyboard.hides, keyboard.editingEnds)
        let content = UIViewController()
        let presenter = ComposerPanelPresenter(content: content, height: 600, host: controller, anchor: card)
        presenter.onOutside = { [weak presenter] in presenter?.close() }
        presenter.show()
        XCTAssertTrue(content.parent === controller)
        let backdrop = try XCTUnwrap(controller.view.subviews.last)
        XCTAssertTrue(backdrop.accessibilityPerformEscape())
        XCTAssertNil(content.parent)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(editor.isFirstResponder)
        XCTAssertEqual(editor.text, before.0)
        XCTAssertEqual(editor.selectedRange, before.1)
        XCTAssertEqual(marked(editor), before.2)
        XCTAssertEqual(keyboard.frame, before.3)
        XCTAssertEqual(keyboard.hides, before.4)
        XCTAssertEqual(keyboard.editingEnds, before.5)
    }
}
#endif