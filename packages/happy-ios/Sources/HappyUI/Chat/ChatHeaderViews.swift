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
/// session's info. Its text follows the screen's text size (`text`), laid
/// out off the main thread (`ChatHeaderMeasure.title`), and the capsule
/// asks the bar for the size its plan says. Until the first is in, and
/// while there is nothing to head it (a chat still loading), it shows
/// nothing and asks for a point: the bar (iOS 26) never takes a title view
/// that is zero wide when its item goes on, and never looks again. The
/// capsule keeps RN's 44 and cuts text taller than that, as
/// `mobileTitlePillGlass`'s `overflow: 'hidden'` does.
final class ChatHeaderTitleView: UIControl {
    private let glass = HeaderGlassView()
    /// The capsule's inside, cut to its shape.
    private let content = UIView()
    private let title = ChatTextView()
    private let subtitle = ChatTextView()
    private let changes = ChatGitChangesView()
    private var model: ChatHeaderTitleModel?
    let measure = OffMainPlan<ChatHeaderTitleInput, ChatHeaderTitlePlan> { ChatHeaderMeasure.title($0) }
    /// Told once a plan is taken.
    var onPlanned: (() -> Void)?
    /// The last plan made at `maxWidth`: the size the capsule asks for.
    private var wanted: (input: ChatHeaderTitleInput, size: CGSize)?

    /// The screen's text size and pixels, handed over by the screen: the
    /// navigation bar holds its title view's own text size to XXL, and
    /// RN's header, a plain view, has no such limit. Until it is set, its
    /// own traits'.
    var text: TextEnvironment? {
        didSet {
            guard text != oldValue else { return }
            requestPlan()
            setNeedsLayout()
        }
    }

