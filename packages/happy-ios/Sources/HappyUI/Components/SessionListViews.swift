#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One session in the flat home list (components/FlatSessionRow.tsx). It
/// measures its labels and applies `FlatSessionRowLayout`.
final class SessionRowCell: UITableViewCell {
    static let reuseIdentifier = "session"

    let avatar = AvatarView()
    let titleLabel = ShimmerLabel(style: TextStyles.sessionTitle)
    let timestampLabel = StyledLabel(style: TextStyles.sessionTimestamp, color: Palette.textSecondary, lines: 1, alignment: .right)
    let dot = UIView()
    let projectLabel = StyledLabel(style: TextStyles.sessionProject, color: Palette.textSecondary, lines: 1)
    let workspaceLabel = StyledLabel(style: TextStyles.sessionWorkspace, color: Palette.textSecondary, lines: 1)
    let branchIcon = IconView(.ionicons("git-branch-outline"), size: FlatSessionRowLayout.Metrics.branchIconSize)
    let divider = UIView()
    private(set) var row: SessionRow?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(Palette.flatListBackground)
        let selected = UIView()
        selected.backgroundColor = UIColor(Palette.surfaceSelected)
        selectedBackgroundView = selected
        branchIcon.tintColor = UIColor(Palette.textSecondary)
        branchIcon.contentMode = .center
        divider.backgroundColor = UIColor(Palette.divider)
        for view in [avatar, titleLabel, timestampLabel, dot, projectLabel, workspaceLabel, branchIcon, divider] {
            contentView.addSubview(view)
        }
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ row: SessionRow, style: AvatarStyle, monochrome: Bool) {
        self.row = row
        avatar.content = .init(avatar: row.avatar, style: style, monochrome: monochrome || row.faded)
        avatar.alpha = row.faded ? 0.5 : 1
        for view in [titleLabel, timestampLabel, dot, projectLabel, workspaceLabel, branchIcon] as [UIView] {
            view.alpha = row.faded ? 0.6 : 1
        }
        titleLabel.string = row.title ?? Strings.Session.newChat
        titleLabel.color = row.faded ? Palette.textSecondary : Palette.text
        titleLabel.isShimmering = row.shimmersTitle
        timestampLabel.string = row.timestamp
        // The stamp keeps its width under a dot so the title never jumps.
        timestampLabel.isHidden = row.corner != .timestamp
        dot.isHidden = row.corner == .timestamp
        dot.backgroundColor = UIColor(row.corner == .blockedDot ? Palette.sessionBlockedDot : Palette.sessionReadyDot)
        projectLabel.string = row.projectName
        workspaceLabel.string = row.workspaceName ?? ""
        workspaceLabel.isHidden = row.workspaceName == nil
        branchIcon.isHidden = row.workspaceName == nil
        divider.isHidden = !row.showsDivider
        accessibilityLabel = [row.title ?? Strings.Session.newChat, cornerAccessibility(row), row.projectName, row.workspaceName, row.timestamp]
            .compactMap { $0 }
            .joined(separator: ", ")
        setNeedsLayout()
    }

    private func cornerAccessibility(_ row: SessionRow) -> String? {
        switch (row.corner, row.state) {
        case (.timestamp, _): nil
        case (_, .inputRequired): Strings.Status.inputRequired
        case (_, .permissionRequired): Strings.Status.permissionRequired
        default: Strings.Status.unread
        }
    }

    func layout(width: CGFloat) -> FlatSessionRowLayout {
        FlatSessionRowLayout(.init(
            width: width,
            title: titleLabel.measurable,
            timestamp: timestampLabel.measurable,
            project: projectLabel.measurable,
            workspace: row?.workspaceName == nil ? nil : workspaceLabel.measurable,
            branchIcon: branchIcon.sizeThatFits(.zero),
            showsDivider: row?.showsDivider ?? false
        ))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        avatar.setLayoutFrame(layout.avatar)
        titleLabel.setLayoutFrame(layout.title)
        timestampLabel.setLayoutFrame(layout.timestamp)
        dot.setLayoutFrame(layout.dot)
        dot.layer.cornerRadius = layout.dot.width / 2
        projectLabel.setLayoutFrame(layout.project)
        if let frame = layout.workspace { workspaceLabel.setLayoutFrame(frame) }
        if let frame = layout.branchIcon { branchIcon.setLayoutFrame(frame) }
        if let frame = layout.divider { divider.setLayoutFrame(frame) }
    }

    override func setHighlighted(_ highlighted: Bool, animated: Bool) {
        super.setHighlighted(highlighted, animated: animated)
        // UIKit clears subview backgrounds while highlighted; the dot keeps
        // its colour.
        if let row { dot.backgroundColor = UIColor(row.corner == .blockedDot ? Palette.sessionBlockedDot : Palette.sessionReadyDot) }
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        if let row { dot.backgroundColor = UIColor(row.corner == .blockedDot ? Palette.sessionBlockedDot : Palette.sessionReadyDot) }
    }
}

