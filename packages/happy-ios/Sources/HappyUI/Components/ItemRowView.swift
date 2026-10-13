#if canImport(UIKit)
import HappyLayout
import UIKit

/// An SF Symbol in a row's 29pt icon slot.
public struct ItemIcon: Equatable {
    public var symbol: String
    public var tint: ColorToken

    public init(_ symbol: String, tint: ColorToken) {
        self.symbol = symbol
        self.tint = tint
    }
}

/// components/Item.tsx as a UIControl. It measures its labels and applies
/// `ItemRowLayout`; it has no layout rules of its own.
public final class ItemRowView: UIControl {
    public var title: String {
        get { titleLabel.string }
        set { titleLabel.string = newValue; invalidate() }
    }

    public var subtitle: String? {
        didSet {
            subtitleLabel.string = subtitle ?? ""
            subtitleLabel.isHidden = subtitle == nil
            // A subtitle caps the title at one line, as in Item.tsx.
            titleLabel.numberOfLines = subtitle == nil ? 2 : 1
            invalidate()
        }
    }

    public var detail: String? {
        didSet { detailLabel.string = detail ?? ""; detailLabel.isHidden = detail == nil; invalidate() }
    }

    public var icon: ItemIcon? {
        didSet { applyIcon(); invalidate() }
    }

    public var isDestructive = false {
        didSet { titleLabel.color = isDestructive ? Palette.textDestructive : Palette.text }
    }

    /// Shown only when the row is tappable, like happy-app.
    public var showsChevron = true {
        didSet { invalidate() }
    }

    /// Set by the group: every row but the last.
    public var showsDivider = false {
        didSet { dividerView.isHidden = !showsDivider; invalidate() }
    }

    public var onTap: (() -> Void)? {
        didSet { isUserInteractionEnabled = onTap != nil; invalidate() }
    }

    let titleLabel = StyledLabel(style: TextStyles.itemTitle, color: Palette.text, lines: 2)
    let subtitleLabel = StyledLabel(style: TextStyles.itemSubtitle, color: Palette.textSecondary, lines: 2)
    let detailLabel = StyledLabel(style: TextStyles.itemDetail, color: Palette.textSecondary, lines: 1)
    let iconView = UIImageView()
    let chevronView = UIImageView(image: .symbol("chevron.forward", pointSize: 14, weight: .semibold))
    let dividerView = UIView()

    public init(
        title: String,
        subtitle: String? = nil,
        detail: String? = nil,
        icon: ItemIcon? = nil,
        isDestructive: Bool = false,
        onTap: (() -> Void)? = nil
    ) {
        super.init(frame: .zero)
        iconView.contentMode = .center
        chevronView.tintColor = UIColor(Palette.groupedChevron)
        chevronView.contentMode = .center
        dividerView.backgroundColor = UIColor(Palette.itemDivider)
        dividerView.isHidden = true
        for view in [iconView, titleLabel, subtitleLabel, detailLabel, chevronView, dividerView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        isAccessibilityElement = true
        self.title = title
        self.subtitle = subtitle
        self.detail = detail
        self.icon = icon
        self.isDestructive = isDestructive
        self.onTap = onTap
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var showsAccessory: Bool {
        onTap != nil && showsChevron
    }

    /// The pure layout for this row's current content at `width`.
    public func layout(width: CGFloat) -> ItemRowLayout {
        ItemRowLayout(.init(
            width: width,
            hasIcon: icon != nil,
            title: titleLabel.measurable,
            subtitle: subtitle == nil ? nil : subtitleLabel.measurable,
            detail: detail == nil ? nil : detailLabel.measurable,
            accessory: showsAccessory ? chevronView.image?.size : nil,
            showsDivider: showsDivider
        ))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        iconView.isHidden = layout.icon == nil
        if let frame = layout.icon { iconView.setLayoutFrame(frame) }
        titleLabel.setLayoutFrame(layout.title)
        if let frame = layout.subtitle { subtitleLabel.setLayoutFrame(frame) }
        if let frame = layout.detail { detailLabel.setLayoutFrame(frame) }
        chevronView.isHidden = layout.accessory == nil
        if let frame = layout.accessory { chevronView.setLayoutFrame(frame) }
        if let frame = layout.divider { dividerView.setLayoutFrame(frame) }
    }

    public override var isHighlighted: Bool {
        didSet {
            backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : nil
        }
    }

    public override var accessibilityLabel: String? {
        get { [title, subtitle, detail].compactMap { $0 }.joined(separator: ", ") }
        set {}
    }

    public override var accessibilityTraits: UIAccessibilityTraits {
        get { onTap == nil ? .staticText : .button }
        set {}
    }

    private func applyIcon() {
        iconView.isHidden = icon == nil
        guard let icon else { return }
        iconView.image = .symbol(icon.symbol, pointSize: 22)
        iconView.tintColor = UIColor(icon.tint)
    }

    private func invalidate() {
        invalidateIntrinsicContentSize()
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    @objc private func tapped() {
        onTap?()
    }
}
#endif
