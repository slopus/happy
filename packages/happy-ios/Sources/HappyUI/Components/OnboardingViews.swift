#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// Draws the "Happy / Engineering" wordmark from its vector outlines.
public final class WordmarkView: UIView {
    public override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityLabel = "Happy Engineering"
        accessibilityTraits = .image
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsDisplay()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override var intrinsicContentSize: CGSize {
        WordmarkMetrics.size()
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        WordmarkMetrics.size()
    }

    public override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        for layer in Wordmark.graphic.fitted(into: bounds) {
            context.addPath(layer.path.cgPath)
            context.setFillColor(UIColor(layer.color).resolvedColor(with: traitCollection).cgColor)
            context.fillPath()
        }
    }
}

extension VectorPath {
    var cgPath: CGPath {
        let path = CGMutablePath()
        for element in elements {
            switch element {
            case .move(let point): path.move(to: point)
            case .line(let point): path.addLine(to: point)
            case .quadCurve(let to, let control): path.addQuadCurve(to: to, control: control)
            case .curve(let to, let control1, let control2): path.addCurve(to: to, control1: control1, control2: control2)
            case .close: path.closeSubpath()
            }
        }
        return path
    }
}

/// The Get help pill in the bottom-right corner of the first-run screens.
public final class GetHelpButton: UIControl {
    let iconView = IconView(.ionicons("help-circle-outline"), size: GetHelpButtonLayout.Metrics.iconSize)
    let label = StyledLabel(style: TextStyles.getHelp, color: Palette.textSecondary, lines: 1)
    public var onTap: (() -> Void)?

    public override init(frame: CGRect) {
        super.init(frame: frame)
        label.string = Strings.Onboarding.getHelp
        iconView.tintColor = UIColor(Palette.textSecondary)
        for view in [iconView, label] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        layer.cornerRadius = GetHelpButtonLayout.Metrics.cornerRadius
        isAccessibilityElement = true
        accessibilityLabel = Strings.Onboarding.getHelp
        accessibilityTraits = .button
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public var layout: GetHelpButtonLayout {
        GetHelpButtonLayout(label: label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout.size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        iconView.setLayoutFrame(layout.icon)
        label.setLayoutFrame(layout.label)
    }

    public override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : nil }
    }

    public override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let slop = GetHelpButtonLayout.Metrics.hitSlop
        return bounds.insetBy(dx: -slop, dy: -slop).contains(point)
    }

    @objc private func tapped() {
        onTap?()
    }
}

/// A two-line navigation title: an optional title over the custom server's
/// host, like OnboardingHeader.
public final class NavigationTitleView: UIView {
    let titleLabel = StyledLabel(style: TextStyles.headerTitle, color: Palette.headerTint, lines: 1, alignment: .center)
    let subtitleLabel = StyledLabel(style: TextStyles.headerSubtitle, color: Palette.textSecondary, lines: 1, alignment: .center)

    public var title: String? {
        didSet { apply() }
    }

    public var subtitle: String? {
        didSet { apply() }
    }

    public init(title: String? = nil, subtitle: String? = nil) {
        super.init(frame: .zero)
        subtitleLabel.lineBreakMode = .byTruncatingMiddle
        addSubview(titleLabel)
        addSubview(subtitleLabel)
        // Assignments in a class's own initializer skip didSet.
        self.title = title
        self.subtitle = subtitle
        apply()
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.fitTextSize()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The text size the view was last fitted to; nil at the designed size.
    private var textScale: TextScale?

    /// A bar sizes its title view by its frame: fit it again to text drawn
    /// at a new size (OnboardingHeader's and Header.tsx's titles scale, in a
    /// header that keeps its height).
    private func fitTextSize() {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return }
        textScale = scale
        titleLabel.updateTraitsIfNeeded()
        subtitleLabel.updateTraitsIfNeeded()
        invalidateIntrinsicContentSize()
        frame.size = layout(maxWidth: Self.defaultMaxWidth).size
        superview?.setNeedsLayout()
    }

