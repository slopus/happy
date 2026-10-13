#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// ChatHeaderView.tsx on a phone: the title in a glass capsule and the
// session's avatar in a glass circle, over MobileHeaderScrim. The screen
// keeps the system navigation bar, made transparent, so the back button,
// its swipe and its history menu stay the platform's own.

/// The navigation bar's title view: the session's name over its workspace
/// or branch and the line changes, hugged by a glass capsule as tall as
/// the controls beside it (`ChatHeaderTitleLayout`). Tapping it opens the
/// session's info.
final class ChatHeaderTitleView: UIControl {
    private let glass = HeaderGlassView()
    private let title = ChatLabel(MeasuredText(NSAttributedString()))
    private let subtitle = ChatLabel(MeasuredText(NSAttributedString()))
    private let changes = GitChangesView()
    private var hasSubtitle = false

    /// How wide the capsule may grow; set from the screen's width.
    var maxWidth: CGFloat = ChatHeaderTitleLayout.maxWidth(headerWidth: 393) {
        didSet { if maxWidth != oldValue { invalidate() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        for view in [title.view, subtitle.view, changes] {
            glass.addSubview(view)
        }
        isAccessibilityElement = true
        accessibilityTraits = [.button, .header]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// `title || subtitle` heads the capsule, as in happy-app.
    func update(title: String, subtitle: String?, changes: SessionDetails.LineChanges?) {
        let heading = title.isEmpty ? (subtitle ?? "") : title
        self.title.update(MeasuredText(ChatTextStyles.headerTitle.string(heading, color: Palette.headerTint, alignment: .center, lineBreakMode: .byTruncatingTail), maxLines: 1))
        hasSubtitle = subtitle != nil
        self.subtitle.update(MeasuredText(ChatTextStyles.headerSubtitle.string(subtitle ?? "", color: Palette.headerGlassSubtitle, lineBreakMode: .byTruncatingTail), maxLines: 1))
        self.subtitle.view.isHidden = subtitle == nil
        self.changes.changes = changes.map { GitLineChanges(approximate: $0.approximate, insertions: $0.insertions, deletions: $0.deletions) }
        self.changes.isHidden = changes == nil
        accessibilityLabel = heading
        accessibilityValue = subtitle
        invalidate()
    }

    private func invalidate() {
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    private func layout(maxWidth: CGFloat) -> ChatHeaderTitleLayout {
        ChatHeaderTitleLayout(
            maxWidth: maxWidth,
            title: title.measurable,
            subtitle: hasSubtitle ? subtitle.measurable : nil,
            changes: changes.isHidden ? nil : changes.sizeThatFits(.zero)
        )
    }

    override var intrinsicContentSize: CGSize {
        layout(maxWidth: maxWidth).size
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(maxWidth: size.width > 0 ? min(size.width, maxWidth) : maxWidth).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The bar may hand over less room than asked for, or more: the
        // capsule fits what it gets and stays centred in it.
        let layout = layout(maxWidth: min(bounds.width, maxWidth))
        glass.setLayoutFrame(CGRect(
            x: (bounds.width - layout.size.width) / 2,
            y: (bounds.height - layout.size.height) / 2,
            width: layout.size.width,
            height: layout.size.height
        ))
        title.place(layout.title)
        if let frame = layout.subtitle { subtitle.place(frame) }
        if let frame = layout.changes { changes.setLayoutFrame(frame) }
    }

    override var isHighlighted: Bool {
        didSet { glass.alpha = isHighlighted ? 0.68 : 1 }
    }
}

/// ChatHeaderView on a tablet: no glass and no capsule. The title and its
/// workspace or branch line sit at the start of the header's row
/// (`ChatPlainHeaderLayout`), the subtitle in `textSecondary`. The view
/// stretches across the navigation bar and places the column from the bar's
/// own edges, wherever the bar put it. Tapping it opens the session's info.
final class ChatPlainHeaderTitleView: UIControl {
    private let column = UIView()
    private let title = ChatLabel(MeasuredText(NSAttributedString()))
    private let subtitle = ChatLabel(MeasuredText(NSAttributedString()))
    private let changes = GitChangesView()
    private var hasSubtitle = false

    /// `layout.headerMaxWidth`.
    var maxWidth: CGFloat = .greatestFiniteMagnitude {
        didSet { if maxWidth != oldValue { setNeedsLayout() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        column.isUserInteractionEnabled = false
        addSubview(column)
        for view in [title.view, subtitle.view, changes] {
            column.addSubview(view)
        }
        isAccessibilityElement = true
        accessibilityTraits = [.button, .header]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func update(title: String, subtitle: String?, changes: SessionDetails.LineChanges?) {
        let heading = title.isEmpty ? (subtitle ?? "") : title
        self.title.update(MeasuredText(ChatTextStyles.headerTitle.string(heading, color: Palette.headerTint, lineBreakMode: .byTruncatingTail), maxLines: 1))
        hasSubtitle = subtitle != nil
        self.subtitle.update(MeasuredText(ChatTextStyles.headerPlainSubtitle.string(subtitle ?? "", color: Palette.textSecondary, lineBreakMode: .byTruncatingTail), maxLines: 1))
        self.subtitle.view.isHidden = subtitle == nil
        self.changes.changes = changes.map { GitLineChanges(approximate: $0.approximate, insertions: $0.insertions, deletions: $0.deletions) }
        self.changes.isHidden = changes == nil
        accessibilityLabel = heading
        accessibilityValue = subtitle
        setNeedsLayout()
    }

    /// As wide as the bar lets a title view grow.
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.layoutFittingExpandedSize.width, height: UIView.noIntrinsicMetric)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The row is the bar's, not this view's: UIKit insets a title view.
        var bar: UIView? = superview
        while let current = bar, !(current is UINavigationBar) { bar = current.superview }
        let barFrame = bar.map { $0.convert($0.bounds, to: self) } ?? bounds
        let layout = ChatPlainHeaderLayout(
            barWidth: barFrame.width, barHeight: bounds.height, maxWidth: maxWidth,
            title: title.measurable, subtitle: hasSubtitle ? subtitle.measurable : nil,
            changes: changes.isHidden ? nil : changes.sizeThatFits(.zero)
        )
        // Kept inside this view, where its touches land.
        var frame = layout.column.offsetBy(dx: barFrame.minX, dy: 0)
        frame.origin.x = min(max(frame.minX, 0), bounds.width)
        frame.size.width = max(0, min(frame.width, bounds.width - frame.minX))
        column.bounds = CGRect(origin: .zero, size: frame.size)
        column.center = CGPoint(x: frame.midX, y: frame.midY)
        let origin = layout.column.origin
        title.place(layout.title.offsetBy(dx: -origin.x, dy: -origin.y))
        if let rect = layout.subtitle { subtitle.place(rect.offsetBy(dx: -origin.x, dy: -origin.y)) }
        if let rect = layout.changes { changes.setLayoutFrame(rect.offsetBy(dx: -origin.x, dy: -origin.y)) }
    }

    /// BubblePressable's `bubbleScale={1.012}`.
    override var isHighlighted: Bool {
        didSet { column.transform = isHighlighted ? CGAffineTransform(scaleX: 1.012, y: 1.012) : .identity }
    }
}

/// SessionView's `headerRight`: the session's avatar, grey while it is
/// offline, in a glass circle. It opens the session's info.
final class ChatHeaderAvatarControl: UIControl {
    private let glass = HeaderGlassView()
    private let avatar = AvatarView()

    var content: AvatarView.Content? {
        get { avatar.content }
        set { avatar.content = newValue }
    }

    override init(frame: CGRect) {
        super.init(frame: CGRect(origin: frame.origin, size: CGSize(width: ChatHeaderTitleLayout.Metrics.controlSize, height: ChatHeaderTitleLayout.Metrics.controlSize)))
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        glass.addSubview(avatar)
        // Labelled with the session's name by the screen.
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: ChatHeaderTitleLayout.Metrics.controlSize, height: ChatHeaderTitleLayout.Metrics.controlSize)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        intrinsicContentSize
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = ChatHeaderTitleLayout.Metrics.controlSize
        glass.setLayoutFrame(CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side))
        let size = ChatHeaderTitleLayout.Metrics.avatarSize
        avatar.setLayoutFrame(CGRect(x: (side - size) / 2, y: (side - size) / 2, width: size, height: size))
    }

    override var isHighlighted: Bool {
        didSet { glass.alpha = isHighlighted ? 0.68 : 1 }
    }
}

/// SessionView's CLI version warning: "CLI Update Required" in an amber
/// pill under the header. A tap dismisses it for that version on that
/// machine.
final class ChatCliWarningPill: UIControl {
    var warning: CliVersionWarning?

    private let icon = UIImageView(image: .icon(.ionicons("warning-outline"), size: CliWarningPillLayout.Metrics.iconSize))
    private let label = ChatLabel(MeasuredText(ChatTextStyles.cliWarning.string(Strings.SessionDetail.cliVersionOutdated, color: Palette.cliWarningText), maxLines: 1))
    private let close = UIImageView(image: .icon(.ionicons("close"), size: CliWarningPillLayout.Metrics.iconSize))

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.cliWarningFill)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = CliWarningPillLayout.Metrics.shadowOpacity
        layer.shadowRadius = CliWarningPillLayout.Metrics.shadowRadius
        layer.shadowOffset = CGSize(width: 0, height: CliWarningPillLayout.Metrics.shadowOffsetY)
        icon.tintColor = UIColor(Palette.cliWarningIcon)
        close.tintColor = UIColor(Palette.cliWarningText)
        for view in [icon, label.view, close] {
            view.contentMode = .center
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.SessionDetail.cliVersionOutdated
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var labelMeasurable: Measurable { label.measurable }

    /// Places the pill and its insides, from the screen's layout.
    func place(_ layout: CliWarningPillLayout) {
        setLayoutFrame(layout.pill)
        layer.cornerRadius = layout.pill.height / 2
        layer.shadowPath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: layout.pill.size), cornerRadius: layout.pill.height / 2).cgPath
        let origin = layout.pill.origin
        icon.setLayoutFrame(layout.icon.offsetBy(dx: -origin.x, dy: -origin.y))
        label.place(layout.label.offsetBy(dx: -origin.x, dy: -origin.y))
        close.setLayoutFrame(layout.close.offsetBy(dx: -origin.x, dy: -origin.y))
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }
}

/// What fills the chat when there is no conversation to show: a spinner
/// while it loads, EmptyMessages for a chat with nothing in it yet,
/// PendingChatPlaceholder for one that hasn't started yet, or the deleted
/// state (SessionView.tsx). Centred in the frame it is given.
final class ChatPlaceholderView: UIView {
    enum Content: Equatable {
        case loading
        case empty(ChatEmptyState)
        case pendingChat(PendingChatPlaceholderModel)
        case deleted
    }

