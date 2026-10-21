#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// MobileGlassSurface with `nativeEffect` on the liquid material: Liquid
/// Glass where iOS has it, else the ultra-thin blur expo-blur stands in
/// with; a diagonal sheen over either, clipped to the corners inside a
/// hairline rim. An unclipped shell carries the drop shadow.
final class LiquidGlassView: UIView {
    struct Shadow {
        var offsetY: CGFloat
        var radius: CGFloat
    }

    /// Put content here: it sits over the sheen.
    let contentView = UIView()
    var cornerRadius: CGFloat = 0 {
        didSet { setNeedsLayout() }
    }

    private let clip = UIView()
    private let effect: UIView
    private let sheen = CAGradientLayer()
    private let regular: Bool
    private let tint: ColorToken
    private let fill: ColorToken?
    private let border: ColorToken?
    private let shadow: Shadow?
    /// The glass is applied once the view is in a window and laid out, as
    /// expo-glass-effect does: an effect made earlier doesn't render.
    private var glassApplied = false

    /// `regular` is expo's `glassEffectStyle="regular"`; the default is
    /// `clear`. `fill` is a background under the effect.
    init(regular: Bool = false, tint: ColorToken, fill: ColorToken? = nil, border: ColorToken?, shadow: Shadow?) {
        self.regular = regular
        self.tint = tint
        self.fill = fill
        self.border = border
        self.shadow = shadow
        if #available(iOS 26.0, *) {
            effect = UIVisualEffectView(effect: nil)
        } else {
            effect = PartialBlurView(fraction: NewSessionMaterial.glassFallbackFraction)
        }
        super.init(frame: .zero)
        clip.clipsToBounds = true
        addSubview(clip)
        effect.isUserInteractionEnabled = false
        clip.addSubview(effect)
        sheen.startPoint = CGPoint(x: 0, y: 0)
        sheen.endPoint = CGPoint(x: 1, y: 1)
        sheen.locations = SecondaryPalette.sheenLocations.map { NSNumber(value: $0) }
        clip.layer.addSublayer(sheen)
        clip.addSubview(contentView)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
            self.applyGlass()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            glassApplied = false
        } else {
            setNeedsLayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = min(cornerRadius, bounds.height / 2)
        clip.frame = bounds
        clip.layer.cornerRadius = radius
        effect.frame = clip.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sheen.frame = clip.bounds
        CATransaction.commit()
        contentView.frame = clip.bounds
        clip.layer.borderWidth = border == nil ? 0 : hairline
        if shadow != nil {
            layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
        }
        if window != nil && !glassApplied {
            glassApplied = true
            applyGlass()
        }
        if #available(iOS 26.0, *), let glass = effect as? UIVisualEffectView {
            glass.cornerConfiguration = .corners(radius: .fixed(Double(radius)))
        }
    }

    private func applyGlass() {
        guard #available(iOS 26.0, *), glassApplied, let view = effect as? UIVisualEffectView else { return }
        // GlassView's `colorScheme` follows the app's theme. The effect is
        // cleared first, or a replaced one doesn't render.
        view.overrideUserInterfaceStyle = traitCollection.userInterfaceStyle
        let glass = UIGlassEffect(style: regular ? .regular : .clear)
        glass.tintColor = UIColor(tint).resolvedColor(with: traitCollection)
        view.effect = UIVisualEffect()
        view.effect = glass
    }

    private func applyColors() {
        clip.backgroundColor = fill.map { UIColor($0) }
        sheen.colors = SecondaryPalette.sheen.map { UIColor($0).resolvedColor(with: traitCollection).cgColor }
        if let border {
            clip.layer.borderColor = UIColor(border).resolvedColor(with: traitCollection).cgColor
        }
        if let shadow {
            // glass.shadow carries its own alpha; the opacity is 1.
            layer.shadowColor = UIColor(Palette.glassShadow).resolvedColor(with: traitCollection).cgColor
            layer.shadowOpacity = 1
            layer.shadowOffset = CGSize(width: 0, height: shadow.offsetY)
            layer.shadowRadius = shadow.radius
        }
    }
}

/// The header's title: "Start New Session" in the glass capsule the home
/// header's controls use, beside the system back button (Header.tsx's
/// `mobileTitlePill`, started at the leading edge on a phone).
final class NewSessionTitleView: UIView {
    private let glass = HeaderGlassView()
    let label = StyledLabel(style: TextStyles.headerTitle, color: Palette.text, lines: 1)

