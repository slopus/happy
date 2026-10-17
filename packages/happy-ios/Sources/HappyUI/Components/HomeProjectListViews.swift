#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A project-list cell whose press highlight fades rather than flips
/// (ProjectHomeList.tsx `RowPressable`): up in 70ms, gone over 240ms.
class ProjectListCell: UITableViewCell {
    let highlight = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        highlight.backgroundColor = UIColor(Palette.surfacePressed)
        highlight.alpha = 0
        highlight.isUserInteractionEnabled = false
        contentView.addSubview(highlight)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The pressable area: the whole cell, or the card under its margin.
    var highlightFrame: CGRect { contentView.bounds }

    override func layoutSubviews() {
        super.layoutSubviews()
        highlight.frame = highlightFrame
    }

    override func setHighlighted(_ highlighted: Bool, animated: Bool) {
        super.setHighlighted(highlighted, animated: animated)
        UIView.animate(withDuration: highlighted ? RowHighlight.fadeIn : RowHighlight.fadeOut, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.highlight.alpha = highlighted ? 1 : 0
        }
    }
}

/// "≈ +12 -3" on a checkout.
final class GitChangesView: UIView {
    let approximate: StyledLabel
    let added: StyledLabel
    let removed: StyledLabel

    var changes: GitLineChanges? {
        didSet { if changes != oldValue { apply() } }
    }

    /// The project list's styles unless told otherwise.
    init(approximateStyle: TextStyle = TextStyles.gitApproximate, countStyle: TextStyle = TextStyles.gitLineCount) {
        approximate = StyledLabel(style: approximateStyle, color: Palette.textSecondary, lines: 1)
        added = StyledLabel(style: countStyle, color: Palette.gitAddedText, lines: 1)
        removed = StyledLabel(style: countStyle, color: Palette.gitRemovedText, lines: 1)
        super.init(frame: .zero)
        approximate.string = "≈"
        for label in [approximate, added, removed] { addSubview(label) }
        isUserInteractionEnabled = false
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        approximate.isHidden = changes?.approximate != true
        added.string = "+" + GitLineChanges.compact(changes?.insertions ?? 0)
        added.isHidden = (changes?.insertions ?? 0) <= 0
        removed.string = "-" + GitLineChanges.compact(changes?.deletions ?? 0)
        removed.isHidden = (changes?.deletions ?? 0) <= 0
        setNeedsLayout()
    }

    private var layout: GitChangesLayout {
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        return GitChangesLayout(
            approximate: approximate.isHidden ? nil : approximate.sizeThatFits(unbounded),
            added: added.isHidden ? nil : added.sizeThatFits(unbounded),
            removed: removed.isHidden ? nil : removed.sizeThatFits(unbounded)
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout.size
    }

    /// The parts shown, as VoiceOver reads them.
    var spoken: String {
        [approximate, added, removed].filter { !$0.isHidden }.map(\.string).joined(separator: " ")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        if let frame = layout.approximate { approximate.setLayoutFrame(frame) }
        if let frame = layout.added { added.setLayoutFrame(frame) }
        if let frame = layout.removed { removed.setLayoutFrame(frame) }
    }
}

/// The blocked (orange, pulsing) or unread (blue) dot on a project row.
final class ActivityDotView: UIView {
    let dot = StatusDotView()

    var activity = HomeActivity() {
        didSet { apply() }
    }

    var shows: Bool { activity.blocked || activity.unread }

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(dot)
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        dot.backgroundColor = UIColor(activity.blocked ? Palette.sessionBlockedDot : Palette.sessionReadyDot)
        dot.isPulsing = activity.blocked
        isHidden = !shows
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        dot.frame = bounds
    }
}

/// The computer heading its bots and projects.
final class ProjectMachineHeaderCell: UITableViewCell {
    static let reuseIdentifier = "project-machine"