    /// The bar's title slot is about this wide on a phone.
    static let defaultMaxWidth: CGFloat = 240

    public func layout(maxWidth: CGFloat) -> NavigationTitleLayout {
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        return NavigationTitleLayout(
            title: title == nil ? nil : titleLabel.sizeThatFits(unbounded),
            subtitle: subtitle == nil ? nil : subtitleLabel.sizeThatFits(unbounded),
            maxWidth: maxWidth
        )
    }

    public override var intrinsicContentSize: CGSize {
        layout(maxWidth: Self.defaultMaxWidth).size
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(maxWidth: size.width > 0 ? size.width : Self.defaultMaxWidth).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(maxWidth: bounds.width)
        // The bar may give a wider frame; centre the computed block in it.
        let dx = (bounds.width - layout.size.width) / 2
        let dy = (bounds.height - layout.size.height) / 2
        if let frame = layout.title { titleLabel.setLayoutFrame(frame.offsetBy(dx: dx, dy: dy)) }
        if let frame = layout.subtitle { subtitleLabel.setLayoutFrame(frame.offsetBy(dx: dx, dy: dy)) }
    }

    private func apply() {
        titleLabel.string = title ?? ""
        titleLabel.isHidden = title == nil
        subtitleLabel.string = subtitle ?? ""
        subtitleLabel.isHidden = subtitle == nil
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }
}

/// OnboardingScreen.tsx: content, a large primary button and a text action
/// in a centred block, Get help in the corner. Both slots reserve the height
/// of every alternative they can show, so the buttons sit at the same place
/// on Welcome and Link Your Computer.
public final class OnboardingScreenView: UIView {
    public let scrollView = UIScrollView()
    public let content: UIView
    public let primary: RoundButton
    public let secondary: RoundButton
    /// A second text action under the first (the link sheet's relay).
    public let tertiary: RoundButton?
    public let help = GetHelpButton()
    /// Room for a control just above the primary button, as wide as it;
    /// whoever holds the control places it in `accessoryFrame`.
    public var accessoryHeight: CGFloat? {
        didSet { if accessoryHeight != oldValue { setNeedsLayout() } }
    }
    /// Each layout, for whoever places the accessory.
    public var onLayout: (() -> Void)?
    /// Where the accessory goes, in this view's coordinates as it scrolls:
    /// from the last layout, so a scroll measures nothing.
    public var accessoryFrame: CGRect? {
        laidAccessory.map { scrollView.convert($0, to: self) }
    }
    private var laidAccessory: CGRect?
    /// Offscreen copies measured for the reservation; never shown.
    private var reservedContent: [UIView]
    private let reservedSecondary: [RoundButton]

