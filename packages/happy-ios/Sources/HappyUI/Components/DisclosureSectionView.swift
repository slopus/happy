#if canImport(UIKit)
import HappyLayout
import UIKit

/// A section that opens in place: a title whose chevron turns as it opens,
/// then its paragraphs, all centred. Closed until its title is tapped;
/// each tap flips it and calls `onToggle`, for the host to lay out again
/// (inside an animation, the section grows over its paragraphs and they
/// fade in). `DisclosureSectionLayout` places it.
final class DisclosureSectionView: UIView {
    private typealias M = DisclosureSectionLayout.Metrics

    private let header = UIControl()
    private let titleLabel: StyledLabel
    private let chevron: IconView
    private let paragraphs: [StyledLabel]
    private(set) var isExpanded = false
    var onToggle: (() -> Void)?

    init(title: String, paragraphs: [String], titleStyle: TextStyle, style: TextStyle, titleColor: ColorToken, color: ColorToken, identifier: String) {
        titleLabel = StyledLabel(style: titleStyle, color: titleColor, alignment: .center)
        titleLabel.string = title
        chevron = IconView(.ionicons("chevron-down"), size: M.chevron, tint: titleColor)
        self.paragraphs = paragraphs.map { text in
            let label = StyledLabel(style: style, color: color, alignment: .center)
            label.string = text
            return label
        }
        super.init(frame: .zero)
        clipsToBounds = true
        titleLabel.isUserInteractionEnabled = false
        header.addSubview(titleLabel)
        header.addSubview(chevron)
        header.layer.cornerRadius = TextActionLayout.Metrics.cornerRadius
        header.isAccessibilityElement = true
        header.accessibilityLabel = title
        header.accessibilityTraits = .button
        header.accessibilityIdentifier = identifier
        header.addAction(UIAction { [weak self] _ in self?.toggle() }, for: .touchUpInside)
        header.addAction(UIAction { [weak header] _ in header?.backgroundColor = UIColor(Palette.surfacePressedOverlay) }, for: [.touchDown, .touchDragEnter])
        header.addAction(UIAction { [weak header] _ in header?.backgroundColor = nil }, for: [.touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel])
        addSubview(header)
        for label in self.paragraphs { addSubview(label) }
        applyState()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func layout(width: CGFloat) -> DisclosureSectionLayout {
        DisclosureSectionLayout(width: width, title: titleLabel.measurable, paragraphs: paragraphs.map(\.measurable), expanded: isExpanded)
    }

    /// Its size closed, whether or not it is open now.
    var closedMeasurable: Measurable {
        Measurable { [unowned self] width in
            DisclosureSectionLayout(width: width, title: titleLabel.measurable, paragraphs: [], expanded: false).size
        }
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        header.setLayoutFrame(layout.header)
        titleLabel.setLayoutFrame(layout.title)
        // Turned by its transform, so placed by its centre.
        chevron.bounds = CGRect(origin: .zero, size: layout.chevron.size)
        chevron.center = CGPoint(x: layout.chevron.midX, y: layout.chevron.midY)
        for (label, frame) in zip(paragraphs, layout.paragraphs) { label.setLayoutFrame(frame) }
        applyState()
    }

    private func applyState() {
        chevron.transform = isExpanded ? CGAffineTransform(rotationAngle: .pi) : .identity
        for label in paragraphs {
            label.alpha = isExpanded ? 1 : 0
            label.accessibilityElementsHidden = !isExpanded
        }
    }

    private func toggle() {
        isExpanded.toggle()
        onToggle?()
    }
}
#endif
