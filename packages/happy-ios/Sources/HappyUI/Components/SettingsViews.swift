#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

// The pieces the settings pages are built from, beyond Item and ItemGroup.
// Each measures itself and applies a layout from HappyLayout.

/// The logotype card at the top of Settings while the account has no name
/// (components/SettingsView.tsx, logo branch).
public final class SettingsHeaderView: UIView {
    let card = UIView()
    let logoView = UIImageView()

    public override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = UIColor(Palette.surface)
        card.layer.cornerRadius = SettingsHeaderLayout.Metrics.cornerRadius
        card.layer.cornerCurve = .continuous
        logoView.contentMode = .scaleAspectFit
        addSubview(card)
        card.addSubview(logoView)
        updateAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateAppearance()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        SettingsHeaderLayout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = SettingsHeaderLayout(width: bounds.width)
        card.setLayoutFrame(layout.card)
        logoView.setLayoutFrame(layout.logo)
    }

    private func updateAppearance() {
        // logotype-dark is the dark artwork for light backgrounds.
        let dark = traitCollection.userInterfaceStyle == .dark
        logoView.image = .happy(dark ? "logotype-light" : "logotype-dark")
        logoView.accessibilityLabel = "Happy"
        card.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        card.layer.borderWidth = 0.5
    }
}

/// The card at the top of Settings once the account has a first name: the
/// avatar, the display name and the GitHub bio, centred.
public final class SettingsProfileHeaderView: UIView {
    public struct Content: Equatable {
        public var id: String
        public var name: String
        public var bio: String?
        public var avatarURL: URL?
        public var thumbhash: String?
        public var style: AvatarStyle
        public var monochrome: Bool

        public init(id: String, name: String, bio: String?, avatarURL: URL?, thumbhash: String? = nil, style: AvatarStyle, monochrome: Bool) {
            self.id = id
            self.name = name
            self.bio = bio
            self.avatarURL = avatarURL
            self.thumbhash = thumbhash
            self.style = style
            self.monochrome = monochrome
        }
    }

    public var content: Content {
        didSet { if content != oldValue { apply() } }
    }

    /// The account the picture is fetched for, from its own cache.
    public var pictures: AccountPictures? {
        didSet { if pictures !== oldValue { apply() } }
    }

    let card = UIView()
    let avatarView = AvatarView()
    let photo = RemoteImageView(size: SettingsProfileHeaderLayout.Metrics.avatarSize)
    let nameLabel = StyledLabel(style: TextStyles.profileName, color: Palette.text, alignment: .center)
    let bioLabel = StyledLabel(style: TextStyles.profileBio, color: Palette.textSecondary, alignment: .center)