    public init(content: UIView, primary: RoundButton, secondary: RoundButton, tertiary: RoundButton? = nil) {
        self.content = content
        self.primary = primary
        self.secondary = secondary
        self.tertiary = tertiary
        reservedContent = [WelcomeContentView(), LinkComputerContentView()]
        reservedSecondary = OnboardingScreenView.secondaryTitles.map {
            RoundButton(title: $0, size: .normal, display: .inverted)
        }
        super.init(frame: .zero)
        // In the tree but hidden, so they are measured at the text size the
        // shown ones are drawn at, as RN's hidden copies are.
        for view in reservedContent + reservedSecondary {
            view.isHidden = true
            addSubview(view)
        }
        backgroundColor = UIColor(Palette.groupedBackground)
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.alwaysBounceVertical = false
        scrollView.keyboardDismissMode = .interactive
        addSubview(scrollView)
        for view in [content, primary, secondary] + [tertiary].compactMap({ $0 }) {
            scrollView.addSubview(view)
        }
        addSubview(help)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Holds room for `view` too: screens that take turns in one place
    /// (the link sheet's Relay and Direct) keep their buttons where they are.
    public func reserve(_ view: UIView) {
        view.isHidden = true
        insertSubview(view, at: 0)
        reservedContent.append(view)
        setNeedsLayout()
    }

    /// Every secondary label the template can show.
    static let secondaryTitles = [
        Strings.Onboarding.restoreExisting,
        Strings.Onboarding.createAccount,
        Strings.Onboarding.pasteLink,
    ]

    /// Liquid glass buttons, under a glass bar: the primary prominent, the
    /// text actions regular glass pills.
    public var usesGlass = false {
        didSet {
            guard usesGlass != oldValue else { return }
            primary.glass = usesGlass ? .prominent : nil
            for button in [secondary] + [tertiary].compactMap({ $0 }) { button.glass = usesGlass ? .regular : nil }
            setNeedsLayout()
        }
    }

    public func layout() -> OnboardingLayout {
        var input = OnboardingLayout.Input(
            size: bounds.size,
            safeArea: LayoutInsets(safeAreaInsets),
            content: .largest(of: ([content] + reservedContent).map(\.measurable)),
            primary: primary.measurable,
            secondary: .largest(of: ([secondary] + reservedSecondary).map(\.measurable)),
            tertiary: tertiary?.measurable,
            help: help.layout.size
        )
        input.glass = usesGlass
        input.accessory = accessoryHeight
        return OnboardingLayout(input)
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout()
        scrollView.setLayoutFrame(layout.scroll)
        if scrollView.contentSize != layout.contentSize {
            scrollView.contentSize = layout.contentSize
        }
        content.setLayoutFrame(layout.content)
        primary.setLayoutFrame(layout.primary)
        secondary.setLayoutFrame(layout.secondary)
        if let tertiary, let frame = layout.tertiary { tertiary.setLayoutFrame(frame) }
        help.setLayoutFrame(layout.help)
        laidAccessory = layout.accessory
        onLayout?()
    }
}

/// Welcome: wordmark, headline, value props.
public final class WelcomeContentView: UIView {
    let wordmark = WordmarkView()
    let titleLabel = StyledLabel(style: TextStyles.onboardingTitle, color: Palette.text)
    let propLabels: [StyledLabel]

    public override init(frame: CGRect) {
        propLabels = [Strings.Onboarding.propEncrypted, Strings.Onboarding.propNoPassword, Strings.Onboarding.propOpenSource].map {
            let label = StyledLabel(style: TextStyles.onboardingProp, color: Palette.textSecondary)
            label.string = $0
            return label
        }
        super.init(frame: frame)
        titleLabel.string = Strings.Onboarding.headline
        titleLabel.accessibilityTraits = .header
        addSubview(wordmark)
        addSubview(titleLabel)
        propLabels.forEach(addSubview)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> WelcomeContentLayout {
        WelcomeContentLayout(width: width, title: titleLabel.measurable, props: propLabels.map(\.measurable))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        wordmark.setLayoutFrame(layout.wordmark)
        titleLabel.setLayoutFrame(layout.title)
        for (label, frame) in zip(propLabels, layout.props) {
            label.setLayoutFrame(frame)
        }
    }
}

/// Link Your Computer: the two-step checklist and a reserved error line.
public final class LinkComputerContentView: UIView {
    public enum Step: CaseIterable {
        case install
        case open
    }

    public var ticked: Set<Step> = [] {
        didSet { updateBoxes() }
    }

    public var error: String? {
        didSet { errorLabel.string = error ?? "" }
    }

    public var isEnabled = true {
        didSet { heads.forEach { $0.isEnabled = isEnabled } }
    }

    public var onOpenWebsite: (() -> Void)?
    /// A box was ticked or unticked by hand.
    public var onToggle: ((Set<Step>) -> Void)?

