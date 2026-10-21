#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// The cells of the sidebar's list grouped by project (TabletGroupedList):
// SessionsList.tsx's headings, MachineHeader, ProjectGroup.tsx's checkout
// headings, CompactSessionRow and SessionItem. Each measures its content
// and applies its HappyLayout frames. Each draws its text at the person's
// text size (`FollowsTextSize`): the headings' heights are measured at it
// off the main thread (`TabletGroupedHeights`); the chats' 56 and the
// archived cards' 88 are fixed, as RN's are.

/// "Bots", or a day over the archive (SessionsList.tsx `headerSection`).
final class TabletSectionHeaderCell: UITableViewCell {
    static let reuseIdentifier = "tablet-section"

    let label = StyledLabel(style: TextStyles.sessionDayHeader, color: Palette.groupedSectionTitle, lines: 1)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        traitOverrides.followsTextSize = true
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        label.accessibilityTraits = .header
        contentView.addSubview(label)
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
        TabletSectionHeaderLayout(width: size.width, label: label.measurable).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.setLayoutFrame(TabletSectionHeaderLayout(width: contentView.bounds.width, label: label.measurable).label)
    }
}

/// ── 🖥 name ── (SessionsList.tsx `MachineHeader`). It opens the computer
/// when it has an id; the press has no look of its own.
final class TabletMachineRuleCell: UITableViewCell {
    static let reuseIdentifier = "tablet-machine"

    let leading = UIView()
    let trailing = UIView()
    let icon = IconView(.ionicons("desktop-outline"), size: TabletMachineRuleLayout.Metrics.iconSize, tint: Palette.textSecondary)
    let nameLabel = StyledLabel(style: TextStyles.tabletMachineName, color: Palette.textSecondary, lines: 1)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        traitOverrides.followsTextSize = true
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        for line in [leading, trailing] {
            line.backgroundColor = UIColor(Palette.divider)
            contentView.addSubview(line)
        }
        contentView.addSubview(icon)
        contentView.addSubview(nameLabel)
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(name: String, opens: Bool) {
        nameLabel.string = name
        accessibilityLabel = name
        accessibilityTraits = opens ? .button : .header
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> TabletMachineRuleLayout {
        TabletMachineRuleLayout(width: width, hairline: hairline, icon: icon.sizeThatFits(.zero), name: nameLabel.measurable)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        leading.setLayoutFrame(layout.leadingLine)
        icon.setLayoutFrame(layout.icon)
        nameLabel.setLayoutFrame(layout.name)
        trailing.setLayoutFrame(layout.trailingLine)
    }
}

/// A checkout's heading (ProjectGroup.tsx `WorkspaceSection`): the first
/// chat's face, the project over its branch and line changes, and `+`,
/// which starts a chat in this checkout.
final class TabletWorkspaceHeaderCell: UITableViewCell {
    static let reuseIdentifier = "tablet-workspace"