    let icon = IconView(.ionicons("desktop-outline"), size: 12, tint: Palette.textSecondary)
    let nameLabel = StyledLabel(style: TextStyles.projectMachine, color: Palette.textSecondary, lines: 1)
    let rule = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        rule.backgroundColor = UIColor(Palette.textSecondary)
        for view in [icon, nameLabel, rule] { contentView.addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .header
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(name: String) {
        nameLabel.string = name
        accessibilityLabel = name
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> MachineHeaderLayout {
        MachineHeaderLayout(width: width, hairline: hairline, icon: icon.sizeThatFits(.zero), name: nameLabel.measurable)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        icon.setLayoutFrame(layout.icon)
        nameLabel.setLayoutFrame(layout.name)
        rule.setLayoutFrame(layout.rule)
    }
}

/// "BOTS", "PROJECTS", or a day over the archive.
final class ProjectSectionCell: UITableViewCell {
    static let reuseIdentifier = "project-section"

    let label = StyledLabel(style: TextStyles.projectSection, color: Palette.groupedSectionTitle, lines: 1)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        contentView.addSubview(label)
        label.accessibilityTraits = .header
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ text: String) {
        label.string = text
        setNeedsLayout()
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        ProjectSectionLayout(width: size.width, label: label.measurable).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.setLayoutFrame(ProjectSectionLayout(width: contentView.bounds.width, label: label.measurable).label)
    }
}

/// A project's card: avatar, name, activity, line changes and the `+`.
final class ProjectCardCell: ProjectListCell {
    static let reuseIdentifier = "project-card"

    let avatar = AvatarView()
    let stem = UIView()
    let nameLabel = ShimmerLabel(style: TextStyles.projectName)
    let dot = ActivityDotView()
    let changes = GitChangesView()
    let addButton = HeaderIconButton(.ionicons("add"), size: 18, label: "")
    private(set) var entry: ProjectHomeEntry?
    var onCreateWorkspace: ((ProjectHomeEntry) -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        stem.backgroundColor = UIColor(Palette.textSecondary)
        addButton.iconView.tintColor = UIColor(Palette.textSecondary)
        addButton.addAction(UIAction { [weak self] _ in
            guard let self, let entry else { return }
            onCreateWorkspace?(entry)
        }, for: .primaryActionTriggered)
        for view in [avatar, stem, nameLabel, dot, changes, addButton] { contentView.addSubview(view) }
        isAccessibilityElement = false
        nameLabel.isAccessibilityElement = true
        nameLabel.accessibilityTraits = .button
    }

    func configure(_ entry: ProjectHomeEntry, style: AvatarStyle, monochrome: Bool) {
        self.entry = entry
        avatar.isHidden = entry.avatar == nil
        // The project's picture: never badged, never faded.
        avatar.content = entry.avatar.map { .init(avatar: $0, style: style, monochrome: monochrome) }
        stem.isHidden = entry.worktreeCount == 0
        nameLabel.string = entry.name
        nameLabel.isShimmering = entry.activity.working
        nameLabel.accessibilityLabel = entry.name
        dot.activity = entry.activity
        changes.changes = entry.changes
        changes.isHidden = entry.changes == nil
        addButton.isHidden = entry.origin == nil
        addButton.accessibilityLabel = Strings.Home.createWorkspaceIn(entry.name)
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> ProjectCardLayout {
        ProjectCardLayout(.init(
            width: width,
            hairline: hairline,
            name: nameLabel.measurable,
            showsDot: dot.shows,
            changes: changes.isHidden ? nil : changes.measurable,
            showsAdd: !addButton.isHidden,
            showsTree: !stem.isHidden
        ))
    }

    override var highlightFrame: CGRect {
        CGRect(x: 0, y: ProjectListMetrics.projectMarginTop, width: contentView.bounds.width, height: ProjectListMetrics.projectRowHeight)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        avatar.setLayoutFrame(layout.avatar)
        if let frame = layout.stem { stem.setLayoutFrame(frame) }
        nameLabel.setLayoutFrame(layout.name)
        if let frame = layout.dot { dot.setLayoutFrame(frame) }
        if let frame = layout.changes { changes.setLayoutFrame(frame) }
        if let frame = layout.add { addButton.setLayoutFrame(frame) }
    }
}

/// A worktree on the tree line, or the row that ends it.
final class WorktreeCell: ProjectListCell {
    static let reuseIdentifier = "project-worktree"

