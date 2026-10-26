#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Home's resting dock (HomeDock.tsx with focus mode closed): a frosted
/// capsule holding the prompt and a send button, over a scrim that rises
/// from the screen's foot. A tap on the capsule opens the composer; the
/// button sends what was typed there. It fills home and takes touches only
/// on the capsule; `HomeDockLayout` places everything. Its text follows
/// the person's text size in a capsule that keeps its 56, cut at the
/// capsule as `composerSurface`'s `overflow: 'hidden'` cuts it.
final class HomeDockView: UIView {
    let scrim = HeaderScrimView(edge: .bottom)
    let entryButton = UIControl()
    let sendButton = HomeDockSendButton()
    private let shell = UIView()
    private let surface = UIView()
    private let material = PartialBlurView(fraction: ComposerShadow.materialFraction)
    private let frosted = UIView()
    /// The capsule's shape over the entry, which cuts a line taller than
    /// the capsule; it takes no touches of its own.
    private let entryClip = UIView()
    private let entryLabel = StyledLabel(style: TextStyles.homeDockEntry, color: Palette.textSecondary, lines: 1)
    private var composerFrame: CGRect = .zero

    /// How present the capsule's surface is, 0 to 1, while the dock fades
    /// in (`HomeDockFade`): the blur by strength, the shadow and the rim by
    /// opacity, the frost by alpha.
    private(set) var presence: CGFloat = 1 {
        didSet { if presence != oldValue { applyPresence() } }
    }
    /// How present the prompt, the send button and the scrim are (the
    /// scrim's blur by strength). Neither this view nor the capsule's shell
    /// takes either: an ancestor below full alpha turns the blur inside off
    /// (HomeDock.tsx:166).
    private(set) var contentPresence: CGFloat = 1 {
        didSet { if contentPresence != oldValue { applyPresence() } }
    }
    private var fade: (run: HomeDockFade, start: CFTimeInterval)?
    private var fadeLink: CADisplayLink?

    /// What was typed in the composer; the placeholder while empty.
    var prompt = "" {
        didSet { if prompt != oldValue { applyPrompt() } }
    }

    /// The heights made off the main thread for the dock; the entry's line
    /// comes from here once it is for the text size this view draws at.
    var text: HomeDockText? {
        didSet { if text != oldValue { setNeedsLayout() } }
    }

    /// Drawn in the capsule just before send at the size it fits (Stem
    /// Cells' model control); the entry gives up its room.
    var accessory: UIView? {
        didSet {
            guard accessory !== oldValue else { return }
            oldValue?.removeFromSuperview()
            if let accessory { addSubview(accessory) }
            applyPresence()
            setNeedsLayout()
        }
    }

    /// The scrim shows only over a list that can scroll under it.
    var showsScrim = false {
        didSet { scrim.isHidden = !showsScrim }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        // HomeDock.tsx's prompt is a Text, which scales; the capsule keeps
        // its 56.
        traitOverrides.followsTextSize = true
        scrim.isHidden = true
        addSubview(scrim)
        shell.layer.shadowColor = UIColor(Palette.shadow).cgColor
        addSubview(shell)
        surface.clipsToBounds = true
        surface.layer.cornerCurve = .continuous
        shell.addSubview(surface)
        material.clipsToBounds = true
        surface.addSubview(material)
        frosted.backgroundColor = UIColor(Palette.composerFrostedOverlay)
        frosted.isUserInteractionEnabled = false
        surface.addSubview(frosted)
        entryLabel.isAccessibilityElement = false
        entryButton.addSubview(entryLabel)
        entryButton.isAccessibilityElement = true
        entryButton.accessibilityTraits = .button
        entryButton.accessibilityIdentifier = "home-dock-entry"
        entryClip.clipsToBounds = true
        entryClip.layer.cornerCurve = .continuous
        entryClip.addSubview(entryButton)
        addSubview(entryClip)
        addSubview(sendButton)
        applyPrompt()
        applyAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyAppearance()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The capsule, in this view.
    var fieldFrame: CGRect {
        layoutIfNeeded()
        return composerFrame
    }

    /// Only the capsule takes touches; the list scrolls everywhere else.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        composerFrame.contains(point)
    }

    private func applyPrompt() {
        entryLabel.string = prompt.isEmpty ? Strings.Home.dockPlaceholder : prompt
        entryLabel.color = prompt.isEmpty ? Palette.textSecondary : Palette.text
        entryButton.accessibilityLabel = entryLabel.string
        setNeedsLayout()
    }

