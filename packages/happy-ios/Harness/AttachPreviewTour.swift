#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import UIKit

/// QA only (`-attachPreviewTour`, after `-open`): opens the chat's "+"
/// menu, picture 2 whole, and types a caption in it, from inside the app,
/// for a device where UI automation can't start. Each step prints
/// `[attach-tour] <step>` and holds for a screenshot.
@MainActor
enum AttachPreviewTour {
    static func run(window: UIWindow, caption: String) async {
        try? await Task.sleep(for: .seconds(1.5))
        guard let plus = find(window, { ($0 as? UIControl).map { ["Add photo", "Add a picture"].contains($0.accessibilityLabel ?? "") } ?? false }) as? UIControl else {
            return print("[attach-tour] no +")
        }
        plus.sendActions(for: .touchUpInside)
        try? await Task.sleep(for: .seconds(1.5))
        guard let cell = find(window, { $0.accessibilityIdentifier == "attach-photo:2" }), let open = cell.accessibilityCustomActions?.first else {
            return print("[attach-tour] no picture 2")
        }
        _ = open.actionHandler?(open)
        try? await Task.sleep(for: .seconds(1.5))
        print("[attach-tour] rest")
        try? await Task.sleep(for: .seconds(4))
        guard let field = find(window, { $0.accessibilityIdentifier == "attach-preview-caption" }) as? UITextView else {
            return print("[attach-tour] no caption")
        }
        field.becomeFirstResponder()
        field.insertText(caption)
        try? await Task.sleep(for: .seconds(1.5))
        print("[attach-tour] typing")
    }

    /// The first view under every window of `window`'s scene that `matches`.
    private static func find(_ window: UIWindow, _ matches: (UIView) -> Bool) -> UIView? {
        var stack: [UIView] = window.windowScene?.windows ?? [window]
        while let view = stack.popLast() {
            if matches(view), !view.isHidden { return view }
            stack.append(contentsOf: view.subviews)
        }
        return nil
    }
}
#endif
