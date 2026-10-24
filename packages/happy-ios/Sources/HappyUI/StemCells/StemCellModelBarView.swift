#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The home dock's pickers: Provider, Model and Effort as small glass pills
/// over the field, each opening its sheet. What is picked here is what new
/// work is sent with. Only the pills take touches.
final class StemCellModelBarView: UIView {
    var onPress: ((StemCellModelPickers.Kind) -> Void)?
    private let pills: [(kind: StemCellModelPickers.Kind, pill: StemCellModelPill)] = [
        (.provider, StemCellModelPill()), (.model, StemCellModelPill()), (.effort, StemCellModelPill()),
    ]
    private var field: CGRect = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        for (kind, pill) in pills {
            pill.accessibilityIdentifier = "stem-dock-\(kind.rawValue)"
            pill.addAction(UIAction { [weak self] _ in self?.onPress?(kind) }, for: .touchUpInside)
            addSubview(pill)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(_ menus: StemCellModelMenus?) {
        let labels = StemCellModelPickers.chips(menus)
        let values: [StemCellModelPickers.Kind: (String, String?)] = [
            .provider: (Strings.StemCells.provider, labels.provider.isEmpty ? nil : labels.provider),
            .model: (Strings.StemCells.model, labels.model),
            .effort: (Strings.StemCells.effort, labels.effort),
        ]
        for (kind, pill) in pills {
            let (name, value) = values[kind] ?? ("", nil)
            pill.isHidden = value == nil
            pill.configure(value ?? "", accessibility: Strings.StemCells.chipLabel(name, value ?? ""))
        }
        setNeedsLayout()
    }

    /// The bar for the dock's field, in this view.
    func layout(field: CGRect) -> StemCellModelBarLayout {
        StemCellModelBarLayout(field: field, labels: pills.filter { !$0.pill.isHidden }.map(\.pill.labelSize))
    }

    func place(field: CGRect) {
        self.field = field
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let shown = pills.filter { !$0.pill.isHidden }.map(\.pill)
        let layout = layout(field: field)
        for (pill, (frame, label)) in zip(shown, zip(layout.pills, layout.labels)) {
            pill.setLayoutFrame(frame)
            pill.labelFrame = label.offsetBy(dx: -frame.minX, dy: -frame.minY)
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        pills.contains { !$0.pill.isHidden && $0.pill.frame.insetBy(dx: -4, dy: -6).contains(point) }
    }
}

/// One pill: the header's glass, its value in the composer chip's type.
final class StemCellModelPill: UIControl {
    private let glass = HeaderGlassView()
    private let label = UILabel()
    var labelFrame: CGRect = .zero { didSet { setNeedsLayout() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        label.font = StemCellsFonts.ui(.medium, size: 13)
        label.textColor = UIColor(Palette.text)
        label.lineBreakMode = .byTruncatingTail
        addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(_ value: String, accessibility: String) {
        label.text = value
        accessibilityLabel = accessibility
    }

    var labelSize: CGSize {
        label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        label.frame = labelFrame
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }
}
#endif
