#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A text-only button (EmptyMainScreen.tsx `secondaryAction`).
public final class TextActionButton: UIControl {
    /// The label's style and lines, for whoever measures it elsewhere.
    nonisolated static let labelText = (style: TextStyles.secondaryAction, lines: 1, alignment: NSTextAlignment.natural)

    let label = StyledLabel(style: labelText.style, color: Palette.textSecondary, lines: labelText.lines, alignment: labelText.alignment)
    public var onTap: (() -> Void)?

    /// The label's size, measured off the main thread for the width the
    /// action is laid out at, so laying it out measures nothing. Nil: the
    /// label is measured here, as it is drawn.
    var measuredLabelSize: CGSize? {
        didSet { if measuredLabelSize != oldValue { setNeedsLayout() } }
    }

    private var labelMeasurable: Measurable {
        measuredLabelSize.map(Measurable.fixed) ?? label.measurable
    }

    public init(title: String) {
        super.init(frame: .zero)
        label.string = title
        label.isUserInteractionEnabled = false
        addSubview(label)
        layer.cornerRadius = TextActionLayout.Metrics.cornerRadius
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .button
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        TextActionLayout(width: size.width, label: labelMeasurable).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        label.setLayoutFrame(TextActionLayout(width: bounds.width, label: labelMeasurable).label)
    }

    public override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : nil }
    }

    @objc private func tapped() {
        onTap?()
    }
}

/// EmptyMainScreen.tsx with a computer linked and nothing run on it yet:
/// "Start New Session", and the archive link when there is an archive.
public final class NoSessionsView: UIView {
    /// The title's and the description's style, lines and alignment, for
    /// the labels and for `NoSessionsMeasure`.
    nonisolated static let titleText = (style: TextStyles.emptyStateTitle, lines: 0, alignment: NSTextAlignment.center)
    nonisolated static let descriptionText = (style: TextStyles.emptyStateDescription, lines: 0, alignment: NSTextAlignment.center)

    /// Scrolls only when the content is taller than the safe area
    /// (`NoSessionsLayout.contentHeight`).
    let scrollView = UIScrollView()
    let icon = IconView(.ionicons("terminal-outline"), size: NoSessionsLayout.Metrics.iconSize)
    let titleLabel = StyledLabel(style: titleText.style, color: Palette.text, lines: titleText.lines, alignment: titleText.alignment)
    let descriptionLabel = StyledLabel(
        style: descriptionText.style,
        color: Palette.textSecondary,
        lines: descriptionText.lines,
        alignment: descriptionText.alignment
    )
    public let startNewSession = RoundButton(title: Strings.NewSession.startNewSession)
    public let showArchived = TextActionButton(title: Strings.Sidebar.showArchived)

    public var showsArchivedAction = false {
        didSet { if showsArchivedAction != oldValue { setNeedsLayout() } }
    }

    /// A picture drawn in the glyph's place, the same box, so the
    /// layout is unchanged: home's notice puts a `StateSceneView` here.
    var artwork: UIView? {
        didSet {
            guard artwork !== oldValue else { return }
            oldValue?.removeFromSuperview()
            if let artwork { scrollView.addSubview(artwork) }
            icon.isHidden = artwork != nil
            setNeedsLayout()
        }
    }

    /// The button as wide as its label and centred (`NoSessionsLayout`'s
    /// `buttonLabelWidth`), rather than across the screen.
    var fitsButtonToLabel = false {
        didSet { if fitsButtonToLabel != oldValue { setNeedsLayout() } }
    }