    public init(content: Content, pictures: AccountPictures? = nil) {
        self.content = content
        self.pictures = pictures
        super.init(frame: .zero)
        card.backgroundColor = UIColor(Palette.surface)
        card.layer.cornerRadius = SettingsProfileHeaderLayout.Metrics.cornerRadius
        card.layer.cornerCurve = .continuous
        addSubview(card)
        for view in [avatarView, photo, nameLabel, bioLabel] {
            card.addSubview(view)
        }
        apply()
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateBorder()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> SettingsProfileHeaderLayout {
        SettingsProfileHeaderLayout(width: width, name: nameLabel.measurable, bio: content.bio == nil ? nil : bioLabel.measurable)
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        card.setLayoutFrame(layout.card)
        avatarView.setLayoutFrame(layout.avatar)
        photo.setLayoutFrame(layout.avatar)
        nameLabel.setLayoutFrame(layout.name)
        if let frame = layout.bio { bioLabel.setLayoutFrame(frame) }
    }

    private func apply() {
        nameLabel.string = content.name
        bioLabel.string = content.bio ?? ""
        bioLabel.isHidden = content.bio == nil
        // Avatar.tsx: a picture replaces the generated avatar outright.
        avatarView.isHidden = content.avatarURL != nil
        avatarView.content = AvatarView.Content(
            avatar: SessionAvatar(seed: content.id),
            style: content.style,
            monochrome: content.monochrome
        )
        photo.show(content.avatarURL, thumbhash: content.thumbhash, from: pictures)
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    private func updateBorder() {
        card.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        card.layer.borderWidth = 0.5
    }
}

/// A round picture fetched from a URL (expo-image with a disk cache),
/// from its account's own `AccountPictures`. The placeholder (a decoded
/// thumbhash) shows until the picture arrives.
public final class RemoteImageView: UIImageView {
    public private(set) var url: URL?
    private var thumbhash: String?
    private weak var pictures: AccountPictures?
    private var task: Task<Void, Never>?

    public init(size: CGFloat) {
        super.init(frame: .zero)
        contentMode = .scaleAspectFill
        clipsToBounds = true
        layer.cornerRadius = size / 2
        isUserInteractionEnabled = false
        // No URL yet: hidden, as `show` leaves it for none. A first
        // `show(nil, …)` changes nothing and returns before setting it.
        isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Shows `url`'s picture from `pictures`, the thumbhash until it comes.
    public func show(_ url: URL?, thumbhash: String?, from pictures: AccountPictures?) {
        guard url != self.url || thumbhash != self.thumbhash || pictures !== self.pictures else { return }
        task?.cancel()
        task = nil
        self.url = url
        self.thumbhash = thumbhash
        self.pictures = pictures
        isHidden = url == nil
        image = nil
        guard let url, let pictures else { return }
        if let cached = pictures.cachedImage(url) {
            image = cached
            return
        }
        image = thumbhash.flatMap(pictures.cachedPlaceholderImage)
        task = Task { @MainActor [weak self] in
            if self?.image == nil, let thumbhash, let placeholder = await pictures.placeholderImage(thumbhash) {
                guard !Task.isCancelled, let self, self.isShowing(url, from: pictures) else { return }
                if self.image == nil { self.image = placeholder }
            }
            let image = await pictures.image(url)
            guard !Task.isCancelled, let self, self.isShowing(url, from: pictures), let image else { return }
            self.image = image
        }
    }

    private func isShowing(_ url: URL, from pictures: AccountPictures) -> Bool {
        self.url == url && self.pictures === pictures
    }
}

/// A generated avatar as a picture, for a row's 29pt icon slot.
@MainActor
enum AvatarSnapshot {
    static func image(_ content: AvatarView.Content, size: CGFloat, traits: UITraitCollection) -> UIImage {
        let view = AvatarView(frame: CGRect(x: 0, y: 0, width: size, height: size))
        view.content = content
        view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat(for: traits)
        return UIGraphicsImageRenderer(size: view.bounds.size, format: format).image { context in
            traits.performAsCurrent {
                view.layer.render(in: context.cgContext)
            }
        }
    }
}

/// The revealed secret key under Settings › Account › Backup: tap to copy.
public final class SecretKeyCardView: UIControl {
    let label = StyledLabel(style: TextStyles.secretKeyLabel, color: Palette.textSecondary, lines: 1)
    let iconView = UIImageView()
    let valueLabel = StyledLabel(style: TextStyles.secretKeyValue, color: Palette.text)
    public var onCopy: (() -> Void)?

    public var copiedRecently = false {
        didSet { updateIcon() }
    }

    public init(formattedKey: String) {
        super.init(frame: .zero)
        label.string = Strings.SettingsAccount.secretKeyLabel
        valueLabel.string = formattedKey
        iconView.contentMode = .center
        for view in [label, iconView, valueLabel] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        updateIcon()
        isAccessibilityElement = true
        accessibilityLabel = Strings.SettingsAccount.secretKeyLabel
        accessibilityTraits = .button
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> SecretKeyCardLayout {
        SecretKeyCardLayout(width: width, label: label.measurable, value: valueLabel.measurable)
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        label.setLayoutFrame(layout.label)
        iconView.setLayoutFrame(layout.icon)
        valueLabel.setLayoutFrame(layout.value)
    }

    public override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : nil }
    }

    private func updateIcon() {
        iconView.image = .icon(.ionicons(copiedRecently ? "checkmark-circle" : "copy-outline"), size: 18)
        iconView.tintColor = UIColor(copiedRecently ? Palette.iconGreen : Palette.textSecondary)
    }

    @objc private func tapped() {
        onCopy?()
    }
}

/// A user-bubble swatch (settings/appearance.tsx `BubbleColorPreview`): a
/// glass pill with two lines in the preset's indicator colour.
public final class BubblePreviewView: UIView {
    public var color: BubbleColor {
        didSet { if color != oldValue { apply() } }
    }

    private let lines = BubblePreviewLayout.lines.map { _ in UIView() }

    public init(color: BubbleColor) {
        self.color = color
        super.init(frame: CGRect(origin: .zero, size: BubblePreviewLayout.size))
        layer.cornerRadius = BubblePreviewLayout.cornerRadius
        layer.borderWidth = BubblePreviewLayout.borderWidth
        clipsToBounds = true
        isUserInteractionEnabled = false
        for line in lines {
            line.layer.cornerRadius = BubblePreviewLayout.lineHeight / 2
            addSubview(line)
        }
        apply()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.apply()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        BubblePreviewLayout.size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        for (line, frame) in zip(lines, BubblePreviewLayout.lines) {
            line.setLayoutFrame(frame)
        }
    }

    private func apply() {
        let palette = color.palette
        backgroundColor = UIColor(palette.glass.background)
        layer.borderColor = UIColor(palette.glass.border).resolvedColor(with: traitCollection).cgColor
        for line in lines {
            line.backgroundColor = UIColor(palette.indicator)
        }
    }
}

extension BubbleColor {
    /// utils/userMessageBubbleColor.ts's presets.
    public var palette: BubblePalette {
        switch self {
        case .gray: .gray
        case .blue: .blue
        case .green: .green
        case .purple: .purple
        case .rose: .rose
        case .sand: .sand
        }
    }
}

/// A dropdown's current value in a row's trailing slot: a preview, the
/// value's name and an up or down chevron.
public final class DropdownValueView: UIView {
    public var text: String {
        get { label.string }
        set { label.string = newValue; setNeedsLayout() }
    }

    public var isExpanded = false {
        didSet { updateChevron() }
    }

    let preview: UIView
    let previewSize: CGSize
    let label = StyledLabel(style: TextStyles.dropdownValue, color: Palette.textSecondary, lines: 1)
    let chevron = UIImageView()

    public init(preview: UIView, previewSize: CGSize, text: String) {
        self.preview = preview
        self.previewSize = previewSize
        super.init(frame: .zero)
        chevron.tintColor = UIColor(Palette.groupedChevron)
        chevron.contentMode = .center
        for view in [preview, label, chevron] {
            addSubview(view)
        }
        // The row takes the tap.
        isUserInteractionEnabled = false
        label.string = text
        updateChevron()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout() -> DropdownValueLayout {
        DropdownValueLayout(preview: previewSize, label: label.measurable)
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout().size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout()
        preview.setLayoutFrame(layout.preview)
        label.setLayoutFrame(layout.label)
        chevron.setLayoutFrame(layout.chevron)
    }

    public override var accessibilityLabel: String? {
        get { label.string }
        set {}
    }

    private func updateChevron() {
        chevron.image = .icon(.ionicons(isExpanded ? "chevron-up" : "chevron-down"), size: DropdownValueLayout.Metrics.chevronSize)
    }
}

/// One choice under an open dropdown: preview, name, and a check on the
/// selected one.
public final class OptionRowView: UIControl {
    let preview: UIView
    let previewSize: CGSize
    let titleLabel = StyledLabel(style: TextStyles.optionTitle, color: Palette.text, lines: 1)
    let check = UIImageView()
    private let selectedChoice: Bool
    private let onTap: () -> Void

    public init(preview: UIView, previewSize: CGSize, title: String, selected: Bool, onTap: @escaping () -> Void) {
        self.preview = preview
        self.previewSize = previewSize
        self.selectedChoice = selected
        self.onTap = onTap
        super.init(frame: .zero)
        titleLabel.string = title
        check.image = .icon(.ionicons("checkmark-circle"), size: OptionRowLayout.Metrics.checkSize)
        check.tintColor = UIColor(Palette.statusConnecting)
        check.contentMode = .center
        check.isHidden = !selected
        for view in [preview, titleLabel, check] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        updateBackground()
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = selected ? [.button, .selected] : .button
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> OptionRowLayout {
        OptionRowLayout(width: width, preview: previewSize, title: titleLabel.measurable)
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        preview.setLayoutFrame(layout.preview)
        titleLabel.setLayoutFrame(layout.title)
        check.setLayoutFrame(layout.check)
    }

    public override var isHighlighted: Bool {
        didSet { updateBackground() }
    }

    private func updateBackground() {
        if isHighlighted {
            backgroundColor = UIColor(Palette.optionPressed)
        } else {
            backgroundColor = selectedChoice ? UIColor(Palette.optionSelected) : nil
        }
    }

    @objc private func tapped() {
        onTap()
    }
}

/// An open dropdown's options, stacked.
public final class OptionListView: UIView {
    let options: [OptionRowView]

    public init(options: [OptionRowView]) {
        self.options = options
        super.init(frame: .zero)
        for option in options {
            addSubview(option)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> OptionListLayout {
        OptionListLayout(width: width, rows: options.map(\.measurable))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        for (option, frame) in zip(options, layout(width: bounds.width).rows) {
            option.setLayoutFrame(frame)
        }
    }
}

/// Toggle rows that survive a rebuild of their page, so a switch the person
/// just flipped finishes its animation instead of being replaced.
@MainActor
final class SettingsToggleRows {
    private var rows: [String: ItemRowView] = [:]

    func row(
        _ key: String,
        title: String,
        subtitle: String? = nil,
        icon: ItemIcon? = nil,
        isOn: Bool,
        onChange: @escaping (Bool) -> Void
    ) -> ItemRowView {
        guard let row = rows[key] else {
            let row = ItemRowView.toggle(title: title, subtitle: subtitle, icon: icon, isOn: isOn, onChange: onChange)
            rows[key] = row
            return row
        }
        if row.title != title { row.title = title }
        if row.subtitle != subtitle { row.subtitle = subtitle }
        if row.icon != icon { row.icon = icon }
        if let toggle = row.trailingView as? UISwitch, toggle.isOn != isOn {
            toggle.setOn(isOn, animated: true)
        }
        return row
    }
}

/// What's New's navigation title: the words and the mouse on the phone.
public final class ChangelogTitleView: UIView {
    let label = StyledLabel(style: TextStyles.changelogNavigationTitle, color: Palette.headerTint, lines: 1)
    let imageView = UIImageView(image: .happy("mouse-on-the-phone.webp"))

    public init(title: String) {
        super.init(frame: .zero)
        label.string = title
        imageView.contentMode = .scaleAspectFit
        addSubview(label)
        addSubview(imageView)
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .header
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

    /// The title grows with the text size; the picture keeps its 40pt.
    /// Fitted again in the bar, which keeps its height.
    private func fitTextSize() {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return }
        textScale = scale
        label.updateTraitsIfNeeded()
        invalidateIntrinsicContentSize()
        if frame.size != .zero { frame.size = intrinsicContentSize }
        superview?.setNeedsLayout()
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        ChangelogTitleLayout(title: label.measurable, maxWidth: size.width).size
    }

    public override var intrinsicContentSize: CGSize {
        sizeThatFits(CGSize(width: 240, height: 44))
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = ChangelogTitleLayout(title: label.measurable, maxWidth: bounds.width)
        label.setLayoutFrame(layout.title)
        imageView.setLayoutFrame(layout.image)
    }
}

/// A message centred on the grouped background.
public final class CenteredMessageView: UIView {
    let label: StyledLabel

    public init(message: String, style: TextStyle, color: ColorToken) {
        label = StyledLabel(style: style, color: color, alignment: .center)
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.groupedBackground)
        label.string = message
        addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = CenteredMessageLayout(size: bounds.size, safeArea: LayoutInsets(safeAreaInsets), message: label.measurable)
        label.setLayoutFrame(layout.message)
    }
}

/// settings/connect/claude.tsx `OAuthViewUnsupported`: connecting Claude
/// happens in a terminal, so the screen shows the command.
public final class ConnectCommandView: UIView {
    let titleLabel = StyledLabel(style: TextStyles.connectTitle, color: Palette.text, alignment: .center)
    let bodyLabel = StyledLabel(style: TextStyles.connectBody, color: Palette.textSecondary, alignment: .center)
    let terminal = UIView()
    let commandLabel = UILabel()
    private let command: String

    public init(title: String, body: String, command: String) {
        self.command = command
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.groupedBackground)
        titleLabel.string = title
        bodyLabel.string = body
        // On iOS the glass surface is transparent; only its hairline shows.
        terminal.layer.cornerRadius = ConnectCommandLayout.Metrics.terminalCornerRadius
        terminal.layer.cornerCurve = .continuous
        terminal.clipsToBounds = true
        commandLabel.numberOfLines = 0
        renderCommand()
        commandLabel.accessibilityLabel = command
        addSubview(titleLabel)
        addSubview(bodyLabel)
        addSubview(terminal)
        terminal.addSubview(commandLabel)
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateBorder()
        }
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.renderCommand()
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The command at the size it is drawn at.
    private func renderCommand() {
        let style = traitCollection.textEnvironment.map { TextStyles.connectCommand.scaled($0.scale) } ?? TextStyles.connectCommand
        let text = NSMutableAttributedString(attributedString: style.attributedString("$ ", color: UIColor(Palette.commandPrompt)))
        // happy-app draws it white on a transparent card, which vanishes in
        // light mode; the text colour reads in both (see FEATURES.md).
        text.append(style.attributedString(command, color: UIColor(Palette.text)))
        commandLabel.attributedText = text
    }

    public func layout() -> ConnectCommandLayout {
        ConnectCommandLayout(
            size: bounds.size,
            safeArea: LayoutInsets(safeAreaInsets),
            title: titleLabel.measurable,
            body: bodyLabel.measurable,
            command: commandLabel.measurable
        )
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout()
        titleLabel.setLayoutFrame(layout.title)
        bodyLabel.setLayoutFrame(layout.body)
        terminal.setLayoutFrame(layout.terminal)
        commandLabel.setLayoutFrame(layout.command)
    }

    private func updateBorder() {
        terminal.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
        terminal.layer.borderWidth = hairline
    }
}
#endif
