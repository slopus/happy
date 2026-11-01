#if canImport(UIKit)
import HappyLayout
import UIKit

/// "Deleted “Milk” · Undo": a glass capsule over the bottom of the list
/// for a few seconds after a delete (`TodoToastLayout`). A later delete
/// takes its place; the undo goes with it.
@MainActor
final class TodoUndoBar: UIView {
    private let glass = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    private let label = UILabel()
    let button = UIButton(type: .system)
    private var undo: (() -> Void)?
    private var hiding: Task<Void, Never>?
    /// Where the list's bottom is: the safe area or the keyboard.
    var bottomInset: CGFloat = 0 { didSet { setNeedsLayout() } }

    static let seconds: Double = 5

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "todo-undo"
        glass.clipsToBounds = true
        glass.layer.cornerCurve = .continuous
        addSubview(glass)
        label.font = Fonts.ui(.regular, size: TodoMetrics.toastTextSize)
        label.textColor = UIColor(Palette.text)
        label.lineBreakMode = .byTruncatingMiddle
        glass.contentView.addSubview(label)
        var configuration = UIButton.Configuration.plain()
        configuration.attributedTitle = AttributedString(Strings.Todos.undo, attributes: AttributeContainer([.font: Fonts.ui(.semiBold, size: TodoMetrics.toastTextSize)]))
        configuration.contentInsets = .zero
        button.configuration = configuration
        button.tintColor = UIColor(Palette.todoCheck)
        button.accessibilityIdentifier = "todo-undo-button"
        button.addAction(UIAction { [weak self] _ in self?.tappedUndo() }, for: .primaryActionTriggered)
        glass.contentView.addSubview(button)
        alpha = 0
        isHidden = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Says `words` with an undo, and goes after a few seconds.
    func show(_ words: String, undo: @escaping () -> Void) {
        self.undo = undo
        label.text = words
        accessibilityLabel = words
        setNeedsLayout()
        layoutIfNeeded()
        isHidden = false
        let reduced = UIAccessibility.isReduceMotionEnabled
        if alpha == 0, !reduced { glass.transform = CGAffineTransform(translationX: 0, y: 16) }
        UIView.animate(withDuration: reduced ? 0 : 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
            self.alpha = 1
            self.glass.transform = .identity
        }
        UIAccessibility.post(notification: .announcement, argument: words)
        hiding?.cancel()
        hiding = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.seconds))
            guard !Task.isCancelled else { return }
            self?.hide()
        }
    }

    func hide() {
        hiding?.cancel()
        hiding = nil
        undo = nil
        guard !isHidden else { return }
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.2, animations: { self.alpha = 0 }) { _ in
            if self.undo == nil { self.isHidden = true }
        }
    }

    private func tappedUndo() {
        let undo = undo
        hide()
        undo?()
    }

    var isShowing: Bool { !isHidden && undo != nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        let labelSize = label.sizeThatFits(CGSize(width: 10_000, height: 100))
        let buttonSize = button.sizeThatFits(CGSize(width: 200, height: 44))
        let layout = TodoToastLayout(width: bounds.width, height: bounds.height, bottom: bottomInset, label: labelSize, button: buttonSize)
        glass.frame = layout.frame
        glass.layer.cornerRadius = layout.frame.height / 2
        label.frame = layout.label
        button.frame = layout.button.insetBy(dx: -8, dy: -10)
    }

    // Only the capsule takes touches; the list under the rest stays live.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        !isHidden && glass.frame.contains(point)
    }
}
#endif