    /// How wide the capsule may grow; set from the screen's width.
    var maxWidth: CGFloat = ChatHeaderTitleLayout.maxWidth(headerWidth: 393) {
        didSet {
            guard maxWidth != oldValue else { return }
            requestPlan()
            setNeedsLayout()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        content.isUserInteractionEnabled = false
        content.clipsToBounds = true
        glass.addSubview(content)
        for view in [title, subtitle] {
            view.isAccessibilityElement = false
            content.addSubview(view)
        }
        content.addSubview(changes)
        isAccessibilityElement = true
        accessibilityTraits = [.button, .header]
        measure.onApply = { [weak self] in self?.planned() }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.requestPlan()
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// `title || subtitle` heads the capsule, as in happy-app. With neither
    /// (the session isn't loaded yet) there is no capsule, rather than an
    /// empty one that then grows.
    func update(title: String, subtitle: String?, changes: SessionDetails.LineChanges?) {
        let heading = title.isEmpty ? (subtitle ?? "") : title
        accessibilityLabel = heading
        accessibilityValue = subtitle
        guard !heading.isEmpty else {
            model = nil
            measure.reset()
            if wanted != nil {
                wanted = nil
                sizeChanged()
            }
            setNeedsLayout()
            return
        }
        model = ChatHeaderTitleModel(
            heading: heading, subtitle: subtitle,
            changes: changes.map { GitLineChanges(approximate: $0.approximate, insertions: $0.insertions, deletions: $0.deletions) }
        )
        requestPlan()
        setNeedsLayout()
    }

    /// What it is planned from at `width`. Reads, no measuring.
    private func input(width: CGFloat) -> ChatHeaderTitleInput? {
        model.map { ChatHeaderTitleInput(model: $0, width: width, text: text ?? traitCollection.measuredTextEnvironment) }
    }

    /// Asks for the capsule at `maxWidth`, or at what the bar handed over
    /// when that is less than the capsule asked for.
    private func requestPlan() {
        guard let widest = input(width: maxWidth) else { return }
        let room = min(bounds.width, maxWidth)
        if let wanted, wanted.input == widest, bounds.width > 0, room < wanted.size.width - 0.5, let squeezed = input(width: room) {
            measure.request(squeezed)
        } else {
            measure.request(widest)
        }
    }

    /// A plan came in: one at `maxWidth` is what the capsule now asks for.
    private func planned() {
        if let applied = measure.applied, applied.input.width == maxWidth {
            let size = applied.plan.layout.size
            let changed = wanted?.size != size
            wanted = (applied.input, size)
            if changed { sizeChanged() }
        }
        setNeedsLayout()
        onPlanned?()
    }

    /// Asks the bar for `intrinsicContentSize`. In the bar the frame is the
    /// bar's to set, which it does only once a push is over; until then the
    /// capsule stays centred in what it has.
    private func sizeChanged() {
        invalidateIntrinsicContentSize()
        if window == nil { frame.size = intrinsicContentSize }
        superview?.setNeedsLayout()
    }

    override var intrinsicContentSize: CGSize {
        wanted?.size ?? CGSize(width: 1, height: ChatHeaderTitleLayout.Metrics.height)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let wanted = intrinsicContentSize
        return size.width > 0 ? CGSize(width: min(size.width, wanted.width), height: wanted.height) : wanted
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        requestPlan()
        glass.isHidden = measure.plan == nil
        guard let plan = measure.plan else { return }
        let layout = plan.layout
        // The bar may hand over less room than asked for, or more: the
        // capsule fits what it gets and stays centred in it.
        glass.setLayoutFrame(CGRect(
            x: (bounds.width - layout.size.width) / 2,
            y: (bounds.height - layout.size.height) / 2,
            width: layout.size.width,
            height: layout.size.height
        ))
        content.frame = glass.bounds
        content.layer.cornerRadius = glass.bounds.height / 2
        title.setLayoutFrame(layout.title)
        title.layout = plan.title
        subtitle.isHidden = plan.subtitle == nil
        if let frame = layout.subtitle, let text = plan.subtitle {
            subtitle.setLayoutFrame(frame)
            subtitle.layout = text
        }
        changes.isHidden = plan.changes == nil
        if let frame = layout.changes, let parts = plan.changes {
            changes.setLayoutFrame(frame)
            changes.apply(parts)
        }
    }

    /// The capsule takes touches where it is drawn, wider than the frame
    /// while the bar has yet to hand it its size.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) || (!glass.isHidden && glass.frame.contains(point))
    }

    override var isHighlighted: Bool {
        didSet { glass.alpha = isHighlighted ? 0.68 : 1 }
    }
}

/// GitLineChanges as planned (`ChatGitChangesPlan`): "≈", the lines added
/// and the lines removed, each where the plan puts it. Measures nothing.
final class ChatGitChangesView: UIView {
    private let parts = [ChatTextView(), ChatTextView(), ChatTextView()]

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for part in parts {
            part.isAccessibilityElement = false
            addSubview(part)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: ChatGitChangesPlan) {
        let planned = [(plan.approximate, plan.layout.approximate), (plan.added, plan.layout.added), (plan.removed, plan.layout.removed)]
        for (view, part) in zip(parts, planned) {
            view.isHidden = part.0 == nil || part.1 == nil
            if let text = part.0, let frame = part.1 {
                view.setLayoutFrame(frame)
                view.layout = text
            }
        }
    }
}

/// ChatHeaderView on a tablet: no glass and no capsule. The title and its
/// workspace or branch line sit at the start of the header's row
/// (`ChatPlainHeaderLayout`), the subtitle in `textSecondary`. The view
/// stretches across the navigation bar and places the column from the bar's
/// own edges, wherever the bar put it. Tapping it opens the session's info.
/// Its text follows the screen's text size (`text`), measured off the main
/// thread at the column's width (`ChatHeaderMeasure.plain`); until the
/// first plan is in it shows nothing. Taller text spills past the bar's
/// height, as RN's header content, which doesn't clip, lets it.
final class ChatPlainHeaderTitleView: UIControl {
    private let column = UIView()
    private let title = ChatTextView()
    private let subtitle = ChatTextView()
    private let changes = ChatGitChangesView()
    private var model: ChatHeaderTitleModel?
    let measure = OffMainPlan<ChatPlainHeaderInput, ChatPlainHeaderPlan> { ChatHeaderMeasure.plain($0) }
    /// Told once a plan is taken.
    var onPlanned: (() -> Void)?

    /// The screen's text size and pixels, as `ChatHeaderTitleView.text`.
    var text: TextEnvironment? {
        didSet { if text != oldValue { setNeedsLayout() } }
    }