    let avatar = AvatarView()
    let titleLabel = StyledLabel(style: TextStyles.tabletWorkspaceTitle, color: Palette.groupedSectionTitle, lines: 1)
    let branchLabel = StyledLabel(style: TextStyles.tabletWorkspaceBranch, color: Palette.textSecondary, lines: 1)
    let changes = GitChangesView()
    let addButton = HitSlopControl()
    let addIcon = IconView(.ionicons("add"), size: TabletWorkspaceHeaderLayout.Metrics.addIconSize, tint: Palette.text)
    var onAdd: (() -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        traitOverrides.followsTextSize = true
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        addButton.hitSlop = TabletWorkspaceHeaderLayout.Metrics.addHitSlop
        addButton.backgroundColor = UIColor(Palette.surfaceHighest)
        addButton.layer.cornerRadius = TabletWorkspaceHeaderLayout.Metrics.addButtonSize / 2
        addButton.isAccessibilityElement = true
        addButton.accessibilityLabel = Strings.Tablet.newSession
        addButton.accessibilityTraits = .button
        addIcon.isUserInteractionEnabled = false
        addButton.addSubview(addIcon)
        addButton.addAction(UIAction { [weak self] _ in self?.onAdd?() }, for: .touchUpInside)
        for event: UIControl.Event in [.touchDown, .touchDragEnter, .touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel] {
            addButton.addAction(UIAction { [weak self] _ in self?.applyPressed() }, for: event)
        }
        for view in [avatar, titleLabel, branchLabel, changes, addButton] as [UIView] {
            contentView.addSubview(view)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The `+` dims to half while pressed.
    private func applyPressed() {
        addButton.alpha = addButton.isHighlighted ? 0.5 : 1
    }

    func configure(_ header: TabletWorkspaceHeader, style: AvatarStyle, monochrome: Bool) {
        avatar.content = .init(avatar: header.avatar, style: style, monochrome: monochrome)
        titleLabel.string = header.projectName
        branchLabel.string = header.branch
        changes.changes = header.changes
        changes.isHidden = header.changes == nil
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> TabletWorkspaceHeaderLayout {
        TabletWorkspaceHeaderLayout(.init(
            width: width,
            title: titleLabel.measurable,
            branch: branchLabel.measurable,
            changes: changes.isHidden ? nil : changes.sizeThatFits(.zero)
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
        branchLabel.setLayoutFrame(layout.branch)
        if let frame = layout.changes { changes.setLayoutFrame(frame) }
        addButton.setLayoutFrame(layout.addButton)
        addIcon.setLayoutFrame(layout.addIcon.offsetBy(dx: -layout.addButton.minX, dy: -layout.addButton.minY))
    }
}

/// The card's piece one row draws: a rounded, hairline-framed surface that
/// runs past the cell where the card goes on, clipped by the cell, with the
/// row's selected fill inside it.
final class TabletCardSegmentView: UIView {
    let fill = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.surface)
        clipsToBounds = true
        fill.backgroundColor = UIColor(Palette.surfaceSelected)
        fill.isHidden = true
        addSubview(fill)
        applyBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.applyBorder()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func applyBorder() {
        layer.borderWidth = hairline
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        applyBorder()
    }
}

/// A chat in its checkout's card (CompactSessionRow): its title, up to two
/// lines, and the activity dot. The row is 56 at every text size, as RN's
/// is; a title taller than that is centred on it and cut at the row's
/// edges, where RN's Swipeable cuts it (its container's
/// `overflow: 'hidden'`).
final class TabletChatCell: UITableViewCell {
    static let reuseIdentifier = "tablet-chat"

    let card = TabletCardSegmentView()
    /// The row's own box, which clips what is in it.
    private let rowClip = UIView()
    let titleLabel = StyledLabel(style: TextStyles.tabletChatTitle, color: Palette.text, lines: 2)
    let dot = StatusDotView()
    /// A waiting, read chat's draft, in the dot's slot.
    let draftIcon = IconView(.ionicons("create-outline"), size: 14, tint: Palette.textSecondary)
    let divider = UIView()
    private(set) var row: TabletChatRow?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        traitOverrides.followsTextSize = true
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        clipsToBounds = true
        contentView.clipsToBounds = true
        card.layer.cornerRadius = TabletChatRowLayout.Metrics.cardRadius
        divider.backgroundColor = UIColor(Palette.divider)
        rowClip.clipsToBounds = true
        rowClip.isUserInteractionEnabled = false
        rowClip.addSubview(titleLabel)
        rowClip.addSubview(dot)
        rowClip.addSubview(draftIcon)
        for view in [card, rowClip, divider] { contentView.addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ row: TabletChatRow) {
        self.row = row
        titleLabel.string = row.title ?? Strings.Session.newChat
        titleLabel.color = row.connected ? Palette.text : Palette.textSecondary
        switch row.indicator {
        case .none:
            dot.isHidden = true
            dot.isPulsing = false
        case .dot(let tone, let pulsing):
            dot.isHidden = false
            dot.backgroundColor = UIColor(TabletStatusColors.color(tone))
            dot.isPulsing = pulsing
        }
        // `renderTrailingIndicator`: after the needs-action and unread
        // dots, a draft takes the waiting chat's slot.
        draftIcon.isHidden = !row.hasDraft
        if row.hasDraft {
            dot.isHidden = true
            dot.isPulsing = false
        }
        divider.isHidden = !row.showsBorder
        accessibilityLabel = titleLabel.string
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> TabletChatRowLayout {
        TabletChatRowLayout(.init(
            width: width,
            hairline: hairline,
            title: titleLabel.measurable,
            first: row?.first ?? true,
            last: row?.last ?? true,
            projectEnd: row?.projectEnd ?? false,
            showsBorder: row?.showsBorder ?? false
        ))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        card.setLayoutFrame(layout.card)
        card.fill.setLayoutFrame(layout.row.offsetBy(dx: -layout.card.minX, dy: -layout.card.minY))
        rowClip.setLayoutFrame(layout.row)
        titleLabel.setLayoutFrame(layout.title.offsetBy(dx: -layout.row.minX, dy: -layout.row.minY))
        dot.setLayoutFrame(layout.dot.offsetBy(dx: -layout.row.minX, dy: -layout.row.minY))
        draftIcon.setLayoutFrame(layout.indicator.offsetBy(dx: -layout.row.minX, dy: -layout.row.minY))
        if let frame = layout.divider { divider.setLayoutFrame(frame) }
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        card.fill.isHidden = !selected
        accessibilityTraits = selected ? [.button, .selected] : .button
    }
}

/// An archived chat as its own card (SessionsList.tsx `SessionItem`): the
/// avatar, the title, where it ran, and its status line. The card is 88 at
/// every text size, as RN's is; lines taller than that are centred and cut
/// at the card's edge, as `sessionItemContainer`'s `overflow: 'hidden'`
/// cuts them.
final class TabletArchivedCell: UITableViewCell {
    static let reuseIdentifier = "tablet-archived"

    let card = TabletCardSegmentView()
    let avatar = AvatarView()
    /// `draftIconOverlay`: the 12 glyph over the avatar's corner.
    let draftIcon = IconView(.ionicons("create-outline"), size: 12, tint: Palette.textSecondary)
    let titleLabel = StyledLabel(style: TextStyles.tabletArchivedTitle, color: Palette.text, lines: 1)
    let subtitleLabel = StyledLabel(style: TextStyles.tabletArchivedSubtitle, color: Palette.textSecondary, lines: 1)
    let providerIcon = ProviderIconView(size: TabletArchivedRowLayout.Metrics.providerIconSize)
    let dot = StatusDotView()
    let statusLabel = StyledLabel(style: TextStyles.tabletArchivedStatus, color: TabletPalette.statusOffline)
    private(set) var row: TabletArchivedRow?
    /// `vibingMessage`: drawn again whenever the state changes.
    private var vibingWord = ComposerStatus.randomVibingWord()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        traitOverrides.followsTextSize = true
        backgroundColor = UIColor(Palette.groupedBackground)
        selectionStyle = .none
        card.layer.cornerRadius = TabletArchivedRowLayout.Metrics.radius
        card.fill.layer.cornerRadius = TabletArchivedRowLayout.Metrics.radius
        contentView.addSubview(card)
        // Inside the card, which clips them; over its selected fill.
        for view in [avatar, draftIcon, titleLabel, providerIcon, subtitleLabel, dot, statusLabel] as [UIView] {
            view.isUserInteractionEnabled = false
            card.addSubview(view)
        }
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ row: TabletArchivedRow, style: AvatarStyle, monochrome: Bool) {
        if row.status == .thinking, row.id != self.row?.id || self.row?.status != .thinking {
            vibingWord = ComposerStatus.randomVibingWord()
        }
        self.row = row
        var corners: CACornerMask = []
        if row.first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
        if row.last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
        card.layer.maskedCorners = corners
        card.fill.layer.maskedCorners = corners
        avatar.content = .init(avatar: row.avatar, style: style, monochrome: monochrome || !row.connected)
        draftIcon.isHidden = !row.hasDraft
        titleLabel.string = row.title ?? Strings.Session.newChat
        titleLabel.color = row.connected ? Palette.text : Palette.textSecondary
        switch row.subtitle {
        case .identity(let text, let kind):
            subtitleLabel.string = text
            providerIcon.kind = kind
        case .folder(let text), .text(let text): subtitleLabel.string = text
        case .unknown: subtitleLabel.string = Strings.Tablet.unknown
        }
        providerIcon.isHidden = !row.subtitle.hasProviderIcon
        let color = TabletStatusColors.color(row.tone)
        dot.backgroundColor = UIColor(color)
        dot.isPulsing = row.pulsing
        statusLabel.color = color
        statusLabel.string = (row.modelName.map { "\($0) · " } ?? "")
            + Self.statusText(row.status, vibingWord: vibingWord)
            + (row.activity.map { " · \($0)" } ?? "")
        accessibilityLabel = [titleLabel.string, subtitleLabel.string, statusLabel.string].joined(separator: ", ")
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> TabletArchivedRowLayout {
        TabletArchivedRowLayout(.init(
            width: width,
            hairline: hairline,
            title: titleLabel.measurable,
            subtitle: subtitleLabel.measurable,
            subtitleRow: row?.subtitle.inRow ?? false,
            subtitleIcon: providerIcon.isHidden ? nil : providerIcon.sizeThatFits(.zero),
            status: statusLabel.measurable,
            last: row?.last ?? true
        ))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        card.setLayoutFrame(layout.card)
        // The card's own coordinates.
        func inCard(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: -layout.card.minX, dy: -layout.card.minY) }
        card.fill.setLayoutFrame(inCard(layout.row))
        avatar.setLayoutFrame(inCard(layout.avatar))
        draftIcon.setLayoutFrame(inCard(layout.draftOverlay))
        titleLabel.setLayoutFrame(inCard(layout.title))
        subtitleLabel.setLayoutFrame(inCard(layout.subtitle))
        if let frame = layout.subtitleIcon { providerIcon.setLayoutFrame(inCard(frame)) }
        dot.setLayoutFrame(inCard(layout.dot))
        statusLabel.setLayoutFrame(inCard(layout.status))
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        card.fill.isHidden = !selected
        accessibilityTraits = selected ? [.button, .selected] : .button
    }

    /// The status line's middle: SessionsList.tsx `statusText`.
    static func statusText(_ status: TabletArchivedRow.Status, vibingWord: String) -> String {
        switch status {
        case .inputRequired: Strings.Status.inputRequired
        case .permissionRequired: Strings.Status.permissionRequired
        case .unread: Strings.Status.unread
        case .thinking: vibingWord.lowercased() + "…"
        case .lastSeen(let lastSeen): Strings.Composer.lastSeen(lastSeenText(lastSeen))
        case .online: Strings.Status.online
        }
    }

    /// sessionUtils.ts `formatLastSeen`.
    static func lastSeenText(_ lastSeen: ComposerStatus.LastSeen) -> String {
        switch lastSeen {
        case .justNow: return Strings.Composer.justNow
        case .minutes(let count): return Strings.Composer.minutesAgo(count)
        case .hours(let count): return Strings.Composer.hoursAgo(count)
        case .days(let count): return Strings.Composer.daysAgo(count)
        case .date(let ms):
            let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            let formatter = DateFormatter()
            let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
            formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
            return formatter.string(from: date)
        }
    }
}

/// ProviderIcon.tsx: the GPT mark tinted the secondary text colour, the
/// Claude mark in its own colours, or an Ionicon in the secondary colour.
final class ProviderIconView: UIView {
    private let image = UIImageView()
    private let glyph: IconView
    private let size: CGFloat

    var kind: ProviderIconKind = .generic {
        didSet { if kind != oldValue { apply() } }
    }

    init(size: CGFloat) {
        self.size = size
        glyph = IconView(nil, size: size, tint: Palette.textSecondary)
        super.init(frame: .zero)
        image.contentMode = .scaleAspectFit
        image.tintColor = UIColor(Palette.textSecondary)
        addSubview(image)
        addSubview(glyph)
        isUserInteractionEnabled = false
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        switch kind {
        case .codex:
            image.image = UIImage.happy("icon-gpt")?.withRenderingMode(.alwaysTemplate)
        case .claude:
            image.image = UIImage.happy("icon-claude")?.withRenderingMode(.alwaysOriginal)
        case .grok, .kimi, .generic:
            image.image = nil
        }
        image.isHidden = image.image == nil
        glyph.isHidden = !image.isHidden
        switch kind {
        case .grok: glyph.icon = .ionicons("flash-outline")
        case .kimi: glyph.icon = .ionicons("moon-outline")
        case .generic: glyph.icon = .ionicons("sparkles-outline")
        case .codex, .claude: glyph.icon = nil
        }
        setNeedsLayout()
    }

    /// An image is `size` square; a glyph is its RN text box (`Icon.layout`).
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        image.isHidden ? glyph.sizeThatFits(size) : CGSize(width: self.size, height: self.size)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = bounds
        glyph.frame = bounds
    }
}

/// `TabletStatusTone` as drawn.
enum TabletStatusColors {
    static func color(_ tone: TabletStatusTone) -> ColorToken {
        switch tone {
        case .offline: TabletPalette.statusOffline
        case .working: TabletPalette.statusWorking
        case .online: TabletPalette.statusOnline
        case .attention: TabletPalette.statusAttention
        case .idle: Palette.textSecondary
        }
    }
}
#endif