/// A title that shimmers while the agent works (ShimmerText): the base text
/// in the secondary colour with a band of the full text colour sweeping
/// across it.
final class ShimmerLabel: UIView {
    var string: String {
        get { base.string }
        set { base.string = newValue; highlight.string = newValue; setNeedsLayout() }
    }

    var color: ColorToken = Palette.text {
        didSet { applyColors() }
    }

    var isShimmering = false {
        didSet { if isShimmering != oldValue { applyColors(); updateAnimation() } }
    }

    private let base: StyledLabel
    private let highlight: StyledLabel
    private let band = CAGradientLayer()

    init(style: TextStyle) {
        base = StyledLabel(style: style, color: Palette.text, lines: 1)
        highlight = StyledLabel(style: style, color: Palette.text, lines: 1)
        super.init(frame: .zero)
        addSubview(base)
        addSubview(highlight)
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        band.colors = [UIColor.clear.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        band.locations = [0, 0.5, 1]
        highlight.layer.mask = band
        isUserInteractionEnabled = false
        applyColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        base.sizeThatFits(size)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        base.frame = bounds
        highlight.frame = bounds
        band.frame = CGRect(x: -bounds.width, y: 0, width: bounds.width, height: bounds.height)
        updateAnimation()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateAnimation()
    }

    private func applyColors() {
        base.color = isShimmering ? Palette.textSecondary : color
        highlight.isHidden = !isShimmering
    }

    private func updateAnimation() {
        band.removeAllAnimations()
        guard isShimmering, window != nil, bounds.width > 0 else { return }
        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = -bounds.width / 2
        sweep.toValue = bounds.width * 1.5
        sweep.duration = 1.6
        sweep.repeatCount = .infinity
        band.add(sweep, forKey: "shimmer")
    }
}

/// "Today", "Yesterday", "3 days ago" over archived rows.
final class SessionDayHeaderCell: UITableViewCell {
    static let reuseIdentifier = "day"

    let label = StyledLabel(style: TextStyles.sessionDayHeader, color: Palette.groupedSectionTitle, lines: 1)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(Palette.flatListBackground)
        selectionStyle = .none
        contentView.addSubview(label)
        label.accessibilityTraits = .header
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ age: SessionList.DayAge) {
        switch age {
        case .today: label.string = Strings.SessionHistory.today
        case .yesterday: label.string = Strings.SessionHistory.yesterday
        case .daysAgo(let count): label.string = Strings.SessionHistory.daysAgo(count)
        }
        setNeedsLayout()
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        SessionDayHeaderLayout(width: size.width, label: label.measurable).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.setLayoutFrame(SessionDayHeaderLayout(width: contentView.bounds.width, label: label.measurable).label)
    }
}