    let titleLabel = StyledLabel(style: TextStyles.onboardingTitle, color: Palette.text)
    let heads: [UIControl] = Step.allCases.map { _ in UIControl() }
    let boxes: [IconView] = Step.allCases.map { _ in IconView(size: ChecklistRowLayout.Metrics.boxSize) }
    let rowTitles: [StyledLabel] = Step.allCases.map { _ in StyledLabel(style: TextStyles.checklistTitle, color: Palette.text) }
    let bodies: [StyledLabel] = Step.allCases.map { _ in StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary) }
    let errorLabel = StyledLabel(style: TextStyles.onboardingError, color: Palette.warningCritical, lines: 1, alignment: .center)

    public override init(frame: CGRect) {
        super.init(frame: frame)
        titleLabel.string = Strings.Onboarding.linkTitle
        titleLabel.accessibilityTraits = .header
        rowTitles[0].string = Strings.Onboarding.installStep
        rowTitles[1].string = Strings.Onboarding.openStep
        bodies[0].string = Strings.Onboarding.installBodyPrefix + Strings.Onboarding.installBodyLink + Strings.Onboarding.installBodySuffix
        bodies[1].string = Strings.Onboarding.openBody
        bodies[0].decoration = { text in
            let range = (text.string as NSString).range(of: Strings.Onboarding.installBodyLink)
            guard range.location != NSNotFound else { return }
            text.addAttributes([
                .underlineStyle: NSUnderlineStyle.single.rawValue,
                .foregroundColor: UIColor(Palette.text),
            ], range: range)
        }
        addSubview(titleLabel)
        for index in Step.allCases.indices {
            let head = heads[index]
            head.addTarget(self, action: #selector(toggle(_:)), for: .touchUpInside)
            head.isAccessibilityElement = true
            head.accessibilityLabel = rowTitles[index].string
            boxes[index].isUserInteractionEnabled = false
            rowTitles[index].isUserInteractionEnabled = false
            addSubview(head)
            addSubview(boxes[index])
            addSubview(rowTitles[index])
            addSubview(bodies[index])
        }
        bodies[0].isUserInteractionEnabled = true
        bodies[0].addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openWebsite)))
        addSubview(errorLabel)
        updateBoxes()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> LinkComputerContentLayout {
        LinkComputerContentLayout(
            width: width,
            title: titleLabel.measurable,
            rows: Step.allCases.indices.map { .init(title: rowTitles[$0].measurable, body: bodies[$0].measurable) },
            errorLineHeight: errorLabel.lineHeight
        )
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        titleLabel.setLayoutFrame(layout.title)
        for (index, frames) in layout.rows.enumerated() {
            heads[index].setLayoutFrame(frames.head)
            boxes[index].setLayoutFrame(frames.box)
            rowTitles[index].setLayoutFrame(frames.title)
            if let frame = frames.body { bodies[index].setLayoutFrame(frame) }
        }
        errorLabel.setLayoutFrame(layout.error)
    }

    private func updateBoxes() {
        for (index, step) in Step.allCases.enumerated() {
            let checked = ticked.contains(step)
            boxes[index].showChecklistBox(checked: checked)
            heads[index].accessibilityTraits = checked ? [.button, .selected] : .button
        }
    }

    @objc private func toggle(_ sender: UIControl) {
        guard let index = heads.firstIndex(of: sender) else { return }
        let step = Step.allCases[index]
        if ticked.contains(step) { ticked.remove(step) } else { ticked.insert(step) }
        onToggle?(ticked)
    }

    @objc private func openWebsite() {
        onOpenWebsite?()
    }
}

extension IconView {
    /// OnboardingContent.tsx's ChecklistRow box: a 26pt green
    /// checkmark-circle, or an empty ellipse-outline.
    func showChecklistBox(checked: Bool) {
        icon = .ionicons(checked ? "checkmark-circle" : "ellipse-outline")
        tintColor = UIColor(checked ? Palette.success : Palette.textSecondary)
    }
}
#endif