    /// `mobileTitlePill`'s padding.
    static let paddingHorizontal: CGFloat = 14

    init(title: String) {
        super.init(frame: .zero)
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        label.string = title
        glass.addSubview(label)
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .header
        // Header.tsx's pill title is a Text, which scales; the capsule
        // keeps its 44 and grows as wide as the title. It sits in the bar,
        // outside the screen's views, so it follows on its own.
        traitOverrides.followsTextSize = true
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.frame.size = self.sizeThatFits(.zero)
            self.invalidateIntrinsicContentSize()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let text = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        return CGSize(width: ceil(text.width) + 2 * Self.paddingHorizontal, height: HomeHeaderLayout.Metrics.controlSize)
    }

    override var intrinsicContentSize: CGSize {
        sizeThatFits(.zero)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        let text = label.sizeThatFits(CGSize(width: max(0, bounds.width - 2 * Self.paddingHorizontal), height: .greatestFiniteMagnitude))
        label.setLayoutFrame(CGRect(
            x: Self.paddingHorizontal,
            y: (bounds.height - text.height) / 2,
            width: max(0, bounds.width - 2 * Self.paddingHorizontal),
            height: text.height
        ))
    }
}

/// A place row (`configRow`): a 15pt glyph, the value in one line, a
/// chevron. Pressing fades it; it never scales.
final class NewSessionConfigRowView: UIControl {
    let iconView = IconView(size: NewSessionScreenLayout.Metrics.rowIconSize, tint: Palette.textSecondary)
    let label = StyledLabel(style: TextStyles.newSessionRow, color: Palette.text, lines: 1)
    private let chevron = IconView(.ionicons("chevron-down"), size: NewSessionScreenLayout.Metrics.rowChevronSize, tint: Palette.textSecondary)

    init(icon: Icon) {
        super.init(frame: .zero)
        iconView.icon = icon
        for view in [iconView, label, chevron] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        layer.cornerRadius = NewSessionScreenLayout.Metrics.rowRadius
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var value: String {
        get { label.string }
        set {
            label.string = newValue
            accessibilityLabel = newValue
        }
    }

    func apply(_ frame: NewSessionScreenLayout.RowFrame) {
        setLayoutFrame(frame.frame)
        iconView.setLayoutFrame(frame.icon)
        label.setLayoutFrame(frame.label)
        if let chevronFrame = frame.chevron { chevron.setLayoutFrame(chevronFrame) }
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? NewSessionMaterial.pressedOpacity : 1 }
    }
}

/// "Machine is offline" and what to try (`offlineHelp`).
final class NewSessionOfflineView: UIView {
    private let icon = IconView(.ionicons("cloud-offline-outline"), size: NewSessionScreenLayout.Metrics.offlineIconSize, tint: Palette.statusDisconnected)
    let title = StyledLabel(style: TextStyles.newSessionOfflineTitle, color: Palette.statusDisconnected)
    let body = StyledLabel(style: TextStyles.newSessionOfflineBody, color: Palette.textSecondary)

    override init(frame: CGRect) {
        super.init(frame: frame)
        title.string = Strings.NewSession.machineOffline
        for view in [icon, title, body] {
            addSubview(view)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ frame: NewSessionScreenLayout.RowFrame) {
        setLayoutFrame(frame.frame)
        icon.setLayoutFrame(frame.icon)
        title.setLayoutFrame(frame.label)
        if let bodyFrame = frame.body { body.setLayoutFrame(bodyFrame) }
    }
}

/// A round control in the composer's row: a glyph in a 38pt circle that
/// swells and fades when pressed (BubblePressable).
final class NewSessionComposerButton: ComposerPressableButton {
    private let iconView: IconView

    init(icon: Icon, size: CGFloat) {
        iconView = IconView(icon, size: size, tint: Palette.textSecondary)
        super.init(frame: .zero)
        addSubview(iconView)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The popover it opened is showing (`composerControlActive`).
    var isActive = false {
        didSet { backgroundColor = isActive ? UIColor(Palette.optionSelected) : nil }
    }

    override func pressedAlphaChanged(_ pressed: Bool) {
        alpha = pressed ? NewSessionMaterial.pressedOpacity : 1
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        iconView.frame = bounds
    }
}

/// The harness button (`composerAgentButton`): its logo, its name and a
/// chevron in a 36pt capsule.
final class NewSessionAgentButton: UIControl {
    private let logo = UIImageView()
    let label = StyledLabel(style: TextStyles.newSessionAgent, color: Palette.buttonSecondaryTint, lines: 1)
    private let chevron = IconView(.ionicons("chevron-down"), size: NewSessionComposerLayout.Metrics.agentChevronSize, tint: Palette.textSecondary)