    private(set) var content: Content?
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let icon = IconView(size: 72, tint: Palette.textSecondary)
    /// PendingChatPlaceholder's "Starting a new chat…".
    private let shimmer = ShimmerLabel(style: TextStyles.pendingChatTitle)
    private var labels: [(label: ChatLabel, spacing: CGFloat, padding: CGFloat)] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        spinner.color = UIColor(Palette.textSecondary)
        addSubview(spinner)
        addSubview(icon)
        shimmer.string = Strings.Chat.startingChat
        shimmer.isHidden = true
        addSubview(shimmer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(_ content: Content) {
        guard content != self.content else { return }
        self.content = content
        for entry in labels { entry.label.view.removeFromSuperview() }
        labels = []
        spinner.isHidden = content != .loading
        icon.isHidden = content == .loading
        shimmer.isHidden = !isPendingChat
        shimmer.isShimmering = isPendingChat
        switch content {
        case .loading:
            spinner.startAnimating()
        case .empty(let state):
            spinner.stopAnimating()
            icon.icon = .ionicons(state.osIcon)
            icon.size = 72
            // EmptyMessages' margins: each line sits the previous line's
            // marginBottom below it (icon 12, host 4, path 40, status 8).
            var spacing: CGFloat = 12
            if let host = state.host {
                add(ChatTextStyles.emptyHost, host, color: Palette.text, spacing: spacing, padding: 48)
                spacing = 4
            }
            if let path = state.path {
                add(ChatTextStyles.emptyPath, path, color: Palette.textSecondary, spacing: spacing, padding: 48)
                spacing = 40
            }
            add(ChatTextStyles.emptyTitle, Strings.Chat.noMessages, color: Palette.textSecondary, spacing: spacing, padding: 48)
            add(ChatTextStyles.emptyCreated, Strings.Chat.created(Strings.Chat.age(state.created)), color: Palette.textSecondary, spacing: 8, padding: 48)
        case .pendingChat(let model):
            spinner.stopAnimating()
            icon.icon = .ionicons("chatbubbles-outline")
            icon.size = 64
            switch model.detail {
            case .queued(let text)?:
                let label = ChatLabel(MeasuredText(
                    ChatTextStyles.pendingQueued.string(text, color: Palette.text, alignment: .center, lineBreakMode: .byTruncatingTail),
                    maxLines: 6
                ))
                addSubview(label.view)
                labels.append((label, 10, 48))
            case .path(let path)?:
                let label = ChatLabel(MeasuredText(
                    ChatTextStyles.emptyPath.string(path, color: Palette.textSecondary, alignment: .center, lineBreakMode: .byTruncatingTail),
                    maxLines: 1
                ))
                addSubview(label.view)
                labels.append((label, 6, 48))
            case nil:
                break
            }
        case .deleted:
            spinner.stopAnimating()
            icon.icon = .ionicons("trash-outline")
            icon.size = 48
            add(ChatTextStyles.deletedTitle, Strings.SessionDetail.sessionDeleted, color: Palette.text, spacing: 16, padding: 0)
            add(ChatTextStyles.deletedBody, Strings.SessionDetail.sessionDeletedDescription, color: Palette.textSecondary, spacing: 8, padding: 32)
        }
        setNeedsLayout()
    }

    private func add(_ style: ChatTextStyle, _ text: String, color: ColorToken, spacing: CGFloat, padding: CGFloat) {
        let label = ChatLabel(MeasuredText(style.string(text, color: color, alignment: .center)))
        addSubview(label.view)
        labels.append((label, spacing, padding))
    }

    private var isPendingChat: Bool {
        if case .pendingChat = content { return true }
        return false
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        guard content != .loading, content != nil else { return }
        var items = [CenteredStackLayout.Item(.fixed(icon.sizeThatFits(.zero)))]
        if isPendingChat {
            // The icon's marginBottom, and the placeholder's paddingHorizontal.
            let title = Measurable { [shimmer] width in
                shimmer.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            }
            items.append(CenteredStackLayout.Item(title, spacingBefore: 16, horizontalPadding: 48))
        }
        items += labels.map { CenteredStackLayout.Item($0.label.measurable, spacingBefore: $0.spacing, horizontalPadding: $0.padding) }
        var frames = CenteredStackLayout(.init(size: bounds.size, items: items)).items[...]
        icon.setLayoutFrame(frames.removeFirst())
        if isPendingChat { shimmer.setLayoutFrame(frames.removeFirst()) }
        for (entry, frame) in zip(labels, frames) {
            entry.label.place(frame)
        }
    }
}
#endif
