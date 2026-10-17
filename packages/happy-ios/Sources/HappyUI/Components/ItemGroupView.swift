#if canImport(UIKit)
import HappyLayout
import UIKit

/// UIKit asks a view for layout each time its safe area changes
/// (`-[UIView _setSafeAreaInsets:updateSubviewsDuringNextLayoutPass:]`
/// calls `setNeedsLayout` with the new insets already set). A list's
/// sections are given `contentInsetAdjustmentBehavior = .never`, so one
/// crossing the bars' edge gets new insets on every scroll frame. That is
/// not its content changing: a call that comes with insets not seen before
/// is the safe area's.
struct SafeAreaLayoutCalls {
    private var seen: UIEdgeInsets = .zero

    /// Whether this `setNeedsLayout` is the safe area's.
    mutating func isSafeAreaChange(_ insets: UIEdgeInsets) -> Bool {
        guard insets != seen else { return false }
        seen = insets
        return true
    }
}

/// ItemGroup.tsx's card: the rounded surface with a hairline border that
/// holds the rows. A row that changed asks its superview, the card, for
/// layout; the card passes that on (`onRowChange`), so its group measures
/// again.
final class GroupCardView: UIView {
    var onRowChange: (() -> Void)?
    private var safeAreaCalls = SafeAreaLayoutCalls()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.surface)
        layer.cornerRadius = ItemGroupLayout.Metrics.cardCornerRadius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateBorder()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func setNeedsLayout() {
        super.setNeedsLayout()
        if !safeAreaCalls.isSafeAreaChange(safeAreaInsets) { onRowChange?() }
    }

    private func updateBorder() {
        // CGColor does not follow appearance changes by itself.
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        layer.borderWidth = 1 / max(traitCollection.displayScale, 1)
    }
}

/// components/ItemGroup.tsx: header, rounded card of rows, footer. Rows are
/// any views that answer `sizeThatFits`; `ItemRowView`s get their dividers
/// switched on for all but the last.
///
/// The layout is kept per width (`WidthLayoutCache`): the list asking for
/// the group's size and the group then laying itself out measure once, and
/// a scroll measures nothing. It is measured again when the title, footer
/// or rows change, when a row asks the card for layout, when anything asks
/// the group for layout (its labels do when their text changes, Agents does
/// after patching a row), and when the text size changes
/// (`setNeedsLayoutUpTheTree` invalidates its intrinsic size). A row whose
/// height changes must say so through one of these, as `ItemRowView` and
/// `CodeBlockView` do.
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
    let card = GroupCardView()
    private var layouts = WidthLayoutCache<ItemGroupLayout>()
    /// Set while the group, or the list it is in, places views: a frame
    /// moving is not content changing.
    private var isPlacing = false
    private var safeAreaCalls = SafeAreaLayoutCalls()

    public init(title: String? = nil, footer: String? = nil, rows: [UIView]) {
        super.init(frame: .zero)
        addSubview(headerLabel)
        addSubview(card)
        addSubview(footerLabel)
        // Assignments in a class's own initializer skip didSet.
        self.title = title
        self.footer = footer
        self.rows = rows
        applyText()
        installRows(replacing: [])
        card.onRowChange = { [unowned self] in self.invalidate() }
        registerForTraitChanges([UITraitDisplayScale.self]) { (self: Self, _) in
            // Text boxes end on the screen's pixels.
            self.invalidate()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> ItemGroupLayout {
        // Measured with no access to the cache open: a label drawing for
        // the first time asks the group for layout, which invalidates it.
        WidthLayoutCache.layout(self, \.layouts, width: width) { width in
            #if DEBUG
            MeasureCounters.count("group.layout")
            #endif
            return ItemGroupLayout(.init(
                width: width,
                title: title == nil ? nil : headerLabel.measurable,
                footer: footer == nil ? nil : footerLabel.measurable,
                rows: rows.map(\.measurable),
                maxWidth: ContentWidth.maxWidth, // Tablet (HappyUI/Tablet): ItemGroup.tsx layout.maxWidth
                untitledPaddingTop: untitledPaddingTop,
                paddingBottom: paddingBottom
            ))
        }
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        isPlacing = true
        defer { isPlacing = false }
        if let frame = layout.header { headerLabel.setLayoutFrame(frame) }
        card.setLayoutFrame(layout.card)
        for (row, frame) in zip(rows, layout.rows) {
            row.setLayoutFrame(frame)
        }
        if let frame = layout.footer { footerLabel.setLayoutFrame(frame) }
    }

    public override func setNeedsLayout() {
        guard !safeAreaCalls.isSafeAreaChange(safeAreaInsets) else { return super.setNeedsLayout() }
        invalidate()
    }

    /// A new text size (`setNeedsLayoutUpTheTree`).
    public override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        if !placing { layouts.invalidate() }
    }

    private var placing: Bool {
        isPlacing || (superview as? GroupedListView)?.isPlacing == true
    }

    private func applyText() {
        headerLabel.string = title ?? ""
        headerLabel.isHidden = title == nil
        footerLabel.string = footer ?? ""
        footerLabel.isHidden = footer == nil
        invalidate()
    }

    /// Rows in both lists stay in the card, and a divider is set only where
    /// it changes, so a screen that patches a long group touches only the
    /// rows that came, went or moved to or from the end.
    private func installRows(replacing old: [UIView]) {
        let kept = Set(rows.map(ObjectIdentifier.init))
        for row in old where row.superview === card && !kept.contains(ObjectIdentifier(row)) {
            row.removeFromSuperview()
        }
        for (index, row) in rows.enumerated() {
            if row.superview !== card { card.addSubview(row) }
            if let item = row as? ItemRowView, item.showsDivider != (index < rows.count - 1) {
                item.showsDivider = index < rows.count - 1
            }
        }
        invalidate()
    }

    /// Measures again on the next pass, and tells the list that this
    /// section alone changed.
    private func invalidate() {
        super.setNeedsLayout()
        guard !placing else { return }
        layouts.invalidate()
        if let list = superview as? GroupedListView {
            list.sectionNeedsMeasure(self)
        } else {
            superview?.setNeedsLayout()
        }
    }
}

