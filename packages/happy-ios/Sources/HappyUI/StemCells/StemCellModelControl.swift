#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The home dock's model control, inside the capsule before send as
/// desktop's composer keeps it (ComposerModelControl.tsx): the model, its
/// effort quieter beside it, and a chevron. A press lists Model, Effort and
/// Provider, each opening its sheet. What is picked here is what new work
/// is sent with.
final class StemCellModelControl: UIButton {
    var onPick: ((StemCellModelPickers.Kind) -> Void)?
    private let summary = UILabel()
    private let chevron = UIImageView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        summary.lineBreakMode = .byTruncatingTail
        summary.isUserInteractionEnabled = false
        addSubview(summary)
        chevron.image = StemCellsGlyphs.image("chevron-down", size: 12)
        chevron.tintColor = UIColor(Palette.textSecondary)
        chevron.contentMode = .center
        chevron.isUserInteractionEnabled = false
        addSubview(chevron)
        preferredMenuElementOrder = .fixed
        accessibilityIdentifier = "stem-dock-model"
        // Nothing to list yet: a press asks the computer for its models again.
        addAction(UIAction { [weak self] _ in
            guard let self, menu == nil else { return }
            onPick?(.model)
        }, for: .touchUpInside)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(_ menus: StemCellModelMenus?) {
        let labels = StemCellModelPickers.chips(menus)
        let font = StemCellsFonts.ui(.medium, size: 14)
        let text = NSMutableAttributedString(string: labels.model, attributes: [.font: font, .foregroundColor: UIColor(Palette.text)])
        if let effort = labels.effort {
            text.append(NSAttributedString(string: " \(effort)", attributes: [.font: font, .foregroundColor: UIColor(Palette.textSecondary)]))
        }
        summary.attributedText = text
        accessibilityLabel = labels.effort.map { "\(labels.model), \($0)" } ?? labels.model
        let rows = StemCellModelPickers.settings(menus)
        chevron.isHidden = rows.isEmpty
        // Dimmed while there is nothing to pick, as the card's chips are.
        alpha = rows.isEmpty ? AgentInputCardLayout.Metrics.disabledChipOpacity : 1
        // The card's list: each setting under its name (StemCellModelPickers.configure).
        menu = rows.isEmpty ? nil : UIMenu(children: rows.map { row in
            UIMenu(title: row.name, options: .displayInline, children: [
                UIAction(title: row.value) { [weak self] _ in self?.onPick?(row.kind) },
            ])
        })
        showsMenuAsPrimaryAction = menu != nil
        superview?.setNeedsLayout()
        setNeedsLayout()
    }

    private func layout(width: CGFloat? = nil) -> StemCellModelControlLayout {
        let text = summary.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        return StemCellModelControlLayout(summary: text, chevron: !chevron.isHidden, width: width)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { layout().size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        summary.frame = layout.summary
        chevron.frame = layout.chevron ?? .zero
    }

    override var isHighlighted: Bool {
        didSet { summary.alpha = isHighlighted ? 0.6 : 1; chevron.alpha = summary.alpha }
    }
}
#endif
