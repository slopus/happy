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

/// What fills the chat when there is no conversation to show: a spinner
/// while it loads, EmptyMessages for a chat with nothing in it yet, or the
/// deleted state (SessionView.tsx). Centred in the frame it is given.
final class ChatPlaceholderView: UIView {
    enum Content: Equatable {
        case loading
        case empty(ChatEmptyState)
        case deleted
    }

    private(set) var content: Content?
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let icon = IconView(size: 72, tint: Palette.textSecondary)
    private var labels: [(label: ChatLabel, spacing: CGFloat, padding: CGFloat)] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        spinner.color = UIColor(Palette.textSecondary)
        addSubview(spinner)
        addSubview(icon)
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

    override func layoutSubviews() {
        super.layoutSubviews()
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        guard content != .loading, content != nil else { return }
        var items = [CenteredStackLayout.Item(.fixed(icon.sizeThatFits(.zero)))]
        items += labels.map { CenteredStackLayout.Item($0.label.measurable, spacingBefore: $0.spacing, horizontalPadding: $0.padding) }
        let frames = CenteredStackLayout(.init(size: bounds.size, items: items)).items
        icon.setLayoutFrame(frames[0])
        for (entry, frame) in zip(labels, frames.dropFirst()) {
            entry.label.place(frame)
        }
    }
}
#endif
