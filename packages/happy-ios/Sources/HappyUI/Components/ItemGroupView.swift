#if canImport(UIKit)
import HappyLayout
import UIKit

/// components/ItemGroup.tsx: header, rounded card of rows, footer. Rows are
/// any views that answer `sizeThatFits`; `ItemRowView`s get their dividers
/// switched on for all but the last.
public final class ItemGroupView: UIView {
    public var title: String? {
        didSet { applyText() }
    }

    public var footer: String? {
        didSet { applyText() }
    }

    public var rows: [UIView] = [] {
        didSet { installRows(replacing: oldValue) }
    }

    /// `headerStyle` padding over an untitled card; nil keeps the default.
    public var untitledPaddingTop: CGFloat? {
        didSet { invalidate() }
    }

    /// `style.paddingBottom` under the group.
    public var paddingBottom: CGFloat = 0 {
        didSet { invalidate() }
    }

    let headerLabel = StyledLabel(style: TextStyles.groupHeader, color: Palette.groupedSectionTitle)
    let footerLabel = StyledLabel(style: TextStyles.groupFooter, color: Palette.groupedSectionTitle)
    let card = UIView()

    public init(title: String? = nil, footer: String? = nil, rows: [UIView]) {
        super.init(frame: .zero)
        card.backgroundColor = UIColor(Palette.surface)
        card.layer.cornerRadius = ItemGroupLayout.Metrics.cardCornerRadius
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        addSubview(headerLabel)
        addSubview(card)
        addSubview(footerLabel)
        // Assignments in a class's own initializer skip didSet.
        self.title = title
        self.footer = footer
        self.rows = rows
        applyText()
        installRows(replacing: [])
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateBorder()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> ItemGroupLayout {
        ItemGroupLayout(.init(
            width: width,
            title: title == nil ? nil : headerLabel.measurable,
            footer: footer == nil ? nil : footerLabel.measurable,
            rows: rows.map(\.measurable),
            maxWidth: ContentWidth.maxWidth, // Tablet (HappyUI/Tablet): ItemGroup.tsx layout.maxWidth
            untitledPaddingTop: untitledPaddingTop,
            paddingBottom: paddingBottom
        ))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        if let frame = layout.header { headerLabel.setLayoutFrame(frame) }
        card.setLayoutFrame(layout.card)
        for (row, frame) in zip(rows, layout.rows) {
            row.setLayoutFrame(frame)
        }
        if let frame = layout.footer { footerLabel.setLayoutFrame(frame) }
    }

    private func applyText() {
        headerLabel.string = title ?? ""
        headerLabel.isHidden = title == nil
        footerLabel.string = footer ?? ""
        footerLabel.isHidden = footer == nil
        invalidate()
    }

    private func installRows(replacing old: [UIView]) {
        for row in old where row.superview === card { row.removeFromSuperview() }
        for (index, row) in rows.enumerated() {
            card.addSubview(row)
            (row as? ItemRowView)?.showsDivider = index < rows.count - 1
        }
        invalidate()
    }

    private func updateBorder() {
        // CGColor does not follow appearance changes by itself.
        card.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        card.layer.borderWidth = 1 / max(traitCollection.displayScale, 1)
    }

    private func invalidate() {
        setNeedsLayout()
        superview?.setNeedsLayout()
    }
}

/// components/ItemList.tsx: a vertical scroll of sections on the grouped
/// background. It ignores UIKit's automatic insets and applies the safe area
/// through `GroupedListLayout`, so every frame comes from the pure layout.
public final class GroupedListView: UIScrollView {
    public var sections: [UIView] = [] {
        didSet { installSections(replacing: oldValue) }
    }

    public init(sections: [UIView] = []) {
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.groupedBackground)
        contentInsetAdjustmentBehavior = .never
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        // Assignments in a class's own initializer skip didSet.
        self.sections = sections
        installSections(replacing: [])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Sections in both lists stay where they are, so a screen that swaps
    /// one group doesn't take the others off the window and back.
    private func installSections(replacing old: [UIView]) {
        let kept = Set(sections.map(ObjectIdentifier.init))
        for section in old where section.superview === self && !kept.contains(ObjectIdentifier(section)) {
            section.removeFromSuperview()
        }
        for section in sections where section.superview !== self { addSubview(section) }
        setNeedsLayout()
    }

    public func layout() -> GroupedListLayout {
        GroupedListLayout(.init(size: bounds.size, safeArea: LayoutInsets(safeAreaInsets), sections: sections.map(\.measurable)))
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout()
        for (section, frame) in zip(sections, layout.sections) {
            section.setLayoutFrame(frame)
        }
        if contentSize != layout.contentSize {
            contentSize = layout.contentSize
        }
        let indicators = UIEdgeInsets(top: safeAreaInsets.top, left: 0, bottom: safeAreaInsets.bottom, right: 0)
        if verticalScrollIndicatorInsets != indicators {
            verticalScrollIndicatorInsets = indicators
        }
    }
}
#endif
