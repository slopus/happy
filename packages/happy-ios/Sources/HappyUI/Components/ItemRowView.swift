#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// What sits in a row's 29pt icon slot: one of happy-app's icons, or a
/// picture (a harness logo, a GitHub avatar).
public struct ItemIcon: Equatable {
    public enum Source: Equatable {
        /// One of happy-app's icons, centred in the slot as Item.tsx centres
        /// `<Ionicons size={29} />`.
        case glyph(Icon)
        /// An SF Symbol. Nothing in happy-app draws one; kept only so
        /// branches written before the icons landed still build.
        case symbol(String)
        /// An image in HappyUI's bundle.
        case bundled(String)
        case image(UIImage)
    }

    public var source: Source
    /// Template tint; nil draws a picture in its own colours.
    public var tint: ColorToken?
    /// Clips a picture to a circle (the GitHub avatar).
    public var round = false
    /// A glyph's RN `size`. Item.tsx rows use 29; a few screens pass 28
    /// (troubleshoot's computers, onboarding settings).
    public var size: CGFloat = ItemRowLayout.Metrics.iconSize

    public init(_ icon: Icon, tint: ColorToken, size: CGFloat = ItemRowLayout.Metrics.iconSize) {
        self.source = .glyph(icon)
        self.tint = tint
        self.size = size
    }

    @available(*, deprecated, message: "Name happy-app's icon: ItemIcon(.ionicons(\"…\"), tint:)")
    public init(_ symbol: String, tint: ColorToken) {
        self.source = .symbol(symbol)
        self.tint = tint
    }

    public init(_ source: Source, tint: ColorToken? = nil, round: Bool = false) {
        self.source = source
        self.tint = tint
        self.round = round
    }
}

/// components/Item.tsx as a UIControl. It measures its parts and applies
/// `ItemRowLayout`; it has no layout rules of its own.
public final class ItemRowView: UIControl {
    public var title: String {
        get { titleLabel.string }
        set { titleLabel.string = newValue; invalidate() }
    }

    public var subtitle: String? {
        didSet { apply() }
    }

    public var detail: String? {
        didSet { apply() }
    }

    public var icon: ItemIcon? {
        didSet { apply() }
    }

    public var isDestructive = false {
        didSet { apply() }
    }

    /// Shown only when the row is tappable and has no trailing view, like
    /// happy-app.
    public var showsChevron = true {
        didSet { apply() }
    }

    /// Item.tsx `rightElement`: a switch, checkmark or dropdown value. It
    /// replaces the chevron and hides the detail.
    public var trailingView: UIView? {
        didSet {
            if oldValue !== trailingView { oldValue?.removeFromSuperview() }
            if let trailingView { addSubview(trailingView) }
            apply()
        }
    }

    /// Item.tsx `loading`: a spinner, and taps are ignored.
    public var isLoading = false {
        didSet { apply() }
    }

    /// Set by the group: every row but the last.
    public var showsDivider = false {
        didSet { apply() }
    }

    public var onTap: (() -> Void)? {
        didSet { apply() }
    }

    /// Item.tsx's long press, which it uses to copy.
    public var onLongPress: (() -> Void)? {
        didSet { apply() }
    }