/// components/ItemList.tsx: a vertical scroll of sections on the grouped
/// background. It ignores UIKit's automatic insets and applies the safe area
/// through `GroupedListLayout`, so every frame comes from the pure layout.
///
/// Each section is measured once per width (`GroupedListCache`): a scroll
/// frame lays out nothing, a new width measures every section once, and
/// installing sections measures only the ones that weren't there. An
/// `ItemGroupView` that changed says so and is measured alone; anything
/// else asking the list for layout (a section of another kind, a new text
/// size) has every section measured again.
public final class GroupedListView: UIScrollView {
    public var sections: [UIView] = [] {
        didSet { installSections(replacing: oldValue) }
    }

    private var cache = GroupedListCache<ObjectIdentifier>()
    /// Set while the list places its sections.
    private(set) var isPlacing = false

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
    /// one group doesn't take the others off the window and back, or
    /// measure them again.
    private func installSections(replacing old: [UIView]) {
        let kept = Set(sections.map(ObjectIdentifier.init))
        for section in old where section.superview === self && !kept.contains(ObjectIdentifier(section)) {
            section.removeFromSuperview()
        }
        isPlacing = true
        for section in sections where section.superview !== self {
            addSubview(section)
            // One put back after it left may have changed meanwhile.
            cache.invalidate(ObjectIdentifier(section))
        }
        isPlacing = false
        super.setNeedsLayout()
    }

    /// `section` may be another height: measured again on the next pass,
    /// alone.
    func sectionNeedsMeasure(_ section: UIView) {
        cache.invalidate(ObjectIdentifier(section))
        super.setNeedsLayout()
    }

    public override func setNeedsLayout() {
        if !isPlacing { cache.invalidateAll() }
        super.setNeedsLayout()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let sections = sections
        // Measured with no access to the cache open: a section measured
        // may ask for layout, and so invalidate it (`GroupedListCache`).
        guard let layout = GroupedListCache.layout(
            self, \.cache,
            size: bounds.size,
            safeArea: LayoutInsets(safeAreaInsets),
            ids: sections.map(ObjectIdentifier.init),
            content: { sections[$0].measurable }
        ) else { return }
        #if DEBUG
        MeasureCounters.count("list.layout")
        #endif
        isPlacing = true
        defer { isPlacing = false }
        for (section, frame) in zip(self.sections, layout.sections) {
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
