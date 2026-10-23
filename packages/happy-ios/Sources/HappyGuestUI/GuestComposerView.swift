#if canImport(UIKit)
import HappyChatKit
import HappyIcons
import HappyLayout
import UIKit

/// The session composer's look for a guest (`AgentInputCardView` in its
/// compact card): a frosted card with a hairline rim and the card shadow,
/// the input in the composer face, and the round send button, under the
/// composer's status row (a dot and a line). No attachments, chips, modes
/// or voice: a guest only types. Every frame comes from
/// `AgentInputLayout` and `AgentInputCardLayout`, as the app's do.
final class GuestComposerView: UIView, UITextViewDelegate {
    struct Status: Equatable {
        var text: String
        var color: ColorToken
        var pulsing = false
    }

    var onSend: (() -> Void)?
    /// The height may have changed; the screen lays the composer out again.
    var onHeightChange: (() -> Void)?

    var placeholder = "Message" {
        didSet { placeholderLabel.string = placeholder }
    }

    var status: Status? {
        didSet { if status != oldValue { applyStatus() } }
    }

    /// False keeps the text but takes the caret away (a message waiting to
    /// be confirmed).
    var isEditable = true {
        didSet {
            textView.isEditable = isEditable
            textView.alpha = isEditable ? 1 : 0.58
        }
    }

    var canSend = true {
        didSet { applyPrimary() }
    }

    /// The status row alone, without the card (read only).
    var showsCard = true {
        didSet {
            card.isHidden = !showsCard
            setNeedsLayout()
        }
    }

    var text: String {
        get { textView.text ?? "" }
        set {
            textView.text = newValue
            textChanged()
        }
    }

    private let metrics = MobileComposerMetrics.mobile
    private let statusDot = StatusDotView()
    private let statusLabel = UILabel()
    private let card = UIView()
    private let surface = UIView()
    private let material = PartialBlurView(fraction: ComposerShadow.materialFraction)
    private let frosted = UIView()
    private let textView = UITextView()
    private let placeholderLabel = StyledLabel(style: TextStyles.composerInput, color: Palette.inputPlaceholder, lines: 1)
    private let primary = UIButton(type: .custom)
    private let primaryIcon = IconView(.octicons("arrow-up"), size: AgentInputCardLayout.Metrics.primaryIconSize)
    private var statusSize: CGSize?

    override init(frame: CGRect) {
        super.init(frame: frame)
        statusDot.isUserInteractionEnabled = false
        addSubview(statusDot)
        statusLabel.numberOfLines = 1
        addSubview(statusLabel)

        card.layer.shadowColor = UIColor(Palette.shadow).cgColor
        addSubview(card)
        surface.clipsToBounds = true
        surface.layer.cornerRadius = metrics.shellRadius
        surface.layer.cornerCurve = .continuous
        card.addSubview(surface)
        material.clipsToBounds = true
        surface.addSubview(material)
        frosted.backgroundColor = UIColor(Palette.composerFrostedOverlay)
        frosted.isUserInteractionEnabled = false
        surface.addSubview(frosted)

        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: metrics.inputPaddingTop, left: 0, bottom: metrics.inputPaddingBottom, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.font = TextStyles.composerInput.font
        textView.typingAttributes = TextStyles.composerInput.attributes(color: UIColor(Palette.inputText))
        textView.textColor = UIColor(Palette.inputText)
        textView.tintColor = UIColor(Palette.radioActive)
        textView.isScrollEnabled = false
        textView.delegate = self
        textView.accessibilityIdentifier = "guest.message"
        surface.addSubview(textView)
        placeholderLabel.string = placeholder
        placeholderLabel.isUserInteractionEnabled = false
        placeholderLabel.accessibilityIdentifier = "guest.placeholder"
        surface.addSubview(placeholderLabel)

        primary.accessibilityIdentifier = "guest.send"
        primary.accessibilityLabel = "Send"
        primary.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        primaryIcon.isUserInteractionEnabled = false
        primary.addSubview(primaryIcon)
        surface.addSubview(primary)

        applyStatus()
        applyPrimary()
        applyAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyAppearance()
            self.applyPrimary()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var isTextFocused: Bool { textView.isFirstResponder }
    func blur() { textView.resignFirstResponder() }

    // MARK: Layout

    private func layout(width: CGFloat) -> AgentInputLayout {
        let textHeight = textView.sizeThatFits(CGSize(width: textWidth(cardWidth: AgentInputLayout.innerWidth(
            width: width, paddingH: AgentInputLayout.Metrics.containerPaddingH, maxContentWidth: .greatestFiniteMagnitude
        )), height: .greatestFiniteMagnitude)).height
        return AgentInputLayout(.init(
            width: width,
            statusText: statusSize,
            card: AgentInputCardLayout.Input(
                width: 0, metrics: metrics, borderWidth: hairline, textContentHeight: textHeight, hasText: textView.hasText
            )
        ))
    }

    /// The text's wrapping width in a card `width` wide.
    private func textWidth(cardWidth width: CGFloat) -> CGFloat {
        AgentInputCardLayout(.init(width: width, metrics: metrics, borderWidth: hairline, textContentHeight: 0, hasText: false)).text.width
    }

    func composerHeight(fitting width: CGFloat) -> CGFloat {
        let layout = layout(width: width)
        guard showsCard else { return (layout.status?.frame.maxY ?? 0) + AgentInputLayout.Metrics.containerPaddingBottom }
        return layout.size.height
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        if let row = layout.status {
            statusDot.setLayoutFrame(row.dot)
            statusLabel.setLayoutFrame(row.text)
        }
        card.setLayoutFrame(layout.card)
        card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: metrics.shellRadius).cgPath
        surface.frame = card.bounds
        material.frame = surface.bounds
        frosted.frame = surface.bounds
        guard let cardLayout = layout.cardLayout else { return }
        textView.setLayoutFrame(cardLayout.text)
        textView.isScrollEnabled = cardLayout.textScrolls
        placeholderLabel.setLayoutFrame(CGRect(
            x: cardLayout.text.minX, y: cardLayout.text.minY + metrics.inputPaddingTop,
            width: cardLayout.text.width, height: TextStyles.composerInput.lineHeightValue
        ))
        primary.setLayoutFrame(cardLayout.primary)
        primary.layer.cornerRadius = cardLayout.primary.height / 2
        primaryIcon.frame = primary.bounds
    }