    override init(frame: CGRect) {
        super.init(frame: frame)
        logo.contentMode = .scaleAspectFit
        logo.tintColor = UIColor(Palette.textSecondary)
        for view in [logo, label, chevron] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        layer.cornerRadius = NewSessionComposerLayout.Metrics.agentHeight / 2
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func update(key: String, label text: String) {
        logo.image = UIImage.happy(Self.logo(key))?.withRenderingMode(.alwaysTemplate)
        label.string = text
        accessibilityLabel = Strings.NewSession.agent(text)
    }

    /// new/index.tsx's `agentIcons`.
    static func logo(_ key: String) -> String {
        switch key {
        case "rig": "logo-black"
        case "codex": "icon-gpt"
        case "agy": "icon-agy"
        default: "icon-claude"
        }
    }

    var isActive = false {
        didSet { backgroundColor = isActive ? UIColor(Palette.optionSelected) : nil }
    }

    func apply(_ layout: NewSessionComposerLayout) {
        logo.setLayoutFrame(layout.agentIcon)
        label.setLayoutFrame(layout.agentLabel)
        chevron.setLayoutFrame(layout.agentChevron)
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? NewSessionMaterial.pressedOpacity : 1 }
    }
}

/// Send (`mobileSendButton`): Liquid Glass with a light rim while it can
/// be pressed; a bare rim at 56% while it can't; a spinner while a session
/// starts.
final class NewSessionSendButton: ComposerPressableButton {
    private let glass = LiquidGlassView(tint: Palette.glassTint, border: nil, shadow: nil)
    private let rim = UIView()
    private let arrow = IconView(.octicons("arrow-up"), size: NewSessionComposerLayout.Metrics.sendIconSize, tint: Palette.text)
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        glass.isUserInteractionEnabled = false
        addSubview(glass)
        rim.isUserInteractionEnabled = false
        rim.backgroundColor = .clear
        addSubview(rim)
        addSubview(arrow)
        spinner.hidesWhenStopped = true
        spinner.color = UIColor(Palette.text)
        addSubview(spinner)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.Composer.send
        apply()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.rim.layer.borderColor = UIColor(Palette.glassHighlight).resolvedColor(with: self.traitCollection).cgColor
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var canSend = false {
        didSet { if canSend != oldValue { apply() } }
    }

    var isBusy = false {
        didSet { if isBusy != oldValue { apply() } }
    }

    private func apply() {
        isEnabled = canSend
        // Glass only while it can be pressed (`nativeEffect = interactive`).
        glass.isHidden = !canSend
        alpha = canSend ? 1 : NewSessionMaterial.sendInactiveOpacity
        if isBusy {
            spinner.startAnimating()
            arrow.isHidden = true
        } else {
            spinner.stopAnimating()
            arrow.isHidden = false
        }
    }

