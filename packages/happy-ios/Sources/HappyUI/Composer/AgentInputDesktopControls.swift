#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

// AgentInput.tsx in a window wider than 700 points: the card is the flat
// `unifiedPanel`, and `desktopActionControls` stand in for its add button,
// chips and round button
//
//     [gear] [stop] [image] ···························· [send]
//
// The text view, its placeholder and the attachment strip stay the card's,
// so the same text, caret and composition carry across the 700-point line.
// Only the chat's composer asks for it (`AgentInputCardConfiguration.desktop`);
// HomeDock.tsx has no such branch. `AgentInputDesktopLayout` places it.

/// The gear's menu (NativeSettingsMenu.ios.tsx with `groups`): a section
/// per choice under its heading, drawn in the order given.
public struct AgentInputSettingsMenu: Equatable, Sendable {
    public struct Section: Equatable, Sendable {
        /// Which choice a pick in it changes.
        public var chip: AgentInputChip
        public var title: String
        /// The SF Symbol beside the heading.
        public var systemImage: String
        public var options: [AgentInputMenu.Option]
        /// The checked row.
        public var selectedKey: String?

        public init(chip: AgentInputChip, title: String, systemImage: String, options: [AgentInputMenu.Option], selectedKey: String?) {
            self.chip = chip
            self.title = title
            self.systemImage = systemImage
            self.options = options
            self.selectedKey = selectedKey
        }
    }

    public var sections: [Section]

    public init(sections: [Section]) {
        self.sections = sections
    }
}

/// What the flat panel's action row shows. The image button is the card's
/// `showsAdd`, blue while pictures are attached.
public struct AgentInputDesktopConfiguration: Equatable, Sendable {
    /// The gear (`onPermissionModeChange`); nil hides it.
    public var settings: AgentInputSettingsMenu?
    /// Stop (`onAbort`): there whenever the agent can be stopped, working
    /// or not.
    public var showsStop: Bool
    /// A spinner instead of the stop glyph, and no presses (`isAborting`).
    public var isStopBusy: Bool
    public var send: AgentInputDesktopSend

    public init(settings: AgentInputSettingsMenu? = nil, showsStop: Bool = false, isStopBusy: Bool = false, send: AgentInputDesktopSend) {
        self.settings = settings
        self.showsStop = showsStop
        self.isStopBusy = isStopBusy
        self.send = send
    }
}

/// The action row's controls, filling the card so their frames are the
/// card's; it takes no touches itself.
final class AgentInputDesktopControlsView: UIView {
    typealias M = AgentInputDesktopLayout.Metrics

    var onSelect: ((String, AgentInputChip) -> Void)?
    var onStop: (() -> Void)?
    var onImage: (() -> Void)?
    var onSend: (() -> Void)?

    /// `actionButtonsLeft`: clips what doesn't fit.
    private let left = UIView()
    private let settingsButton = DesktopSettingsButton()
    private let stopButton = DesktopActionButton(icon: .octicons("stop"), size: M.actionIconSize, tint: Palette.buttonSecondaryTint)
    private let imageButton = DesktopActionButton(icon: .ionicons("image-outline"), size: M.actionIconSize, tint: Palette.buttonSecondaryTint)
    private let sendButton = DesktopSendButton()

    private(set) var configuration: AgentInputDesktopConfiguration?

