#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyUI
import UIKit

/// Fixture-only evidence for composer panels (`-composerKeyboardProbe`).
/// Samples the real editor and keyboard on every display callback so a
/// resign/re-focus between two XCTest reads cannot pass as preservation.
@MainActor
final class ComposerKeyboardProbe: NSObject {
    private weak var window: UIWindow?
    private weak var editor: UITextView?
    private let report = ComposerKeyboardReport()
    private var link: CADisplayLink?
    private var keyboardScreenFrame = CGRect.zero
    private var keyboardHides = 0
    private var editingEnds = 0
    private var lostResponderFrames = 0
    private var missingKeyboardFrames = 0
    private var monitoring = false
    private var seededSelection = false
    private var frames: [[String: Any]] = []
    private let seedDraft: String?
    private let seedRange: NSRange?

    init(window: UIWindow, arguments: [String]) {
        self.window = window
        func argument(_ flag: String) -> String? {
            arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        seedDraft = argument("-composerProbeDraft")
        let values = argument("-composerProbeRange")?.split(separator: ",").compactMap { Int($0) }
        seedRange = values.flatMap { $0.count == 2 ? NSRange(location: $0[0], length: $0[1]) : nil }
        super.init()
        report.isAccessibilityElement = true
        report.accessibilityIdentifier = "composer-keyboard-probe"
        report.frame = CGRect(x: 2, y: 2, width: 1, height: 1)
        window.addSubview(report)
        report.read = { [weak self] in self?.json() ?? "{}" }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardHidden), name: UIResponder.keyboardWillHideNotification, object: nil)
        center.addObserver(self, selector: #selector(editingEnded(_:)), name: UITextView.textDidEndEditingNotification, object: nil)
        let link = CADisplayLink(target: self, selector: #selector(sample))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func keyboardChanged(_ note: Notification) {
        guard let rect = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        keyboardScreenFrame = rect
    }

    @objc private func keyboardHidden() { if monitoring { keyboardHides += 1 } }

    @objc private func editingEnded(_ note: Notification) {
        if monitoring, let ended = note.object as? UITextView, ended === editor { editingEnds += 1 }
    }

    private func descendants(_ root: UIView) -> [UIView] {
        [root] + root.subviews.flatMap(descendants)
    }

    private func rect(_ value: CGRect) -> [Double] {
        [value.minX, value.minY, value.width, value.height].map(Double.init)
    }

    private func identity(_ value: AnyObject?) -> String {
        value.map { String(describing: ObjectIdentifier($0)) } ?? "none"
    }

    private func state() -> [String: Any] {
        guard let window else { return [:] }
        let views = descendants(window)
        let cards = views.compactMap { $0 as? AgentInputCardView }.filter { !$0.isHidden && $0.window != nil }
        let card = cards.first(where: { $0.textView.isFirstResponder }) ?? cards.first
        if let card { editor = card.textView }
        guard let editor else { return ["ready": false] }
        if !seededSelection, editor.isFirstResponder, editor.markedTextRange == nil,
           let seedDraft, editor.text == seedDraft, let seedRange,
           seedRange.location >= 0, seedRange.length >= 0, NSMaxRange(seedRange) <= (editor.text as NSString).length {
            editor.selectedRange = seedRange
            seededSelection = true
        }
        let keyboard = window.convert(keyboardScreenFrame, from: window.screen.coordinateSpace)
        let keyboardIntersection = window.bounds.intersection(keyboard)
        let keyboardVisible = !keyboardIntersection.isNull && keyboardIntersection.height > 1
        let responder = views.first(where: \.isFirstResponder)
        let panelIDs: Set<String> = ["attach-sheet", "picker-models", "picker-efforts", "picker-accounts", "composer-options-panel", "composer-chip-panel", "chat-menu", "chat-permissions"]
        let panels: [[String: Any]] = views.compactMap { view in
            guard let id = view.accessibilityIdentifier, panelIDs.contains(id), !view.isHidden, view.alpha > 0.01 else { return nil }
            var visibleFrame = view.convert(view.bounds, to: window).intersection(window.bounds)
            var ancestor = view.superview
            var enclosingScrolls: [UIScrollView] = []
            while let parent = ancestor {
                if parent.clipsToBounds { visibleFrame = visibleFrame.intersection(parent.convert(parent.bounds, to: window)) }
                if let scroll = parent as? UIScrollView { enclosingScrolls.append(scroll) }
                ancestor = parent.superview
            }
            guard !visibleFrame.isNull, !visibleFrame.isEmpty else { return nil }
            let scrolls = (enclosingScrolls + descendants(view).compactMap { $0 as? UIScrollView }).map { scroll in
                ["frame": rect(scroll.convert(scroll.bounds, to: window)), "contentSize": [Double(scroll.contentSize.width), Double(scroll.contentSize.height)], "scrollEnabled": scroll.isScrollEnabled] as [String: Any]
            }
            return ["id": id, "frame": rect(view.convert(view.bounds, to: window)), "visibleFrame": rect(visibleFrame), "scrolls": scrolls]
        }
        let chips: [[String: Any]] = card.map { card in
            [card.configuration.permission.map { (AgentInputChip.permission, $0) }, card.configuration.model.map { (AgentInputChip.model, $0) }, card.configuration.effort.map { (AgentInputChip.effort, $0) }].compactMap { $0 }.compactMap { chip, configuration in
                card.chipFrame(chip, in: window).map { ["kind": String(describing: chip), "label": configuration.accessibilityLabel, "frame": rect($0)] }
            }
        } ?? []
        let marked = editor.markedTextRange.map { range in
            [editor.offset(from: editor.beginningOfDocument, to: range.start), editor.offset(from: range.start, to: range.end)]
        }
        let navigation = views.compactMap { $0 as? UINavigationBar }.first { !$0.isHidden }
        let title = navigation?.topItem?.titleView
        let titleContent = title.flatMap { descendants($0).first { String(describing: type(of: $0)) == "ChatTitleView" } } ?? title
        let horizontalScrollers: [[String: Any]] = views.compactMap { view in
            guard let scroll = view as? UIScrollView, scroll.isScrollEnabled, scroll.alwaysBounceHorizontal,
                  scroll.contentSize.width > scroll.bounds.width + 1, !scroll.isHidden, scroll.alpha > 0.01 else { return nil }
            var visible = scroll.convert(scroll.bounds, to: window).intersection(window.bounds)
            var ancestor = scroll.superview
            while let parent = ancestor {
                if parent.clipsToBounds { visible = visible.intersection(parent.convert(parent.bounds, to: window)) }
                ancestor = parent.superview
            }
            let top = navigation.map { $0.convert($0.bounds, to: window).maxY } ?? window.safeAreaInsets.top
            let bottom = card.map { $0.convert($0.bounds, to: window).minY } ?? window.bounds.maxY
            visible = visible.intersection(CGRect(x: 0, y: top, width: window.bounds.width, height: max(0, bottom - top)))
            guard !visible.isNull, visible.width > 20, visible.height > 10 else { return nil }
            return ["id": identity(scroll), "class": String(describing: type(of: scroll)), "frame": rect(visible),
                    "offset": [Double(scroll.contentOffset.x), Double(scroll.contentOffset.y)],
                    "contentSize": [Double(scroll.contentSize.width), Double(scroll.contentSize.height)], "bounds": rect(scroll.bounds)]
        }
        return [
            "ready": true, "time": CACurrentMediaTime(), "editorID": identity(editor),
            "responderID": identity(responder), "firstResponder": editor.isFirstResponder,
            "draft": editor.text ?? "", "selection": [editor.selectedRange.location, editor.selectedRange.length],
            "markedRange": marked as Any? ?? NSNull(), "selectionSeeded": seededSelection,
            "window": rect(window.bounds), "safeArea": [Double(window.safeAreaInsets.top), Double(window.safeAreaInsets.left), Double(window.safeAreaInsets.bottom), Double(window.safeAreaInsets.right)],
            "editorFrame": rect(editor.convert(editor.bounds, to: window)),
            "cardFrame": card.map { rect($0.convert($0.bounds, to: window)) } ?? [],
            "keyboardFrame": rect(keyboard), "keyboardGuide": rect(window.keyboardLayoutGuide.layoutFrame),
            "keyboardVisible": keyboardVisible, "panels": panels,
            "chips": chips, "compact": card?.configuration.compact ?? false,
            "headerTitleFrame": titleContent.map { rect($0.convert($0.bounds, to: window)) } ?? [],
            "horizontalScrollers": horizontalScrollers,
            "keyboardHides": keyboardHides, "editingEnds": editingEnds,
            "lostResponderFrames": lostResponderFrames, "missingKeyboardFrames": missingKeyboardFrames
        ]
    }

    @objc private func sample() {
        var current = state()
        guard current["ready"] as? Bool == true else { return }
        if current["firstResponder"] as? Bool == true, current["keyboardVisible"] as? Bool == true { monitoring = true }
        if monitoring {
            if current["firstResponder"] as? Bool != true { lostResponderFrames += 1 }
            if current["keyboardVisible"] as? Bool != true { missingKeyboardFrames += 1 }
        }
        // Text is returned once in the current snapshot; the frame trace
        // keeps identity, selection, geometry and interruption counters.
        current.removeValue(forKey: "draft")
        frames.append(current)
        if frames.count > 1800 { frames.removeFirst(frames.count - 1800) }
        window?.bringSubviewToFront(report)
    }

    private func json() -> String {
        var result = state()
        result["frames"] = frames
        return (try? JSONSerialization.data(withJSONObject: result)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

private final class ComposerKeyboardReport: UIView {
    var read: (() -> String)?
    override var accessibilityValue: String? {
        get { read?() }
        set {}
    }
}
#endif