    let titleLabel = StyledLabel(style: TextStyles.itemTitle, color: Palette.text, lines: 2)
    let subtitleLabel = StyledLabel(style: TextStyles.itemSubtitle, color: Palette.textSecondary, lines: 2)
    let detailLabel = StyledLabel(style: TextStyles.itemDetail, color: Palette.textSecondary, lines: 1)
    /// Pictures. Glyphs draw in `glyphView`, which centres them on RN's
    /// pixels.
    let iconView = UIImageView()
    let glyphView = IconView(size: ItemRowLayout.Metrics.iconSize)
    /// Item.tsx: `<Ionicons name="chevron-forward" size={17} />` on iOS.
    let chevronView = IconView(.ionicons("chevron-forward"), size: 17)
    let spinner = UIActivityIndicatorView(style: .medium)
    let dividerView = UIView()
    private lazy var longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))

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
        iconView.clipsToBounds = true
        chevronView.tintColor = UIColor(Palette.groupedChevron)
        spinner.color = UIColor(Palette.textSecondary)
        dividerView.backgroundColor = UIColor(Palette.itemDivider)
        dividerView.isHidden = true
        for view in [iconView, glyphView, titleLabel, subtitleLabel, detailLabel, chevronView, spinner, dividerView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        addGestureRecognizer(longPress)
        isAccessibilityElement = true
        self.title = title
        // Assignments in a class's own initializer skip didSet, so apply()
        // runs by hand once everything is set.
        self.subtitle = subtitle
        self.detail = detail
        self.icon = icon
        self.isDestructive = isDestructive
        self.onTap = onTap
        apply()
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var isInteractive: Bool {
        onTap != nil || onLongPress != nil
    }

    private var showsAccessory: Bool {
        isInteractive && showsChevron && trailingView == nil
    }

    /// The spinner while loading, otherwise the trailing view.
    private var trailingSize: CGSize? {
        if isLoading { return spinner.intrinsicContentSize }
        return trailingView?.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    /// The pure layout for this row's current content at `width`.
    public func layout(width: CGFloat) -> ItemRowLayout {
        ItemRowLayout(.init(
            width: width,
            hasIcon: icon != nil,
            title: titleLabel.measurable,
            subtitle: subtitle == nil ? nil : subtitleLabel.measurable,
            detail: detail == nil || trailingView != nil ? nil : detailLabel.measurable,
            trailing: trailingSize,
            accessory: showsAccessory ? chevronView.sizeThatFits(.zero) : nil,
            showsDivider: showsDivider
        ))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        if let frame = layout.icon {
            iconView.setLayoutFrame(frame)
            glyphView.setLayoutFrame(frame)
            iconView.layer.cornerRadius = icon?.round == true ? frame.width / 2 : 0
        }
        titleLabel.setLayoutFrame(layout.title)
        if let frame = layout.subtitle { subtitleLabel.setLayoutFrame(frame) }
        detailLabel.isHidden = layout.detail == nil
        if let frame = layout.detail { detailLabel.setLayoutFrame(frame) }
        if let frame = layout.trailing {
            (isLoading ? spinner : trailingView)?.setLayoutFrame(frame)
        }
        chevronView.isHidden = layout.accessory == nil
        if let frame = layout.accessory { chevronView.setLayoutFrame(IconLayout.textFrame(frame, scale: layoutScale)) }
        if let frame = layout.divider { dividerView.setLayoutFrame(frame) }
    }

    public override var isHighlighted: Bool {
        didSet {
            backgroundColor = isHighlighted && onTap != nil ? UIColor(Palette.surfacePressedOverlay) : nil
        }
    }

    public override var accessibilityLabel: String? {
        get { [title, subtitle, trailingView == nil ? detail : nil].compactMap { $0 }.joined(separator: ", ") }
        set {}
    }

    public override var accessibilityValue: String? {
        get { (trailingView as? UISwitch).map { $0.isOn ? "1" : "0" } ?? trailingView?.accessibilityLabel }
        set {}
    }

    public override var accessibilityTraits: UIAccessibilityTraits {
        get { onTap == nil && !(trailingView is UISwitch) ? .staticText : .button }
        set {}
    }

    public override func accessibilityActivate() -> Bool {
        if let toggle = trailingView as? UISwitch, onTap == nil {
            toggle.setOn(!toggle.isOn, animated: true)
            toggle.sendActions(for: .valueChanged)
            return true
        }
        return super.accessibilityActivate()
    }

    /// Brings every subview in line with the properties above.
    private func apply() {
        subtitleLabel.string = subtitle ?? ""
        subtitleLabel.isHidden = subtitle == nil
        // Item.tsx: two lines, unless the subtitle sets its own breaks.
        subtitleLabel.numberOfLines = subtitle?.contains("\n") == true ? 0 : 2
        // A subtitle caps the title at one line.
        titleLabel.numberOfLines = subtitle == nil ? 2 : 1
        titleLabel.color = isDestructive ? Palette.textDestructive : Palette.text
        detailLabel.string = detail ?? ""
        // As `layout(width:)` decides: no detail, or a trailing view in its
        // place. Set here too, so a row shows it before its first layout.
        detailLabel.isHidden = detail == nil || trailingView != nil
        var isGlyph = false
        if let icon {
            switch icon.source {
            case .glyph(let glyph):
                glyphView.icon = glyph
                glyphView.size = icon.size
                isGlyph = true
            case .symbol(let name):
                iconView.image = .symbol(name, pointSize: 22)
                iconView.contentMode = .center
            case .bundled(let name):
                let image = UIImage.happy(name)
                iconView.image = icon.tint == nil ? image : image?.withRenderingMode(.alwaysTemplate)
                iconView.contentMode = .scaleAspectFit
            case .image(let image):
                iconView.image = image
                iconView.contentMode = .scaleAspectFill
            }
            iconView.tintColor = icon.tint.map(UIColor.init)
            glyphView.tintColor = icon.tint.map(UIColor.init)
        }
        iconView.isHidden = icon == nil || isGlyph
        glyphView.isHidden = !isGlyph
        if !isGlyph { glyphView.icon = nil }
        spinner.isHidden = !isLoading
        if isLoading { spinner.startAnimating() } else { spinner.stopAnimating() }
        trailingView?.isHidden = isLoading
        dividerView.isHidden = !showsDivider
        // A trailing control (a switch) still needs touches when the row
        // itself does nothing.
        isUserInteractionEnabled = isInteractive || trailingView != nil
        isEnabled = !isLoading
        longPress.isEnabled = onLongPress != nil
        invalidate()
    }

    private func invalidate() {
        invalidateIntrinsicContentSize()
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    @objc private func tapped() {
        onTap?()
    }

    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        onLongPress?()
    }
}

extension ItemRowView {
    /// A row with a switch, the way appearance.tsx builds most of its rows.
    /// The switch changes on its own; `onChange` hears about it.
    public static func toggle(
        title: String,
        subtitle: String? = nil,
        icon: ItemIcon? = nil,
        isOn: Bool,
        onChange: @escaping (Bool) -> Void
    ) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: subtitle, icon: icon)
        let toggle = ActionSwitch(onChange: onChange)
        toggle.isOn = isOn
        toggle.onTintColor = UIColor(Palette.switchOn)
        row.trailingView = toggle
        return row
    }

    /// A tappable row whose trailing slot shows a checkmark when selected
    /// (settings/language.tsx and agents.tsx).
    public static func choice(
        title: String,
        subtitle: String? = nil,
        icon: ItemIcon? = nil,
        selected: Bool,
        checkTint: ColorToken = Palette.iconBlue,
        onTap: @escaping () -> Void
    ) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: subtitle, icon: icon, onTap: onTap)
        row.showsChevron = false
        if selected {
            // language.tsx and agents.tsx: `<Ionicons name="checkmark" size={20} />`.
            let check = IconView(.ionicons("checkmark"), size: 20, tint: checkTint)
            check.accessibilityLabel = "selected"
            row.trailingView = check
        }
        return row
    }
}

/// A UISwitch that reports changes through a closure.
final class ActionSwitch: UISwitch {
    private let onChange: (Bool) -> Void

    init(onChange: @escaping (Bool) -> Void) {
        self.onChange = onChange
        super.init(frame: .zero)
        addTarget(self, action: #selector(changed), for: .valueChanged)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @objc private func changed() {
        onChange(isOn)
    }
}
#endif