    /// `layout.headerMaxWidth`.
    var maxWidth: CGFloat = .greatestFiniteMagnitude {
        didSet { if maxWidth != oldValue { setNeedsLayout() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        column.isUserInteractionEnabled = false
        addSubview(column)
        for view in [title, subtitle] {
            view.isAccessibilityElement = false
            column.addSubview(view)
        }
        column.addSubview(changes)
        isAccessibilityElement = true
        accessibilityTraits = [.button, .header]
        measure.onApply = { [weak self] in
            self?.setNeedsLayout()
            self?.onPlanned?()
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func update(title: String, subtitle: String?, changes: SessionDetails.LineChanges?) {
        let heading = title.isEmpty ? (subtitle ?? "") : title
        model = ChatHeaderTitleModel(
            heading: heading, subtitle: subtitle,
            changes: changes.map { GitLineChanges(approximate: $0.approximate, insertions: $0.insertions, deletions: $0.deletions) }
        )
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
        if let model {
            let width = ChatPlainHeaderLayout.textWidth(bar: barFrame, size: bounds.size, maxWidth: maxWidth)
            measure.request(ChatPlainHeaderInput(model: model, width: width, text: text ?? traitCollection.measuredTextEnvironment))
        }
        column.isHidden = measure.plan == nil
        guard let plan = measure.plan else { return }
        let layout = ChatPlainHeaderLayout(
            bar: barFrame, size: bounds.size, maxWidth: maxWidth,
            title: .fixed(plan.title.size), subtitle: plan.subtitle.map { .fixed($0.size) },
            changes: plan.changes?.layout.size
        )
        // Bounds and centre rather than a frame: the column scales when pressed.
        column.bounds = CGRect(origin: .zero, size: layout.column.size)
        column.center = CGPoint(x: layout.column.midX, y: layout.column.midY)
        title.setLayoutFrame(layout.title)
        title.layout = plan.title
        subtitle.isHidden = plan.subtitle == nil
        if let rect = layout.subtitle, let text = plan.subtitle {
            subtitle.setLayoutFrame(rect)
            subtitle.layout = text
        }
        changes.isHidden = plan.changes == nil
        if let rect = layout.changes, let parts = plan.changes {
            changes.setLayoutFrame(rect)
            changes.apply(parts)
        }
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

    var pictures: AvatarPictures? {
        get { avatar.pictures }
        set { avatar.pictures = newValue }
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
/// machine. Its label follows the text size, laid out off the main thread
/// (`ChatHeaderMeasure.cliWarning`); until its plan is in the screen
/// doesn't place it. The glyphs keep their 14.
final class ChatCliWarningPill: UIControl {
    var warning: CliVersionWarning?
    /// Its plan came in: the screen places it again.
    var onNeedsLayout: (() -> Void)?

    private let icon = UIImageView(image: .icon(.ionicons("warning-outline"), size: CliWarningPillLayout.Metrics.iconSize))
    private let label = ChatTextView()
    private let close = UIImageView(image: .icon(.ionicons("close"), size: CliWarningPillLayout.Metrics.iconSize))
    let measure = OffMainPlan<ChatCliWarningInput, ChatTextLayout> { ChatHeaderMeasure.cliWarning($0) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.cliWarningFill)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = CliWarningPillLayout.Metrics.shadowOpacity
        layer.shadowRadius = CliWarningPillLayout.Metrics.shadowRadius
        layer.shadowOffset = CGSize(width: 0, height: CliWarningPillLayout.Metrics.shadowOffsetY)
        icon.tintColor = UIColor(Palette.cliWarningIcon)
        close.tintColor = UIColor(Palette.cliWarningText)
        label.isAccessibilityElement = false
        for view in [icon, label, close] {
            view.contentMode = .center
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.SessionDetail.cliVersionOutdated
        measure.onApply = { [weak self] in self?.onNeedsLayout?() }
        // A new size is measured when the screen next places it.
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.superview?.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The label's size on a screen `width` wide, as planned: asked for at
    /// that width, the last plan's until that is in, nil before the first.
    func label(width: CGFloat) -> Measurable? {
        measure.request(ChatCliWarningInput(label: Strings.SessionDetail.cliVersionOutdated, width: width, text: traitCollection.measuredTextEnvironment))
        return measure.plan.map { .fixed($0.size) }
    }

    /// Places the pill and its insides, from the screen's layout.
    func place(_ layout: CliWarningPillLayout) {
        setLayoutFrame(layout.pill)
        layer.cornerRadius = layout.pill.height / 2
        layer.shadowPath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: layout.pill.size), cornerRadius: layout.pill.height / 2).cgPath
        let origin = layout.pill.origin
        icon.setLayoutFrame(layout.icon.offsetBy(dx: -origin.x, dy: -origin.y))
        label.setLayoutFrame(layout.label.offsetBy(dx: -origin.x, dy: -origin.y))
        label.layout = measure.plan
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
        return ChatPlaceholderInput(model: model, width: bounds.width, text: traitCollection.measuredTextEnvironment, spinner: pagingSpinner.intrinsicContentSize)
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