    let trunk = UIView()
    let elbow = UIView()
    let chevron = IconView(.ionicons("chevron-down"), size: 13, tint: Palette.textSecondary)
    let nameLabel = ShimmerLabel(style: TextStyles.worktreeName)
    let toggleLabel = StyledLabel(style: TextStyles.worktreeToggle, color: Palette.textSecondary, lines: 1)
    let dot = ActivityDotView()
    let changes = GitChangesView()
    private var isToggle = false
    private var last = false

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        for line in [trunk, elbow] { line.backgroundColor = UIColor(Palette.textSecondary) }
        for view in [trunk, elbow, chevron, nameLabel, toggleLabel, dot, changes] { contentView.addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    func configure(_ worktree: ProjectWorktree, last: Bool) {
        isToggle = false
        self.last = last
        nameLabel.string = worktree.title
        nameLabel.isShimmering = worktree.activity.working
        dot.activity = worktree.activity
        changes.changes = worktree.changes
        changes.isHidden = worktree.changes == nil
        accessibilityLabel = worktree.title
        accessibilityValue = nil
        applyKind()
    }

    func configure(_ toggle: WorktreeToggle) {
        isToggle = true
        last = true
        chevron.icon = .ionicons(toggle.expanded ? "chevron-up" : "chevron-down")
        toggleLabel.string = toggle.expanded ? Strings.Home.showFewerWorkspaces : Strings.Home.showAllWorkspaces(toggle.worktreeCount)
        dot.activity = toggle.activity
        changes.isHidden = true
        accessibilityLabel = toggleLabel.string
        accessibilityValue = toggle.expanded ? "expanded" : "collapsed"
        applyKind()
    }

    private func applyKind() {
        nameLabel.isHidden = isToggle
        chevron.isHidden = !isToggle
        toggleLabel.isHidden = !isToggle
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> WorktreeRowLayout {
        WorktreeRowLayout(.init(
            width: width,
            hairline: hairline,
            label: isToggle ? toggleLabel.measurable : nameLabel.measurable,
            chevron: isToggle ? chevron.sizeThatFits(.zero) : nil,
            showsDot: dot.shows,
            changes: changes.isHidden ? nil : changes.measurable,
            last: last
        ))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        trunk.setLayoutFrame(layout.trunk)
        elbow.setLayoutFrame(layout.elbow)
        if let frame = layout.chevron { chevron.setLayoutFrame(frame) }
        (isToggle ? toggleLabel as UIView : nameLabel).setLayoutFrame(layout.label)
        if let frame = layout.dot { dot.setLayoutFrame(frame) }
        if let frame = layout.changes { changes.setLayoutFrame(frame) }
    }
}

/// A bot's standing chat or an archived chat: avatar, name, and the time
/// or a dot.
final class ProjectChatCell: ProjectListCell {
    static let reuseIdentifier = "project-chat"

    let avatar = AvatarView()
    let nameLabel = ShimmerLabel(style: TextStyles.projectName)
    let timestampLabel = StyledLabel(style: TextStyles.projectTimestamp, color: Palette.textSecondary, lines: 1)
    let dot = StatusDotView()
    private(set) var row: SessionRow?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        for view in [avatar, nameLabel, timestampLabel, dot] { contentView.addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    func configure(_ row: SessionRow, archived: Bool, style: AvatarStyle, monochrome: Bool) {
        self.row = row
        // A bot or retired chat gets its own face, without the harness badge.
        var face = row.avatar
        face.harness = nil
        avatar.content = .init(avatar: face, style: style, monochrome: monochrome)
        nameLabel.string = row.title ?? Strings.Session.newChat
        nameLabel.isShimmering = row.shimmersTitle
        timestampLabel.string = row.timestamp
        let showsDot = row.corner != .timestamp
        timestampLabel.isHidden = showsDot
        dot.isHidden = !showsDot
        dot.backgroundColor = UIColor(row.corner == .blockedDot ? Palette.sessionBlockedDot : Palette.sessionReadyDot)
        contentView.alpha = archived ? 0.6 : 1
        accessibilityLabel = nameLabel.string
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> ProjectChatRowLayout {
        let dotSize = ProjectListMetrics.chatDotSize
        return ProjectChatRowLayout(
            width: width,
            name: nameLabel.measurable,
            corner: dot.isHidden ? timestampLabel.measurable : .fixed(width: dotSize, height: dotSize)
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        avatar.setLayoutFrame(layout.avatar)
        nameLabel.setLayoutFrame(layout.name)
        timestampLabel.setLayoutFrame(layout.corner)
        dot.setLayoutFrame(layout.corner)
    }
}
#endif