    /// What was asked to be measured last, and what was measured for it
    /// and applied. Laying out uses only what was applied.
    private(set) var requested: NoSessionsMeasureInput?
    private(set) var applied: NoSessionsSizes?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) lazy var measuring = ApplyPipeline<NoSessionsMeasureInput?, NoSessionsMeasureInput?, NoSessionsSizes>(
        input: nil,
        state: nil,
        derive: { input, applied in
            guard let input, input != applied else { return nil }
            return (NoSessionsMeasure.sizes(input), input)
        },
        apply: { [weak self] sizes in self?.apply(sizes) ?? false }
    )

    public override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.groupedBackground)
        // The content is placed in the safe area by its layout.
        scrollView.contentInsetAdjustmentBehavior = .never
        // The indicator insets set below are all of them; UIKit would add the safe area again.
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        scrollView.alwaysBounceVertical = false
        // Nothing to show until the first sizes are in.
        scrollView.isHidden = true
        addSubview(scrollView)
        icon.tintColor = UIColor(Palette.textSecondary)
        icon.contentMode = .center
        titleLabel.string = Strings.EmptyMain.noSessionsTitle
        titleLabel.accessibilityTraits = .header
        descriptionLabel.string = Strings.EmptyMain.noSessionsDescription
        for view in [icon, titleLabel, descriptionLabel, startNewSession, showArchived] {
            scrollView.addSubview(view)
        }
        showArchived.isHidden = true
        // The buttons never measure their labels here: until the sizes are
        // in they lay out an empty label, hidden.
        startNewSession.measuredLabelSize = .zero
        showArchived.measuredLabelSize = .zero
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self], action: #selector(traitsChanged))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @objc private func traitsChanged() {
        setNeedsLayout()
    }

    /// What this view's content is measured from now. Reads, no measuring.
    private var measureInput: NoSessionsMeasureInput {
        var text = TextEnvironment(traitCollection)
        // As its labels draw it: at the designed size unless the screen follows.
        if !traitCollection[FollowsTextSize.self] { text.scale = .standard }
        return NoSessionsMeasureInput(
            title: titleLabel.string,
            description: descriptionLabel.string,
            button: startNewSession.title,
            action: showArchived.label.string,
            width: max(0, bounds.width - LayoutInsets(safeAreaInsets).horizontal),
            text: text,
            showsArchived: showsArchivedAction
        )
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds
        let input = measureInput
        // Not yet given a size: nothing worth measuring.
        if input != requested, bounds.width > 0 {
            requested = input
            measuring.update { $0 = input }
        }
        // Until the first sizes are in there is nothing to place; after a
        // change, the last ones stay in place until the new ones are.
        guard let sizes = applied else { return }
        let insets = LayoutInsets(safeAreaInsets)
        let layout = NoSessionsLayout(.init(
            size: bounds.size,
            safeArea: insets,
            icon: sizes.icon,
            title: .fixed(sizes.title),
            description: .fixed(sizes.description),
            buttonHeight: sizes.buttonHeight,
            buttonLabelWidth: fitsButtonToLabel ? sizes.buttonLabel.width : nil,
            action: sizes.action.map(Measurable.fixed)
        ))
        scrollView.isHidden = false
        scrollView.contentSize = CGSize(width: bounds.width, height: layout.contentHeight)
        scrollView.verticalScrollIndicatorInsets = UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0)
        // Shorter content can't stay scrolled past its end.
        let end = max(0, layout.contentHeight - bounds.height)
        if scrollView.contentOffset.y > end { scrollView.contentOffset.y = end }
        icon.setLayoutFrame(layout.icon)
        artwork?.setLayoutFrame(layout.icon)
        titleLabel.setLayoutFrame(layout.title)
        descriptionLabel.setLayoutFrame(layout.description)
        if let frame = layout.button { startNewSession.setLayoutFrame(frame) }
        showArchived.isHidden = layout.action == nil
        if let frame = layout.action { showArchived.setLayoutFrame(frame) }
    }

    /// Takes sizes measured for what this view shows now, and refuses any
    /// measured for something else: an earlier width, text size, scale or
    /// archive action.
    func apply(_ sizes: NoSessionsSizes) -> Bool {
        guard sizes.input == requested else { return false }
        applied = sizes
        startNewSession.measuredLabelSize = sizes.buttonLabel
        showArchived.measuredLabelSize = sizes.actionLabel ?? .zero
        setNeedsLayout()
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume() }
        return true
    }

    /// Returns once the sizes for the input asked for last are applied
    /// (tests). Lay the view out first.
    func measured() async {
        guard requested != nil, applied?.input != requested else { return }
        await withCheckedContinuation { waiters.append($0) }
        if applied?.input != requested { await measured() }
    }
}
#endif