    override init(frame: CGRect) {
        super.init(frame: frame)
        left.clipsToBounds = true
        addSubview(left)
        settingsButton.accessibilityLabel = Strings.Composer.settingsTitle
        settingsButton.onSelect = { [weak self] key, chip in self?.onSelect?(key, chip) }
        left.addSubview(settingsButton)
        stopButton.accessibilityLabel = Strings.Composer.stop
        stopButton.addTarget(self, action: #selector(stopTapped), for: .touchUpInside)
        left.addSubview(stopButton)
        imageButton.addTarget(self, action: #selector(imageTapped), for: .touchUpInside)
        left.addSubview(imageButton)
        sendButton.accessibilityLabel = Strings.Composer.send
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        addSubview(sendButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self || hit === left ? nil : hit
    }

    /// What the stop button shows, for the layout: its glyph or spinner.
    var stopContentWidth: CGFloat {
        configuration?.isStopBusy == true ? M.spinnerSize : stopButton.glyphSize.width
    }

    var imageContentWidth: CGFloat {
        imageButton.glyphSize.width
    }

    func configure(_ configuration: AgentInputDesktopConfiguration, showsImage: Bool, hasAttachments: Bool, imageAccessibilityLabel: String) {
        self.configuration = configuration
        settingsButton.isHidden = configuration.settings == nil
        settingsButton.settings = configuration.settings
        stopButton.isHidden = !configuration.showsStop
        stopButton.busy = configuration.isStopBusy
        imageButton.isHidden = !showsImage
        // `selectedImages.length > 0`: radio.active, else the secondary tint.
        imageButton.tint = hasAttachments ? Palette.radioActive : Palette.buttonSecondaryTint
        imageButton.accessibilityLabel = imageAccessibilityLabel
        sendButton.send = configuration.send
    }

    func place(_ layout: AgentInputDesktopLayout) {
        if let frame = layout.left {
            left.isHidden = false
            left.setLayoutFrame(frame)
        } else {
            left.isHidden = true
        }
        let content = layout.leftContent
        if let frame = content.settings { settingsButton.setLayoutFrame(frame) }
        if let frame = content.stop { stopButton.setLayoutFrame(frame) }
        if let frame = content.image { imageButton.setLayoutFrame(frame) }
        sendButton.setLayoutFrame(layout.send)
    }

    /// Only stop shakes on a stop that failed (`shakerRef`).
    func shakeStop() {
        AgentInputCardView.shake(stopButton)
    }

    @objc private func stopTapped() {
        onStop?()
    }

    @objc private func imageTapped() {
        onImage?()
    }

    @objc private func sendTapped() {
        onSend?()
    }
}

/// A Pressable that only dims while pressed (`opacity: pressed ? 0.7 : 1`),
/// with the row's `hitSlop` of 5 above and 10 below.
class DesktopPressable: UIControl {
    /// What dims; the control's own fill stays.
    var pressedContent: [UIView] = []

    override var isHighlighted: Bool {
        didSet {
            let alpha = isHighlighted && isEnabled ? AgentInputDesktopLayout.Metrics.pressedOpacity : 1
            for view in pressedContent { view.alpha = alpha }
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let slop = AgentInputDesktopLayout.Metrics.actionHitSlop
        return CGRect(
            x: bounds.minX - slop.left,
            y: bounds.minY - slop.top,
            width: bounds.width + slop.left + slop.right,
            height: bounds.height + slop.top + slop.bottom
        ).contains(point)
    }
}

/// Stop and image: a 16-point glyph 8 in from either side, or a spinner.
final class DesktopActionButton: DesktopPressable {
    private let iconView: IconView
    private let spinner = UIActivityIndicatorView(style: .medium)

    var tint: ColorToken {
        didSet { applyColors() }
    }

    var busy = false {
        didSet {
            guard busy != oldValue else { return }
            // `disabled={isAborting}`.
            isEnabled = !busy
            iconView.isHidden = busy
            if busy { spinner.startAnimating() } else { spinner.stopAnimating() }
        }
    }

    var glyphSize: CGSize { iconView.sizeThatFits(.zero) }

    init(icon: Icon, size: CGFloat, tint: ColorToken) {
        iconView = IconView(icon, size: size)
        self.tint = tint
        super.init(frame: .zero)
        addSubview(iconView)
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        pressedContent = [iconView, spinner]
        isAccessibilityElement = true
        accessibilityTraits = .button
        applyColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func applyColors() {
        iconView.tintColor = UIColor(tint)
        spinner.color = UIColor(tint)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        iconView.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

/// The gear: Octicons `gear` 16 in a 40-point square that opens the
/// settings menu, with no press state of its own (the SwiftUI Menu over
/// the glyph has none).
final class DesktopSettingsButton: UIButton {
    var onSelect: ((String, AgentInputChip) -> Void)?

    var settings: AgentInputSettingsMenu? {
        didSet {
            guard settings != oldValue else { return }
            menu = settings.map(makeMenu)
        }
    }

    private let iconView = IconView(
        .octicons("gear"),
        size: AgentInputDesktopLayout.Metrics.actionIconSize,
        tint: Palette.buttonSecondaryTint
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(iconView)
        showsMenuAsPrimaryAction = true
        // Listed top-down in our order, as happy-app gets it by reversing
        // the rows the upward menu reverses again.
        preferredMenuElementOrder = .fixed
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func makeMenu(_ settings: AgentInputSettingsMenu) -> UIMenu {
        let sections: [UIMenuElement] = settings.sections.map { section in
            let chip = section.chip
            let actions = section.options.map { option in
                UIAction(
                    title: option.label,
                    attributes: option.isDisabled ? .disabled : [],
                    state: option.key == section.selectedKey ? .on : .off
                ) { [weak self] _ in
                    self?.onSelect?(option.key, chip)
                }
            }
            return UIMenu(
                title: section.title,
                image: UIImage(systemName: section.systemImage),
                options: .displayInline,
                children: actions
            )
        }
        return UIMenu(children: sections)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        iconView.frame = bounds
    }
}

/// `sendButton`: 32 round, filled by the send's state; the press dims the
/// glyph, not the fill.
final class DesktopSendButton: DesktopPressable {
    private let iconView = IconView(size: AgentInputDesktopLayout.Metrics.sendIconSize)
    private let spinner = UIActivityIndicatorView(style: .medium)

    var send = AgentInputDesktopSend(hasText: false, hasComposerContent: false, isSendBlocked: false) {
        didSet {
            guard send != oldValue else { return }
            apply()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        addSubview(iconView)
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        pressedContent = [iconView, spinner]
        isAccessibilityElement = true
        accessibilityTraits = .button
        apply()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        isEnabled = send.isEnabled
        switch send.glyph {
        case .spinner:
            iconView.isHidden = true
            spinner.startAnimating()
        case .lock:
            spinner.stopAnimating()
            iconView.isHidden = false
            iconView.icon = .ionicons("lock-closed")
            iconView.size = AgentInputDesktopLayout.Metrics.lockIconSize
        case .arrow:
            spinner.stopAnimating()
            iconView.isHidden = false
            iconView.icon = .octicons("arrow-up")
            iconView.size = AgentInputDesktopLayout.Metrics.sendIconSize
        }
        applyColors()
    }

    private func applyColors() {
        layer.borderWidth = 0
        switch send.fill {
        case .locked:
            backgroundColor = UIColor(Palette.surfaceHigh)
            layer.borderWidth = 1
            layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        case .active:
            backgroundColor = UIColor(Palette.composerSendFill)
        case .inactive:
            backgroundColor = UIColor(Palette.composerSendDisabled)
        }
        iconView.tintColor = UIColor(send.glyph == .lock ? Palette.textSecondary : Palette.composerSendIcon)
        spinner.color = UIColor(Palette.composerSendIcon)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        iconView.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}
#endif
