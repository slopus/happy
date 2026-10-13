#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// LongPressCopyable's CopyMenu: one "Copy" item in a small card over the
/// message, laid over the whole window; a tap anywhere else closes it.
final class ChatCopyMenu: UIView {
    private let text: String
    private let anchor: CGRect
    private let card = UIView()
    private let item = ChatCopyMenuItem()
    private var closing = false

    /// Opens the menu for `anchor` (in `view`'s coordinates), with a light
    /// tap of the haptics.
    static func present(copying text: String, anchor: CGRect, in view: UIView) {
        guard let window = view.window else { return }
        let menu = ChatCopyMenu(text: text, anchor: view.convert(anchor, to: window))
        menu.frame = window.bounds
        window.addSubview(menu)
        menu.layoutIfNeeded()
        menu.animateIn()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        UIAccessibility.post(notification: .screenChanged, argument: menu.item)
    }

    private init(text: String, anchor: CGRect) {
        self.text = text
        self.anchor = anchor
        super.init(frame: .zero)
        accessibilityViewIsModal = true
        let backdrop = UIControl()
        backdrop.frame = bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        backdrop.addTarget(self, action: #selector(close), for: .touchUpInside)
        addSubview(backdrop)

        typealias M = CopyMenuLayout.Metrics
        card.layer.cornerRadius = M.radius
        card.layer.cornerCurve = .continuous
        card.layer.shadowColor = UIColor(Palette.shadow).cgColor
        card.layer.shadowOpacity = M.shadowOpacity
        card.layer.shadowRadius = M.shadowRadius
        card.layer.shadowOffset = CGSize(width: 0, height: M.shadowOffsetY)
        addSubview(card)
        item.layer.cornerRadius = M.radius
        item.layer.cornerCurve = .continuous
        item.clipsToBounds = true
        item.addTarget(self, action: #selector(copyText), for: .touchUpInside)
        card.addSubview(item)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = CopyMenuLayout(anchor: anchor, window: bounds.size, label: item.labelMeasurable)
        card.bounds = CGRect(origin: .zero, size: layout.menu.size)
        card.center = CGPoint(x: layout.menu.midX, y: layout.menu.midY)
        card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: CopyMenuLayout.Metrics.radius).cgPath
        card.layer.borderWidth = hairline
        item.frame = card.bounds
        item.apply(layout)
    }

    private func applyColors() {
        card.backgroundColor = UIColor(Palette.surface)
        card.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }

    private func animateIn() {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        typealias M = CopyMenuLayout.Metrics
        card.alpha = 0
        card.transform = CGAffineTransform(translationX: 0, y: M.enterOffsetY).scaledBy(x: M.enterScale, y: M.enterScale)
        let animator = UIViewPropertyAnimator(duration: M.enterDuration, timingParameters: UICubicTimingParameters(controlPoint1: CGPoint(x: 0.33, y: 1), controlPoint2: CGPoint(x: 0.68, y: 1)))
        animator.addAnimations { [card] in
            card.alpha = 1
            card.transform = .identity
        }
        animator.startAnimation()
    }

    @objc private func copyText() {
        UIPasteboard.general.string = text
        close()
    }

    @objc private func close() {
        guard !closing else { return }
        closing = true
        isUserInteractionEnabled = false
        guard !UIAccessibility.isReduceMotionEnabled else {
            removeFromSuperview()
            return
        }
        let animator = UIViewPropertyAnimator(duration: CopyMenuLayout.Metrics.exitDuration, timingParameters: UICubicTimingParameters(controlPoint1: CGPoint(x: 0.32, y: 0), controlPoint2: CGPoint(x: 0.67, y: 0)))
        animator.addAnimations { [card] in card.alpha = 0 }
        animator.addCompletion { [weak self] _ in self?.removeFromSuperview() }
        animator.startAnimation()
    }

    override func accessibilityPerformEscape() -> Bool {
        close()
        return true
    }
}

/// The menu's one row: the copy glyph and "Copy", greyed while pressed.
private final class ChatCopyMenuItem: UIControl {
    private let icon = UIImageView()
    private let label = ChatTextView()
    private let text = MeasuredText(ChatTextStyles.copyMenuLabel.string(Strings.Chat.copy, color: Palette.text), maxLines: 1)

    var labelMeasurable: Measurable { text.measurable }

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.image = .icon(.ionicons("copy-outline"), size: CopyMenuLayout.Metrics.iconSize)
        icon.tintColor = UIColor(Palette.text)
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        label.isUserInteractionEnabled = false
        label.isAccessibilityElement = false
        addSubview(icon)
        addSubview(label)
        isAccessibilityElement = true
        accessibilityLabel = Strings.Chat.copy
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ layout: CopyMenuLayout) {
        icon.frame = layout.icon
        label.frame = layout.label
        label.layout = text.layout(for: layout.label)
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfaceSelected) : .clear }
    }
}

/// React Native's `selectable` Text on iOS: a long press brings up the
/// edit menu with Copy, which copies all of the text.
///
/// The SDK leaves the delegate protocol unisolated, though UIKit only ever
/// calls it on the main thread; `@preconcurrency` checks that at run time.
@MainActor
final class ChatCopyCallout: NSObject, @preconcurrency UIEditMenuInteractionDelegate {
    private var interaction: UIEditMenuInteraction?
    private var text: String?

    /// Shows the menu at `point`, in `view`'s coordinates.
    func present(copying text: String, at point: CGPoint, in view: UIView) {
        let interaction: UIEditMenuInteraction
        if let existing = self.interaction, existing.view === view {
            interaction = existing
        } else {
            if let existing = self.interaction { existing.view?.removeInteraction(existing) }
            interaction = UIEditMenuInteraction(delegate: self)
            view.addInteraction(interaction)
            self.interaction = interaction
        }
        self.text = text
        interaction.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }

    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard let text else { return nil }
        return UIMenu(children: [UIAction(title: Strings.Chat.copy) { _ in
            UIPasteboard.general.string = text
        }])
    }
}
#endif