    override func pressedAlphaChanged(_ pressed: Bool) {
        // `sendButtonInnerPressed` fades the glyph, not the glass.
        arrow.alpha = pressed ? 0.7 : 1
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = bounds.height / 2
        layer.cornerRadius = radius
        glass.frame = bounds
        glass.cornerRadius = radius
        rim.frame = bounds
        rim.layer.cornerRadius = radius
        rim.layer.borderWidth = hairline
        rim.layer.borderColor = UIColor(Palette.glassHighlight).resolvedColor(with: traitCollection).cgColor
        arrow.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

/// The phone composer (`mobileInputBox`): the prompt, then the harness,
/// settings, the microphone and Send, in a glass card with a soft shadow.
final class NewSessionComposerView: UIView, UITextViewDelegate {
    let glass = LiquidGlassView(
        tint: Palette.glassTint,
        border: Palette.glassBorder,
        shadow: .init(offsetY: NewSessionMaterial.composerShadowOffsetY, radius: NewSessionMaterial.composerShadowRadius)
    )
    /// TextKit 2, as RN's `RCTUITextView` is, in the TextKit 1 height
    /// measured off the main thread (`ComposerTextMeasure`): its text sits
    /// inside, and Writing Tools gets its inline experience. Never ask it
    /// for its `layoutManager`, which turns it into TextKit 1.
    let textView = UITextView(usingTextLayoutManager: true)
    private let placeholder = StyledLabel(style: TextStyles.composerInput, color: Palette.inputPlaceholder, lines: 1)
    let agentButton = NewSessionAgentButton()
    let settingsButton = NewSessionComposerButton(icon: .ionicons("settings-outline"), size: NewSessionComposerLayout.Metrics.settingsIconSize)
    let micButton = NewSessionComposerButton(icon: .ionicons("mic-outline"), size: NewSessionComposerLayout.Metrics.micIconSize)
    let sendButton = NewSessionSendButton()

    var onTextChange: ((String) -> Void)?
    /// The text grew or shrank a line.
    var onHeightChange: (() -> Void)?

    var showsSettings = true {
        didSet { if showsSettings != oldValue { setNeedsLayout() } }
    }

    /// The text's heights, measured off the main thread
    /// (`ComposerTextHeights`).
    private var textHeights = ComposerTextHeights()
    private var measuring: Task<Void, Never>?
    /// Moves on every change to the text, so a measured height is checked
    /// without reading the text.
    private var textRevision = 0
    /// Moves when the draft replaces the text rather than an edit.
    private var textGeneration = 0
    /// The input's width and the text's height `layout(width:)` last gave.
    private var laidOut: (width: CGFloat, height: CGFloat)?
    /// The height the memo held for the text `setText` brought, for that
    /// text's revision: filed at the first layout whose key is the one it
    /// was measured for, and at no other.
    private var seed: (revision: Int, key: ComposerTextHeights.Key, height: CGFloat)?
    /// The draft as last measured, kept for the account
    /// (`AccountSession.newSessionDraftHeight`, closed when it stops): a
    /// draft that comes back unchanged opens at its height. Its own until
    /// the screen hands it its account's.
    var heights = MeasuredDraftMemo()
    /// The screen's label sizes, measured off the main thread at its text
    /// size; nil measures the harness's name on the label.
    weak var sizes: MeasuredLabelSizes?

    private var agentLabel: Measurable {
        sizes?.measurable(agentButton.label) ?? agentButton.label.measurable
    }
    /// The text size and screen the prompt draws at, under
    /// `FollowsTextSize`; nil at the designed size.
    private var textEnvironment: TextEnvironment?

    /// `composerInput` at the text size: 16 on a 22 line, both × RN's
    /// multiplier. The 120 cap and the 44 minimum stay.
    private var inputStyle: TextStyle {
        textEnvironment.map { TextStyles.composerInput.scaled($0.scale) } ?? TextStyles.composerInput
    }

    /// One line of the prompt: at a text size `22 × m` up to the screen's
    /// next pixel, as Fabric ceils a TextInput's measured box
    /// (`RCTTextLayoutManager.mm` 391-392), so the frame it is given is on
    /// the pixel grid and isn't rounded down under its text.
    private var inputLineHeight: CGFloat {
        textEnvironment.map { TextStyles.composerInput.oneLine(in: $0) } ?? NewSessionComposerLayout.Metrics.lineHeight
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(glass)
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = false
        textView.font = inputStyle.font
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        textView.tintColor = UIColor(Palette.radioActive)
        textView.delegate = self
        glass.contentView.addSubview(textView)
        placeholder.isUserInteractionEnabled = false
        placeholder.isAccessibilityElement = false
        glass.contentView.addSubview(placeholder)
        settingsButton.accessibilityLabel = Strings.NewSession.settings
        micButton.accessibilityLabel = Strings.NewSession.voiceInput
        for view in [agentButton, settingsButton, micButton, sendButton] as [UIView] {
            glass.contentView.addSubview(view)
        }
        // The line ends on the screen's pixels, so a new screen moves it too.
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.textSizeMayHaveChanged()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        textSizeMayHaveChanged()
    }

    /// Takes up the text size the traits now give; true if it moved. The
    /// typed text is drawn again in place, its selection kept.
    @discardableResult
    private func syncTextSize() -> Bool {
        let environment = traitCollection.textEnvironment
        guard environment != textEnvironment else { return false }
        textEnvironment = environment
        textView.font = inputStyle.font
        let selection = textView.selectedRange
        if textView.hasText {
            textView.attributedText = inputStyle.attributedString(text, color: UIColor(Palette.inputText))
            textView.selectedRange = selection
        }
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        return true
    }

    /// A new text size: the prompt is measured again at it (its key holds
    /// the scaled style), and the screen lays out again.
    private func textSizeMayHaveChanged() {
        guard syncTextSize() else { return }
        onHeightChange?()
        setNeedsLayout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var placeholderText: String {
        get { placeholder.string }
        set { placeholder.string = newValue }
    }

    var text: String {
        textView.text ?? ""
    }

    /// The draft's text, when it changed somewhere else.
    func setText(_ text: String) {
        guard text != self.text, textView.markedTextRange == nil else { return }
        textGeneration += 1
        syncTextSize()
        textView.attributedText = inputStyle.attributedString(text, color: UIColor(Palette.inputText))
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        // `textChanged` moves the revision to this text's.
        seed = heights.entry(for: text).flatMap { entry in
            (entry.key as? ComposerTextHeights.Key).map { (textRevision + 1, $0, CGFloat(entry.height)) }
        }
        textChanged(report: false)
    }

    func layout(width: CGFloat) -> NewSessionComposerLayout {
        let hairline = self.hairline
        let inputWidth = inputWidth(for: width)
        let height = textHeight(inputWidth: inputWidth)
        laidOut = (inputWidth, height)
        return NewSessionComposerLayout(.init(
            width: width,
            hairline: hairline,
            textHeight: height,
            agentLabel: agentLabel,
            showsSettings: showsSettings,
            lineHeight: inputLineHeight
        ))
    }

    private func inputWidth(for width: CGFloat) -> CGFloat {
        typealias M = NewSessionComposerLayout.Metrics
        return max(0, width - 2 * hairline - M.paddingLeft - M.paddingRight - M.fieldPaddingLeft - M.fieldPaddingRight)
    }

    /// The text's height at the input's width, as measured off the main
    /// thread, or a guess until it is, which starts the measurement: the
    /// last height measured at the width, else one line.
    private func textHeight(inputWidth: CGFloat) -> CGFloat {
        let stamp = textStamp(inputWidth: inputWidth)
        if let seed {
            if seed.revision != textRevision {
                self.seed = nil
            } else if seed.key == stamp.key {
                self.seed = nil
                textHeights.seed(stamp, height: seed.height)
            }
        }
        let lookup = textHeights.lookup(stamp, isEmpty: !textView.hasText)
        if let measure = lookup.measure {
            startMeasuring(measure)
        }
        return lookup.height
    }

    private func textStamp(inputWidth: CGFloat) -> ComposerTextHeights.Stamp {
        typealias M = NewSessionComposerLayout.Metrics
        // Measured before its first trait update: measure what it will draw.
        syncTextSize()
        let key = ComposerTextHeights.Key(
            width: inputWidth,
            style: inputStyle,
            lineHeight: inputLineHeight,
            paddingTop: 0,
            paddingBottom: 0,
            maxHeight: M.inputMaxHeight
        )
        return ComposerTextHeights.Stamp(key: key, revision: textRevision, generation: textGeneration)
    }

    /// Measures the text as it is now off the main thread. Copying it out
    /// is the one pass over it made here.
    private func startMeasuring(_ stamp: ComposerTextHeights.Stamp) {
        let job = ComposerTextMeasure(
            stamp: stamp,
            text: text,
            attributes: stamp.key.style.attributes(color: UIColor(Palette.inputText))
        )
        measuring = Task { [weak self] in
            let height = await Task.detached(priority: .userInitiated) { job.run() }.value
            self?.measured(stamp, text: job.text, height: height)
        }
    }

    private func measured(_ stamp: ComposerTextHeights.Stamp, text: String, height: CGFloat) {
        measuring = nil
        let live = ComposerTextHeights.Live(revision: textRevision, generation: textGeneration, isEmpty: !textView.hasText)
        let finish = textHeights.finish(stamp, height: height, live: live)
        if stamp.revision == textRevision {
            heights.keep(text, key: stamp.key, height: Double(height))
        }
        if let next = finish.measure {
            startMeasuring(next)
        }
        // The screen lays out again; nothing animates.
        if finish.changed {
            onHeightChange?()
            setNeedsLayout()
        }
    }

    /// Returns once the text's height is measured (tests).
    func textMeasured() async {
        while let measuring {
            await measuring.value
        }
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        glass.frame = bounds
        glass.cornerRadius = NewSessionComposerLayout.Metrics.radius
        textView.setLayoutFrame(layout.input)
        if textView.isScrollEnabled != layout.textScrolls {
            textView.isScrollEnabled = layout.textScrolls
        }
        let line = inputLineHeight
        placeholder.setLayoutFrame(CGRect(x: layout.input.minX, y: layout.input.minY, width: layout.input.width, height: line))
        placeholder.isHidden = textView.hasText
        agentButton.setLayoutFrame(layout.agent)
        agentButton.apply(layout)
        settingsButton.isHidden = layout.settings == nil
        if let frame = layout.settings { settingsButton.setLayoutFrame(frame) }
        micButton.setLayoutFrame(layout.mic)
        sendButton.setLayoutFrame(layout.send)
    }

    func textViewDidChange(_ textView: UITextView) {
        textChanged(report: true)
    }

    private func textChanged(report: Bool) {
        textRevision += 1
        // Against what the screen laid out before: the new text's height
        // is its measured one, or the guess that stands until it lands.
        let before = laidOut
        let inputWidth = inputWidth(for: bounds.width)
        let after = bounds.width > 0 ? textHeight(inputWidth: inputWidth) : nil
        placeholder.isHidden = textView.hasText
        if report { onTextChange?(text) }
        if let after, before?.width != inputWidth || before?.height != after { onHeightChange?() }
        setNeedsLayout()
    }
}

/// The glass popover a picker opens in, with the soft blur around it
/// (LocalBlurHalo). Its rows come from `NewSessionPickerContent`.
final class NewSessionPickerView: UIView {
    let glass = LiquidGlassView(
        regular: true,
        tint: Palette.glassOverlayTint,
        fill: Palette.glassOverlay,
        border: Palette.glassBorder,
        shadow: .init(offsetY: NewSessionMaterial.popoverShadowOffsetY, radius: NewSessionMaterial.popoverShadowRadius)
    )
    private let halo = UIView()
    private let haloBlur = PartialBlurView(fraction: NewSessionMaterial.haloFraction)
    private let haloDim = UIView()
    private let haloMask = CALayer()
    let content: NewSessionPickerContentView

    init(content: NewSessionPickerContentView) {
        self.content = content
        super.init(frame: .zero)
        halo.isUserInteractionEnabled = false
        halo.addSubview(haloBlur)
        haloDim.backgroundColor = UIColor(Palette.pickerHaloDim)
        halo.addSubview(haloDim)
        haloMask.backgroundColor = UIColor.white.cgColor
        haloMask.shadowColor = UIColor.white.cgColor
        haloMask.shadowOpacity = 1
        haloMask.shadowOffset = .zero
        haloMask.shadowRadius = NewSessionPickerLayout.Metrics.haloFeather
        let maskHost = CALayer()
        maskHost.addSublayer(haloMask)
        halo.layer.mask = maskHost
        addSubview(halo)
        glass.cornerRadius = NewSessionPickerLayout.Metrics.radius
        addSubview(glass)
        glass.contentView.addSubview(content)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let expansion = NewSessionPickerLayout.Metrics.haloExpansion
        halo.frame = bounds.insetBy(dx: -expansion, dy: -expansion)
        haloBlur.frame = halo.bounds
        haloDim.frame = halo.bounds
        halo.layer.mask?.frame = halo.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        haloMask.frame = halo.bounds.insetBy(dx: expansion, dy: expansion)
        haloMask.cornerRadius = NewSessionPickerLayout.Metrics.radius
        CATransaction.commit()
        glass.frame = bounds
        let padding = UIEdgeInsets(
            top: NewSessionPickerLayout.Metrics.paddingVertical,
            left: NewSessionPickerLayout.Metrics.paddingHorizontal,
            bottom: NewSessionPickerLayout.Metrics.paddingVertical,
            right: NewSessionPickerLayout.Metrics.paddingHorizontal
        )
        content.frame = glass.contentView.bounds.inset(by: padding)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.contains(point)
    }
}

/// One row of a picker (`embeddedOption`): a glyph, a label with an
/// optional line under it, an optional trailing glyph.
final class NewSessionOptionRow: UIControl {
    let iconView: IconView
    let label: StyledLabel
    let detail: StyledLabel?
    let trailing: IconView?
    let iconSize: CGFloat
    let trailingSize: CGFloat?

    struct Text {
        var string: String
        var style: TextStyle
        var color: ColorToken
        /// 0 wraps.
        var lines: Int

        static func option(_ string: String) -> Text {
            Text(string: string, style: TextStyles.newSessionOption, color: Palette.text, lines: 1)
        }

        static func detail(_ string: String) -> Text {
            Text(string: string, style: TextStyles.newSessionOptionDetail, color: Palette.textSecondary, lines: 1)
        }
    }

    init(icon: Icon, iconSize: CGFloat, iconTint: ColorToken, label: Text, detail: Text?, trailing: Icon? = nil, trailingSize: CGFloat? = nil, trailingTint: ColorToken = Palette.text) {
        iconView = IconView(icon, size: iconSize, tint: iconTint)
        self.iconSize = iconSize
        self.label = StyledLabel(style: label.style, color: label.color, lines: label.lines)
        self.label.string = label.string
        self.detail = detail.map {
            let view = StyledLabel(style: $0.style, color: $0.color, lines: $0.lines)
            view.string = $0.string
            return view
        }
        self.trailing = trailing.map { IconView($0, size: trailingSize ?? 16, tint: trailingTint) }
        self.trailingSize = trailing == nil ? nil : trailingSize
        super.init(frame: .zero)
        for view in [iconView, self.label, self.detail, self.trailing].compactMap({ $0 as UIView? }) {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = [label.string, detail?.string].compactMap { $0 }.joined(separator: ", ")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var element: NewSessionPickerContentLayout.Element {
        element { $0.measurable }
    }

    /// The row with its labels measured by `measure`.
    func element(_ measure: (StyledLabel) -> Measurable) -> NewSessionPickerContentLayout.Element {
        .option(icon: iconSize, label: measure(label), detail: detail.map(measure), trailing: trailingSize)
    }

    func apply(_ frame: NewSessionPickerContentLayout.ElementFrame) {
        setLayoutFrame(frame.frame)
        if let icon = frame.icon { iconView.setLayoutFrame(icon) }
        if let labelFrame = frame.label { label.setLayoutFrame(labelFrame) }
        if let detailFrame = frame.detail { detail?.setLayoutFrame(detailFrame) }
        if let trailingFrame = frame.trailing { trailing?.setLayoutFrame(trailingFrame) }
    }

    var isDimmed = false {
        didSet { applyAlpha() }
    }

    override var isHighlighted: Bool {
        didSet { applyAlpha() }
    }

    private func applyAlpha() {
        alpha = (isDimmed ? NewSessionMaterial.dimmedOpacity : 1) * (isHighlighted ? NewSessionMaterial.pressedOpacity : 1)
    }
}

/// A one-line field with a glyph before it: the search row, or the path.
final class NewSessionFieldRow: UIView {
    let iconView: IconView
    let field = UITextField()
    let isPath: Bool
    private let placeholder: String

    /// `newSessionOption` at the text size where the screen follows it.
    private var style: TextStyle {
        traitCollection.textEnvironment.map { TextStyles.newSessionOption.scaled($0.scale) } ?? TextStyles.newSessionOption
    }

    private func applyTextSize() {
        field.font = style.font
        field.attributedPlaceholder = style.attributedString(placeholder, color: UIColor(Palette.textSecondary))
    }

    init(icon: Icon, placeholder: String, isPath: Bool) {
        iconView = IconView(icon, size: NewSessionPickerContentLayout.Metrics.searchIconSize, tint: Palette.textSecondary)
        self.isPath = isPath
        self.placeholder = placeholder
        super.init(frame: .zero)
        addSubview(iconView)
        field.textColor = UIColor(Palette.text)
        field.tintColor = UIColor(Palette.radioActive)
        applyTextSize()
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.applyTextSize()
            self.setNeedsLayoutUpTheTree()
        }
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = isPath ? .done : .default
        addSubview(field)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The field's one line, as a single-line TextInput sizes it: the
    /// font's line at the text size, up to the screen's pixel (a font
    /// metric, no text laid out).
    var fieldHeight: CGFloat {
        traitCollection.textEnvironment.map { TextStyles.newSessionOption.oneLine(in: $0) } ?? ceil(TextStyles.newSessionOption.font.lineHeight)
    }

    var element: NewSessionPickerContentLayout.Element {
        isPath ? .pathField(fieldHeight: fieldHeight) : .search(fieldHeight: fieldHeight)
    }

    func apply(_ frame: NewSessionPickerContentLayout.ElementFrame) {
        setLayoutFrame(frame.frame)
        if let icon = frame.icon { iconView.setLayoutFrame(icon) }
        if let label = frame.label { field.setLayoutFrame(label) }
    }
}

/// A settings page's header: back, and the page's title.
final class NewSessionBackRow: UIView {
    let back = NewSessionComposerButton(icon: .ionicons("chevron-back"), size: NewSessionPickerContentLayout.Metrics.backIconSize)
    let title = StyledLabel(style: TextStyles.newSessionPickerTitle, color: Palette.text, lines: 1)

    init(title text: String) {
        super.init(frame: .zero)
        back.accessibilityLabel = Strings.Common.back
        addSubview(back)
        title.string = text
        addSubview(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var element: NewSessionPickerContentLayout.Element {
        element { $0.measurable }
    }

    func element(_ measure: (StyledLabel) -> Measurable) -> NewSessionPickerContentLayout.Element {
        .back(title: measure(title))
    }

    func apply(_ frame: NewSessionPickerContentLayout.ElementFrame) {
        setLayoutFrame(frame.frame)
        if let icon = frame.icon { back.setLayoutFrame(icon) }
        if let label = frame.label { title.setLayoutFrame(label) }
    }
}

/// The rows of one picker: a few fixed at the top, the rest in a list that
/// scrolls past 176pt. Built by the screen for each picker and page.
final class NewSessionPickerContentView: UIView {
    @MainActor
    enum Row {
        case option(NewSessionOptionRow)
        case field(NewSessionFieldRow)
        case text(StyledLabel)
        case divider(UIView)
        case empty(StyledLabel)
        case back(NewSessionBackRow)

        var view: UIView {
            switch self {
            case .option(let row): row
            case .field(let row): row
            case .text(let label): label
            case .divider(let view): view
            case .empty(let label): label
            case .back(let row): row
            }
        }

        var element: NewSessionPickerContentLayout.Element {
            element { $0.measurable }
        }

        /// The element with its labels measured by `measure`.
        func element(_ measure: (StyledLabel) -> Measurable) -> NewSessionPickerContentLayout.Element {
            switch self {
            case .option(let row): row.element(measure)
            case .field(let row): row.element
            case .text(let label): .text(measure(label))
            case .divider: .divider
            case .empty(let label): .empty(measure(label))
            case .back(let row): row.element(measure)
            }
        }

        func apply(_ frame: NewSessionPickerContentLayout.ElementFrame) {
            switch self {
            case .option(let row): row.apply(frame)
            case .field(let row): row.apply(frame)
            case .text(let label), .empty(let label):
                if let labelFrame = frame.label {
                    label.setLayoutFrame(labelFrame.offsetBy(dx: frame.frame.minX, dy: frame.frame.minY))
                }
            case .divider(let view): view.setLayoutFrame(frame.frame)
            case .back(let row): row.apply(frame)
            }
        }
    }

    private(set) var header: [Row] = []
    private(set) var list: [Row] = []
    private let scrollView = UIScrollView()
    var listMaxHeight: CGFloat? = NewSessionPickerContentLayout.Metrics.listMaxHeight
    var paddingTop: CGFloat = 0
    var paddingBottom: CGFloat = NewSessionPickerContentLayout.Metrics.embeddedPaddingBottom
    /// The screen's label sizes, measured off the main thread at its text
    /// size; nil measures the labels themselves.
    weak var sizes: MeasuredLabelSizes?

    override init(frame: CGRect) {
        super.init(frame: frame)
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.alwaysBounceVertical = false
        scrollView.keyboardDismissMode = .none
        addSubview(scrollView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Replaces the rows. Header views that are handed back keep their
    /// place, so a focused field stays focused.
    func setRows(header: [Row], list: [Row]) {
        let keep = Set(header.map { ObjectIdentifier($0.view) })
        for row in self.header where !keep.contains(ObjectIdentifier(row.view)) {
            row.view.removeFromSuperview()
        }
        for row in self.list {
            row.view.removeFromSuperview()
        }
        self.header = header
        self.list = list
        for row in header where row.view.superview !== self {
            addSubview(row.view)
        }
        for row in list {
            scrollView.addSubview(row.view)
        }
        setNeedsLayout()
    }

    func layout(width: CGFloat) -> NewSessionPickerContentLayout {
        let measure: (StyledLabel) -> Measurable = sizes.map { sizes in { sizes.measurable($0) } } ?? { $0.measurable }
        return NewSessionPickerContentLayout(.init(
            width: width,
            header: header.map { $0.element(measure) },
            list: list.map { $0.element(measure) },
            listMaxHeight: listMaxHeight,
            paddingTop: paddingTop,
            paddingBottom: paddingBottom
        ))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        for (row, frame) in zip(header, layout.header) {
            row.apply(frame)
        }
        scrollView.frame = layout.listFrame
        scrollView.contentSize = CGSize(width: layout.listFrame.width, height: layout.listContentHeight)
        for (row, frame) in zip(list, layout.list) {
            row.apply(frame)
        }
    }
}
#endif