    private func applyAppearance() {
        let dark = traitCollection.userInterfaceStyle == .dark
        shell.layer.shadowOffset = CGSize(width: 0, height: dark ? ComposerShadow.darkOffsetY : ComposerShadow.lightOffsetY)
        shell.layer.shadowRadius = dark ? ComposerShadow.darkRadius : ComposerShadow.lightRadius
        surface.layer.borderWidth = hairline
        applyPresence()
    }

    private func applyPresence() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let border = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shell.layer.shadowOpacity = (dark ? ComposerShadow.darkOpacity : ComposerShadow.lightOpacity) * Float(presence)
        surface.layer.borderColor = border.withAlphaComponent(border.cgColor.alpha * presence).cgColor
        CATransaction.commit()
        material.presence = presence
        frosted.alpha = presence
        scrim.presence = contentPresence
        entryClip.alpha = contentPresence
        sendButton.presence = contentPresence
        accessory?.alpha = contentPresence
    }

    /// Runs `fade`, or shows the dock in full at once when it is nil.
    func fadeIn(_ fade: HomeDockFade?) {
        guard let fade else { return finishFade() }
        self.fade = (fade, CACurrentMediaTime())
        apply(fade.presence(at: 0))
        if fadeLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(fadeTick))
            link.add(to: .main, forMode: .common)
            fadeLink = link
        }
    }

    /// Ends a fade where it would have ended: in full.
    func finishFade() {
        fadeLink?.invalidate()
        fadeLink = nil
        fade = nil
        apply((1, 1))
    }

    private func apply(_ presence: (surface: CGFloat, content: CGFloat)) {
        self.presence = presence.surface
        contentPresence = presence.content
    }

    @objc private func fadeTick() {
        guard let fade else { return finishFade() }
        let elapsed = CACurrentMediaTime() - fade.start
        apply(fade.run.presence(at: elapsed))
        if fade.run.isFinished(at: elapsed) { finishFade() }
    }

    /// A dock that leaves the screen mid-fade is in full when it is back.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil, fade != nil { finishFade() }
    }

    /// One line of the entry at its text size, from the heights made off
    /// the main thread; the label measures itself only until they land.
    private var entry: Measurable {
        guard let text, text.key.text == TextEnvironment(traitCollection) else { return entryLabel.measurable }
        return HomeDockText.line(entryLabel, text.entryLine)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = HomeDockLayout(.init(
            size: bounds.size,
            safeBottom: safeAreaInsets.bottom,
            hairline: hairline,
            entry: entry,
            accessory: accessory.map { $0.isHidden ? .zero : $0.sizeThatFits(bounds.size) } ?? .zero
        ))
        composerFrame = layout.composer
        scrim.setLayoutFrame(layout.scrim)
        shell.setLayoutFrame(layout.composer)
        let radius = layout.composer.height / 2
        shell.layer.shadowPath = UIBezierPath(roundedRect: shell.bounds, cornerRadius: radius).cgPath
        surface.frame = shell.bounds
        surface.layer.cornerRadius = radius
        material.frame = surface.bounds
        frosted.frame = surface.bounds
        entryClip.setLayoutFrame(layout.composer)
        entryClip.layer.cornerRadius = radius
        entryButton.setLayoutFrame(layout.entry.offsetBy(dx: -layout.composer.minX, dy: -layout.composer.minY))
        entryLabel.setLayoutFrame(layout.entryText.offsetBy(dx: -layout.entry.minX, dy: -layout.entry.minY))
        sendButton.setLayoutFrame(layout.send)
        accessory?.setLayoutFrame(layout.accessory)
    }
}

/// The dock's round send button (`sendButton`): grey and dimmed with
/// nothing to send, filled once there is, a spinner while sending.
final class HomeDockSendButton: ComposerPressableButton {
    enum Appearance {
        case idle
        case send
        case busy
    }

    var appearance: Appearance = .idle {
        didSet { if appearance != oldValue { apply() } }
    }

    /// The dock's fade (`HomeDockView.contentPresence`), under the press's 0.7.
    var presence: CGFloat = 1 {
        didSet { if presence != oldValue { pressedAlphaChanged(isHighlighted && isEnabled) } }
    }

    private let iconView = IconView(.ionicons("arrow-up"), size: HomeDockLayout.Metrics.sendIconSize)
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(iconView)
        spinner.hidesWhenStopped = true
        spinner.color = UIColor(Palette.textSecondary)
        addSubview(spinner)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.Composer.send
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func pressedAlphaChanged(_ pressed: Bool) {
        alpha = (pressed ? 0.7 : 1) * presence
    }