    // MARK: Appearance

    private func applyStatus() {
        statusDot.isHidden = status == nil
        statusLabel.isHidden = status == nil
        guard let status else {
            statusSize = nil
            return
        }
        statusLabel.attributedText = TextStyles.composerStatus.attributedString(status.text, color: UIColor(status.color), lineBreakMode: .byTruncatingTail)
        statusSize = statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        statusDot.backgroundColor = UIColor(status.color)
        statusDot.isPulsing = status.pulsing
        setNeedsLayout()
    }

    /// ComposerPrimaryButton: send on the raised fill once there is text,
    /// the inactive fill while there is none.
    private func applyPrimary() {
        let active = canSend && textView.hasText
        primary.isEnabled = canSend
        primary.backgroundColor = UIColor(active ? Palette.surfaceHighest : Palette.composerPrimaryInactive)
        primaryIcon.tintColor = UIColor(active ? Palette.text : Palette.textSecondary)
    }

    private func applyAppearance() {
        let dark = traitCollection.userInterfaceStyle == .dark
        card.layer.shadowOffset = CGSize(width: 0, height: dark ? ComposerShadow.darkOffsetY : ComposerShadow.lightOffsetY)
        card.layer.shadowRadius = dark ? ComposerShadow.darkRadius : ComposerShadow.lightRadius
        card.layer.shadowOpacity = dark ? ComposerShadow.darkOpacity : ComposerShadow.lightOpacity
        surface.layer.borderWidth = hairline
        surface.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
    }

    // MARK: Text

    private func textChanged() {
        placeholderLabel.isHidden = textView.hasText
        applyPrimary()
        onHeightChange?()
    }

    func textViewDidChange(_ textView: UITextView) { textChanged() }

    @objc private func sendTapped() { onSend?() }
}

/// The name field before joining: the composer's card around one line.
final class GuestNameField: UIView {
    let field = UITextField()
    private let surface = UIView()
    private let material = PartialBlurView(fraction: ComposerShadow.materialFraction)
    private let frosted = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.shadowColor = UIColor(Palette.shadow).cgColor
        surface.clipsToBounds = true
        surface.layer.cornerCurve = .continuous
        addSubview(surface)
        material.clipsToBounds = true
        surface.addSubview(material)
        frosted.backgroundColor = UIColor(Palette.composerFrostedOverlay)
        frosted.isUserInteractionEnabled = false
        surface.addSubview(frosted)
        field.font = TextStyles.composerInput.font
        field.textColor = UIColor(Palette.inputText)
        field.tintColor = UIColor(Palette.radioActive)
        field.attributedPlaceholder = TextStyles.composerInput.attributedString("Your name", color: UIColor(Palette.inputPlaceholder))
        field.textContentType = .name
        field.autocapitalizationType = .words
        field.autocorrectionType = .no
        field.returnKeyType = .join
        field.accessibilityIdentifier = "guest.name"
        surface.addSubview(field)
        applyAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyAppearance() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = bounds.height / 2
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
        surface.frame = bounds
        surface.layer.cornerRadius = radius
        material.frame = bounds
        frosted.frame = bounds
        field.frame = bounds.insetBy(dx: radius * 0.75, dy: 0)
    }

    private func applyAppearance() {
        let dark = traitCollection.userInterfaceStyle == .dark
        layer.shadowOffset = CGSize(width: 0, height: dark ? ComposerShadow.darkOffsetY : ComposerShadow.lightOffsetY)
        layer.shadowRadius = dark ? ComposerShadow.darkRadius : ComposerShadow.lightRadius
        layer.shadowOpacity = dark ? ComposerShadow.darkOpacity : ComposerShadow.lightOpacity
        surface.layer.borderWidth = hairline
        surface.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
    }
}
#endif
