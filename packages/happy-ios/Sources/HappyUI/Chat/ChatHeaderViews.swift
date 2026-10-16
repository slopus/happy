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
        let layout = ChatPlainHeaderLayout(
            bar: bar.map { $0.convert($0.bounds, to: self) } ?? bounds, size: bounds.size, maxWidth: maxWidth,
            title: title.measurable, subtitle: hasSubtitle ? subtitle.measurable : nil,
            changes: changes.isHidden ? nil : changes.sizeThatFits(.zero)
        )
        // Bounds and centre rather than a frame: the column scales when pressed.
        column.bounds = CGRect(origin: .zero, size: layout.column.size)
        column.center = CGPoint(x: layout.column.midX, y: layout.column.midY)
        title.place(layout.title)
        if let rect = layout.subtitle { subtitle.place(rect) }
        if let rect = layout.changes { changes.setLayoutFrame(rect) }
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

/// SessionView's back button on a phone held sideways, where the header is
/// gone: a 44pt disc with Ionicons' chevron-back at 28, a soft shadow, and
/// 15 of slop around it. Like happy-app's Pressable it doesn't change while
/// pressed.
final class ChatLandscapeBackButton: UIControl {
    private static let hitSlop: CGFloat = 15
    private let chevron = IconView(.ionicons("chevron-back"), size: 28, tint: Palette.landscapeBackGlyph)

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(chevron)
        layer.shadowOffset = CGSize(width: 0, height: 2)
        layer.shadowOpacity = 0.1
        layer.shadowRadius = 4
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.Common.back
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
        chevron.setLayoutFrame(bounds)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -Self.hitSlop, dy: -Self.hitSlop).contains(point)
    }

    private func updateColors() {
        backgroundColor = UIColor(Palette.landscapeBackFill)
        layer.shadowColor = UIColor(Palette.shadow).resolvedColor(with: traitCollection).cgColor
    }
}

/// The surface behind the status bar while the header is gone, its shadow
/// falling 2 onto the chat (theme.colors.shadow, radius 3).
final class ChatStatusBarStrip: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = UIColor(Palette.surface)
        layer.shadowOffset = CGSize(width: 0, height: 2)
        layer.shadowOpacity = 0.1
        layer.shadowRadius = 3
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.shadowPath = UIBezierPath(rect: bounds).cgPath
    }

    private func updateColors() {
        layer.shadowColor = UIColor(Palette.shadow).resolvedColor(with: traitCollection).cgColor
    }
}

/// What fills the chat when there is no conversation to show: a spinner
/// while it loads, EmptyMessages for a chat with nothing in it yet,
/// PendingChatPlaceholder for one that hasn't started yet, or the deleted
/// state (SessionView.tsx). Centred in the frame it is given. What it says
/// is read on main when it is shown; its text is measured and laid out off
/// the main thread at its traits' text size (`ChatPlaceholderMeasure`), and
/// again for a new frame or size. Each plan is drawn whole, its words and
/// buttons with it, so until the first is in nothing shows, and after a
/// change the last one stays until the next is. The glyphs keep their size.
final class ChatPlaceholderView: UIView {
    enum Content: Equatable, Sendable {
        case loading
        /// The chat's first page failed: Retry in the spinner's place.
        case loadFailed
        /// EmptyMessages, with what shows under the path: "No messages
        /// yet", the spinner while it pages back, Retry or Load more.
        case empty(ChatEmptyState, ChatOlderPaging.EmptyStatus)
        case pendingChat(PendingChatPlaceholderModel)
        case deleted
    }

    /// Retry or Load more was pressed; which one is `content`.
    var onAction: (() -> Void)?

    private(set) var content: Content?
    private let spinner = UIActivityIndicatorView(style: .medium)
    /// EmptyMessages' and the first load's Retry and Load more
    /// (RoundButton, small and inverted).
    let button = RoundButton(title: Strings.Chat.retry, size: .small, display: .inverted)
    /// EmptyMessages' spinner while it pages back, in the column.
    let pagingSpinner = UIActivityIndicatorView(style: .medium)
    private let icon = IconView(size: 72, tint: Palette.textSecondary)
    /// PendingChatPlaceholder's "Starting a new chat…".
    private let shimmer = ShimmerLabel(style: TextStyles.pendingChatTitle)
    /// The lines' views, reused from plan to plan.
    private var texts: [ChatTextView] = []
    private var model: ChatPlaceholderModel?
    let measure = OffMainPlan<ChatPlaceholderInput, ChatPlaceholderPlan> { ChatPlaceholderMeasure.plan($0) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        spinner.color = UIColor(Palette.textSecondary)
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        icon.isHidden = true
        addSubview(icon)
        shimmer.isHidden = true
        addSubview(shimmer)
        button.isHidden = true
        button.onTap = { [weak self] in self?.onAction?() }
        addSubview(button)
        pagingSpinner.color = UIColor(Palette.textSecondary)
        pagingSpinner.hidesWhenStopped = true
        addSubview(pagingSpinner)
        measure.onApply = { [weak self] in self?.setNeedsLayout() }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(_ content: Content) {
        guard content != self.content else { return }
        self.content = content
        model = ChatPlaceholderModel(content)
        setNeedsLayout()
    }

    /// What the placeholder is measured from now. Reads, no measuring.
    private var measureInput: ChatPlaceholderInput? {
        guard let model, bounds.width > 0 else { return nil }
        var text = TextEnvironment(traitCollection)
        // As its labels draw it: at the designed size unless the screen follows.
        if !traitCollection[FollowsTextSize.self] { text.scale = .standard }
        return ChatPlaceholderInput(model: model, width: bounds.width, text: text, spinner: pagingSpinner.intrinsicContentSize)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let input = measureInput { measure.request(input) }
        guard let applied = measure.applied else { return }
        let model = applied.input.model
        let plan = applied.plan
        let frames = plan.layout(model, size: bounds.size)
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        if model.loading { spinner.startAnimating() } else { spinner.stopAnimating() }

        icon.isHidden = frames.icon == nil
        if let frame = frames.icon, let glyph = model.icon {
            icon.icon = glyph.icon
            icon.size = glyph.size
            icon.setLayoutFrame(frame)
        }
        shimmer.isHidden = frames.title == nil
        shimmer.isShimmering = frames.title != nil
        if let frame = frames.title, let title = model.title {
            if shimmer.string != title { shimmer.string = title }
            shimmer.setLayoutFrame(frame)
        }

        while texts.count < plan.lines.count {
            let view = ChatTextView()
            view.isAccessibilityElement = false
            addSubview(view)
            texts.append(view)
        }
        for (index, view) in texts.enumerated() {
            view.isHidden = index >= frames.lines.count
            guard index < frames.lines.count else { continue }
            view.setLayoutFrame(frames.lines[index])
            view.layout = plan.lines[index]
        }

        // The status where the plan puts it: the button, its label measured
        // for its width, or the paging spinner.
        let buttonTitle = model.status?.button ?? model.button
        button.isHidden = buttonTitle == nil || frames.status == nil
        if let buttonTitle, let frame = frames.status {
            if button.title != buttonTitle { button.title = buttonTitle }
            button.measuredLabelSize = plan.buttonLabel
            button.setLayoutFrame(frame)
        }
        if model.status != nil, model.status?.button == nil, let frame = frames.status {
            pagingSpinner.setLayoutFrame(frame)
            if !pagingSpinner.isAnimating { pagingSpinner.startAnimating() }
        } else {
            pagingSpinner.stopAnimating()
        }
    }
}
#endif