/// "── Show archived ──".
final class ArchiveToggleCell: UITableViewCell {
    static let reuseIdentifier = "archive"

    let label = StyledLabel(style: TextStyles.archiveToggle, color: Palette.textSecondary, lines: 1)
    let leading = UIView()
    let trailing = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(Palette.flatListBackground)
        selectionStyle = .none
        for line in [leading, trailing] {
            line.backgroundColor = UIColor(Palette.divider)
            contentView.addSubview(line)
        }
        contentView.addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(hidden: Bool) {
        label.string = hidden ? Strings.Sidebar.showArchived : Strings.Sidebar.hideArchived
        accessibilityLabel = label.string
        setNeedsLayout()
    }

    /// The flat list's toggle heads a band; the project list's divides
    /// the page.
    var banded = true {
        didSet { if banded != oldValue { setNeedsLayout() } }
    }

    private func layout(width: CGFloat) -> ArchiveToggleLayout {
        banded
            ? ArchiveToggleLayout(width: width, label: label.measurable)
            : ArchiveToggleLayout(
                width: width,
                label: label.measurable,
                paddingTop: ArchiveToggleLayout.unbanded.top,
                paddingBottom: ArchiveToggleLayout.unbanded.bottom
            )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        label.setLayoutFrame(layout.label)
        leading.setLayoutFrame(layout.leadingLine)
        trailing.setLayoutFrame(layout.trailingLine)
    }

    override func setHighlighted(_ highlighted: Bool, animated: Bool) {
        super.setHighlighted(highlighted, animated: animated)
        contentView.alpha = highlighted ? 0.5 : 1
    }
}

/// A text-only button (EmptyMainScreen.tsx `secondaryAction`).
public final class TextActionButton: UIControl {
    let label = StyledLabel(style: TextStyles.secondaryAction, color: Palette.textSecondary, lines: 1)
    public var onTap: (() -> Void)?

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
        TextActionLayout(width: size.width, label: label.measurable).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        label.setLayoutFrame(TextActionLayout(width: bounds.width, label: label.measurable).label)
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
    let icon = IconView(.ionicons("terminal-outline"), size: NoSessionsLayout.Metrics.iconSize)
    let titleLabel = StyledLabel(style: TextStyles.emptyStateTitle, color: Palette.text, alignment: .center)
    let descriptionLabel = StyledLabel(style: TextStyles.emptyStateDescription, color: Palette.textSecondary, alignment: .center)
    public let startNewSession = RoundButton(title: Strings.NewSession.startNewSession)
    public let showArchived = TextActionButton(title: Strings.Sidebar.showArchived)

    public var showsArchivedAction = false {
        didSet {
            showArchived.isHidden = !showsArchivedAction
            setNeedsLayout()
        }
    }

    public override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.groupedBackground)
        icon.tintColor = UIColor(Palette.textSecondary)
        icon.contentMode = .center
        titleLabel.string = Strings.EmptyMain.noSessionsTitle
        titleLabel.accessibilityTraits = .header
        descriptionLabel.string = Strings.EmptyMain.noSessionsDescription
        for view in [icon, titleLabel, descriptionLabel, startNewSession, showArchived] {
            addSubview(view)
        }
        showArchived.isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = NoSessionsLayout(.init(
            size: bounds.size,
            safeArea: LayoutInsets(safeAreaInsets),
            icon: icon.sizeThatFits(.zero),
            title: titleLabel.measurable,
            description: descriptionLabel.measurable,
            buttonHeight: startNewSession.layout(width: bounds.width).size.height,
            action: showsArchivedAction ? showArchived.measurable : nil
        ))
        icon.setLayoutFrame(layout.icon)
        titleLabel.setLayoutFrame(layout.title)
        descriptionLabel.setLayoutFrame(layout.description)
        if let frame = layout.button { startNewSession.setLayoutFrame(frame) }
        if let frame = layout.action { showArchived.setLayoutFrame(frame) }
    }
}
#endif