    private func apply() {
        isEnabled = appearance == .send
        backgroundColor = UIColor(appearance == .send ? Palette.composerNewSessionPrimaryFill : Palette.surfaceHighest)
        iconView.tintColor = UIColor(appearance == .send ? Palette.composerNewSessionPrimaryIcon : Palette.textSecondary)
        if appearance == .busy {
            spinner.startAnimating()
            iconView.isHidden = true
        } else {
            spinner.stopAnimating()
            iconView.isHidden = false
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        iconView.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

/// One picker row over the open composer (HomeDock.tsx `renderPickerRow`):
/// an Ionicon in a 24pt box, then the native menu's trigger, which draws
/// the value in the system's body font. The help row, which is a link and
/// not a menu, draws its value in the app's own font.
final class HomeDockRowView: UIView {
    let iconView = IconView(size: HomeDockFocusLayout.Metrics.iconSize, tint: Palette.text)
    let trigger = UIButton(type: .custom)
    let valueLabel = UILabel()
    /// Laid over the row while a session starts: a press shakes the row
    /// instead of opening the menu (`FocusConfigRevealRow`'s blocker).
    let blocker = UIControl()
    private var localLayout: HomeDockFocusLayout.Row?

    /// A link rather than a menu: the value is the app's text.
    var isLink = false {
        didSet { if isLink != oldValue { applyValue() } }
    }

    var value = "" {
        didSet { if value != oldValue { applyValue() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(iconView)
        valueLabel.numberOfLines = 1
        valueLabel.lineBreakMode = .byTruncatingTail
        valueLabel.adjustsFontForContentSizeCategory = true
        valueLabel.isUserInteractionEnabled = false
        trigger.addSubview(valueLabel)
        // The menus open in the system's own order, as SwiftUI's do.
        trigger.preferredMenuElementOrder = .automatic
        addSubview(trigger)
        blocker.isHidden = true
        addSubview(blocker)
        applyValue()
        // The link's value is the app's text, at the person's text size;
        // the menu's is the system's body font, which follows on its own.
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            guard self.isLink else { return }
            self.applyValue()
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var refusing = false {
        didSet {
            blocker.isHidden = !refusing
            trigger.isUserInteractionEnabled = !refusing
        }
    }

    private func applyValue() {
        if isLink {
            let style = traitCollection.textEnvironment.map { TextStyles.homeDockRowValue.scaled($0.scale) } ?? TextStyles.homeDockRowValue
            valueLabel.attributedText = style.attributedString(value, color: UIColor(Palette.text), lineBreakMode: .byTruncatingTail)
        } else {
            valueLabel.attributedText = nil
            valueLabel.font = UIFont.preferredFont(forTextStyle: .body)
            valueLabel.textColor = UIColor(Palette.text)
            valueLabel.text = value
        }
        setNeedsLayout()
    }

    /// The row's frames, in its own space.
    func apply(_ row: HomeDockFocusLayout.Row) {
        let origin = row.frame.origin
        localLayout = HomeDockFocusLayout.Row(
            frame: CGRect(origin: .zero, size: row.frame.size),
            icon: row.icon.offsetBy(dx: -origin.x, dy: -origin.y),
            trigger: row.trigger.offsetBy(dx: -origin.x, dy: -origin.y),
            value: row.value.offsetBy(dx: -origin.x, dy: -origin.y)
        )
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let row = localLayout else { return }
        iconView.setLayoutFrame(row.icon)
        // A link is pressed anywhere on the row; a menu from its trigger,
        // so the icon stays put while the value morphs into the menu.
        trigger.setLayoutFrame(isLink ? row.frame : row.trigger)
        valueLabel.setLayoutFrame(row.value.offsetBy(dx: -trigger.frame.minX, dy: -trigger.frame.minY))
        blocker.frame = bounds
    }

    override var intrinsicContentSize: CGSize {
        valueLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }
}

/// The open composer's backdrop: a faint blur of the list and a strong dim
/// over it (HomeDock.tsx `modalBackdrop`).
final class HomeDockBackdropView: UIView {
    private let blur = PartialBlurView(fraction: HomeDockBackdrop.blurFraction)
    private let dim = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(blur)
        dim.backgroundColor = UIColor(Palette.homeDockBackdropDim)
        dim.isUserInteractionEnabled = false
        addSubview(dim)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        blur.frame = bounds
        dim.frame = bounds
    }
}

#endif
