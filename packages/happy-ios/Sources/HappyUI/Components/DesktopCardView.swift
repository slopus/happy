#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The Happy CLI home's migration card, the first of the notices over the
/// list (`HomeListHeaderView`), with its path's line icon. A tap anywhere
/// opens the migration screen; the × closes it for good. VoiceOver reads
/// it as one button, its title then its words, that opens the screen,
/// with Close among its actions. `DesktopCardLayout` places it.
final class DesktopCardView: UIControl {
    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?

    let icon: LineIconView
    let titleLabel = StyledLabel(style: TextStyles.checklistTitle, color: Palette.text)
    let bodyLabel = StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary)
    let close = UIButton(type: .system)

    init(icon: LineIcon, title: String, body: String) {
        self.icon = LineIconView(icon, tint: Palette.text)
        super.init(frame: .zero)
        titleLabel.string = title
        bodyLabel.string = body
        titleLabel.isUserInteractionEnabled = false
        bodyLabel.isUserInteractionEnabled = false
        close.setImage(.icon(.ionicons("close"), size: DesktopCardLayout.Metrics.closeGlyph).withRenderingMode(.alwaysTemplate), for: .normal)
        close.tintColor = UIColor(Palette.textSecondary)
        close.accessibilityLabel = Strings.DesktopMigration.close
        close.accessibilityIdentifier = "desktop-card-close"
        close.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        for view in [self.icon, titleLabel, bodyLabel, close] as [UIView] { addSubview(view) }
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityValue = body
        accessibilityTraits = .button
        accessibilityCustomActions = [UIAccessibilityCustomAction(name: Strings.DesktopMigration.close) { [weak self] _ in
            self?.onClose?()
            return true
        }]
        accessibilityIdentifier = "desktop-card"
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func layout(width: CGFloat) -> DesktopCardLayout {
        DesktopCardLayout(width: width, title: titleLabel.measurable, body: bodyLabel.measurable)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        icon.setLayoutFrame(layout.icon)
        titleLabel.setLayoutFrame(layout.title)
        bodyLabel.setLayoutFrame(layout.body)
        close.setLayoutFrame(layout.close)
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : nil }
    }

    override func accessibilityActivate() -> Bool {
        onOpen?()
        return true
    }

    @objc private func tapped() {
        onOpen?()
    }
}
#endif
