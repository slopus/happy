#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// SidebarNavigator.tsx `PersistentHeader`: zen and back, floating over the
/// sidebar's top and staying put in zen mode. Only the two controls take
/// touches (`pointerEvents="box-none"`); the rest of the row passes them
/// through to whatever is under it.
final class TabletPersistentHeaderView: UIView {
    let zenButton = HitSlopControl()
    let backButton = HitSlopControl()
    private let zenIcon = UIImageView()
    private let backIcon = IconView(.ionicons("chevron-back"), size: TabletShellLayout.Metrics.backIconSize)

    var isZenMode = false {
        didSet { if isZenMode != oldValue { applyColors() } }
    }

    /// Back dims to 0.3 with nothing to go back to.
    var canGoBack = false {
        didSet {
            backButton.isEnabled = canGoBack
            backButton.alpha = canGoBack ? 1 : TabletShellLayout.Metrics.disabledOpacity
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        zenIcon.image = UIImage.happy("zen-icon")?.withRenderingMode(.alwaysTemplate)
        zenIcon.contentMode = .scaleAspectFit
        zenIcon.isUserInteractionEnabled = false
        zenButton.addSubview(zenIcon)
        zenButton.accessibilityLabel = Strings.Tablet.zenToggle
        backIcon.tintColor = UIColor(Palette.headerTint)
        backButton.addSubview(backIcon)
        backButton.accessibilityLabel = Strings.Common.back
        for button in [zenButton, backButton] {
            button.isAccessibilityElement = true
            button.accessibilityTraits = .button
            addSubview(button)
        }
        // didSet doesn't run in the initializer.
        applyColors()
        backButton.isEnabled = false
        backButton.alpha = TabletShellLayout.Metrics.disabledOpacity
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Applies the shell's frames, given in this view's coordinates.
    func apply(zenButton zen: CGRect, zenIcon icon: CGRect, backButton back: CGRect) {
        zenButton.setLayoutFrame(zen)
        zenIcon.setLayoutFrame(icon.offsetBy(dx: -zen.minX, dy: -zen.minY))
        backButton.setLayoutFrame(back)
        backIcon.setLayoutFrame(CGRect(origin: .zero, size: back.size))
    }

    private func applyColors() {
        // The glyph turns the link colour while zen mode is on.
        zenIcon.tintColor = UIColor(isZenMode ? Palette.textLink : Palette.headerTint)
        zenButton.accessibilityTraits = isZenMode ? [.button, .selected] : .button
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

/// A control that also takes touches `hitSlop` points outside its frame.
final class HitSlopControl: UIControl {
    var hitSlop = TabletShellLayout.Metrics.hitSlop

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -hitSlop, dy: -hitSlop).contains(point)
    }
}

/// SidebarView.tsx's New session button: a hairline-framed surface that
/// darkens while pressed. Its label follows the person's text size, and
/// the button grows with it (`TabletSidebarLayout` measures it as drawn).
final class SidebarNewSessionButton: UIControl {
    let icon = IconView(.ionicons("create-outline"), size: TabletSidebarLayout.Metrics.newSessionIconSize)
    let label = StyledLabel(style: TextStyles.sidebarNewSession, color: Palette.text, lines: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        traitOverrides.followsTextSize = true
        label.string = Strings.Tablet.newSession
        label.isUserInteractionEnabled = false
        icon.tintColor = UIColor(Palette.text)
        addSubview(icon)
        addSubview(label)
        layer.cornerRadius = TabletSidebarLayout.Metrics.buttonRadius
        isAccessibilityElement = true
        accessibilityLabel = Strings.Tablet.newSession
        accessibilityTraits = .button
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isHighlighted: Bool {
        didSet { applyColors() }
    }

    private func applyColors() {
        backgroundColor = UIColor(isHighlighted ? Palette.surfacePressed : Palette.surface)
        layer.borderWidth = hairline
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }
}

/// SidebarView.tsx's archive button: shows or hides the archive. Selected
/// (the archive showing) it takes the selected surface and the filled glyph.
final class SidebarArchiveButton: UIControl {
    let icon = IconView(.ionicons("archive-outline"), size: TabletSidebarLayout.Metrics.archiveIconSize)

    /// `hideInactiveSessions`.
    var hidesArchived = true {
        didSet { if hidesArchived != oldValue { apply() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.tintColor = UIColor(Palette.text)
        addSubview(icon)
        layer.cornerRadius = TabletSidebarLayout.Metrics.buttonRadius
        isAccessibilityElement = true
        apply()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isHighlighted: Bool {
        didSet { applyColors() }
    }

    private func apply() {
        icon.icon = .ionicons(hidesArchived ? "archive-outline" : "archive")
        accessibilityLabel = hidesArchived ? Strings.Sidebar.showArchived : Strings.Sidebar.hideArchived
        accessibilityTraits = hidesArchived ? .button : [.button, .selected]
        applyColors()
    }

    private func applyColors() {
        let fill = isHighlighted ? Palette.surfacePressed : hidesArchived ? Palette.surface : Palette.surfaceSelected
        backgroundColor = UIColor(fill)
        layer.borderWidth = hairline
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }
}

/// SidebarView.tsx's Settings row at the foot of the sidebar. It has no
/// pressed look in happy-app either. Its label follows the person's text
/// size, and the row grows with it.
final class SidebarSettingsRow: UIControl {
    let divider = UIView()
    let icon = IconView(.ionicons("settings-outline"), size: TabletSidebarLayout.Metrics.settingsIconSize)
    let label = StyledLabel(style: TextStyles.sidebarSettings, color: Palette.text, lines: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        traitOverrides.followsTextSize = true
        divider.backgroundColor = UIColor(Palette.divider)
        divider.isUserInteractionEnabled = false
        label.string = Strings.Settings.title
        label.isUserInteractionEnabled = false
        icon.tintColor = UIColor(Palette.text)
        for view in [divider, icon, label] { addSubview(view) }
        isAccessibilityElement = true
        accessibilityLabel = Strings.Settings.title
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }
}

/// EmptySessionsTablet.tsx: a glyph, a title, a line of help and, with a
/// computer linked, one filled button. Its text follows the person's text
/// size; the column is measured from it as drawn.
final class TabletEmptySessionsView: UIView {
    let icon = IconView(.ionicons("terminal-outline"), size: TabletEmptySessionsLayout.Metrics.iconSize)
    let titleLabel = StyledLabel(style: TextStyles.tabletEmptyTitle, color: Palette.textSecondary, alignment: .center)
    let descriptionLabel = StyledLabel(style: TextStyles.tabletEmptyDescription, color: Palette.textSecondary, alignment: .center)
    let button = UIControl()
    let buttonIcon = IconView(.ionicons("add"), size: TabletEmptySessionsLayout.Metrics.buttonIconSize)
    let buttonLabel = StyledLabel(style: TextStyles.tabletEmptyButton, color: SecondaryPalette.buttonPrimaryTint)

    var state: TabletEmptySessions = .noMachines {
        didSet { if state != oldValue { apply() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        traitOverrides.followsTextSize = true
        backgroundColor = UIColor(Palette.groupedBackground)
        icon.tintColor = UIColor(Palette.textSecondary)
        titleLabel.accessibilityTraits = .header
        button.backgroundColor = UIColor(SecondaryPalette.buttonPrimary)
        button.layer.cornerRadius = TabletEmptySessionsLayout.Metrics.buttonRadius
        button.isAccessibilityElement = true
        button.accessibilityTraits = .button
        buttonIcon.tintColor = UIColor(SecondaryPalette.buttonPrimaryTint)
        buttonLabel.isUserInteractionEnabled = false
        button.addSubview(buttonIcon)
        button.addSubview(buttonLabel)
        for view in [icon, titleLabel, descriptionLabel, button] { addSubview(view) }
        // didSet doesn't run in the initializer.
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        switch state {
        case .online:
            icon.icon = .ionicons("terminal-outline")
            titleLabel.string = Strings.Tablet.noSessionsTitle
            descriptionLabel.string = Strings.Tablet.onlineDescription
            buttonIcon.icon = .ionicons("add")
            buttonLabel.string = Strings.Tablet.startNewSession
        case .offline(let choices):
            icon.icon = .ionicons("cloud-offline-outline")
            titleLabel.string = choices.count == 1
                ? Strings.Tablet.machineUnreachable(name: choices[0].name)
                : Strings.Tablet.noMachinesReachable
            descriptionLabel.string = Strings.Tablet.offlineDescription
            buttonIcon.icon = .ionicons("help-circle-outline")
            buttonLabel.string = Strings.Tablet.troubleshoot
        case .noMachines:
            icon.icon = .ionicons("terminal-outline")
            titleLabel.string = Strings.Tablet.noSessionsTitle
            descriptionLabel.string = Strings.Tablet.noMachinesDescription
        }
        button.isHidden = !hasButton
        button.accessibilityLabel = buttonLabel.string
        setNeedsLayout()
    }

    private var hasButton: Bool {
        state != .noMachines
    }

    private func layout() -> TabletEmptySessionsLayout {
        TabletEmptySessionsLayout(.init(
            size: bounds.size,
            icon: icon.sizeThatFits(.zero),
            title: titleLabel.measurable,
            description: descriptionLabel.measurable,
            button: hasButton ? .init(icon: buttonIcon.sizeThatFits(.zero), title: buttonLabel.measurable) : nil
        ))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout()
        icon.setLayoutFrame(layout.icon)
        titleLabel.setLayoutFrame(layout.title)
        descriptionLabel.setLayoutFrame(layout.description)
        guard let frame = layout.button, let iconFrame = layout.buttonIcon, let titleFrame = layout.buttonTitle else { return }
        button.setLayoutFrame(frame)
        buttonIcon.setLayoutFrame(iconFrame.offsetBy(dx: -frame.minX, dy: -frame.minY))
        buttonLabel.setLayoutFrame(titleFrame.offsetBy(dx: -frame.minX, dy: -frame.minY))
    }
}
#endif
