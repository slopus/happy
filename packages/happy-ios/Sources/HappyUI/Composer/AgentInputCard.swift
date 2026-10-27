#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

// The compact mobile composer's card, as one reusable view: the attachment
// strip, the growing text input, and the action row
//
//     [+] [ permission ········· model · effort ] [send/stop]
//
// It is AgentInput.tsx's `mobileUnifiedPanel`, which HomeDock.tsx's focused
// composer shares metric for metric (agentInputLayout.ts). The chat's
// composer is one client (`SessionComposerView`); the home dock and the
// new-session screen are others.
//
// The card is configured by a value (`AgentInputCardConfiguration`): which
// chips, which menus, which primary action. It owns the text; everything it
// does is reported to its delegate, which decides what a press means.
// `AgentInputCardLayout` places every subview. The chat's composer in a
// window wider than 700 points makes it the flat panel instead
// (`desktop`, AgentInputDesktopControls.swift), keeping the text view.
//
// Under `FollowsTextSize` (the chat's composer and Home's dock set it)
// its text is drawn at the person's text size as React Native scales it,
// and measured as drawn: the input, its placeholder and line, the
// chips and the "·". Icons, paddings, the 40 and 42 rows, the 44 minimum
// and the 120 cap stay.

/// A chip in the action row.
public enum AgentInputChip: Sendable {
    case permission
    case model
    case effort
}

/// A control in the action row that can refuse a press
/// (`refusesControls`).
public enum AgentInputControl: Sendable {
    case add
    case permission
    case model
    case effort

    init(_ chip: AgentInputChip) {
        switch chip {
        case .permission: self = .permission
        case .model: self = .model
        case .effort: self = .effort
        }
    }
}

/// How the round button is painted.
public enum AgentInputPrimaryStyle: Sendable {
    /// AgentInput.tsx's chat composer: send on `surfaceHighest`, stop black
    /// (light) or #F5F5F5 (dark), idle grey.
    case standard
    /// HomeDock.tsx's focused composer: send and stop share the solid fill
    /// (`sendButtonActive`) with `primaryActionIconColor`; idle is
    /// `surfaceHighest` with a `textSecondary` arrow (Ionicons); busy is a
    /// `textSecondary` spinner on the unfilled button.
    case newSession
}

/// A native menu a chip opens (NativeSettingsMenu.ios.tsx): sections of
/// checkable rows, drawn in the order given.
public struct AgentInputMenu: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public var key: String
        public var label: String
        public var isDisabled: Bool
        /// Grey lines under the label.
        public var subtitle: String?
        /// Checked whatever `selectedKey` says.
        public var isChecked: Bool
        /// Non-empty: the row opens these over the menu instead of
        /// picking (a submenu, stacked over its parent).
        public var children: [Section]

        public init(key: String, label: String, isDisabled: Bool = false, subtitle: String? = nil, isChecked: Bool = false, children: [Section] = []) {
            self.key = key
            self.label = label
            self.isDisabled = isDisabled
            self.subtitle = subtitle
            self.isChecked = isChecked
            self.children = children
        }
    }

    public struct Section: Equatable, Sendable {
        /// The heading above the rows; nil for none.
        public var title: String?
        public var options: [Option]

        public init(title: String? = nil, options: [Option]) {
            self.title = title
            self.options = options
        }
    }

    public var sections: [Section]
    /// The checked row.
    public var selectedKey: String?

    public init(sections: [Section], selectedKey: String?) {
        self.sections = sections
        self.selectedKey = selectedKey
    }
}

extension UIMenu {
    /// `model` as a native menu: each section inline under its heading, a
    /// row with children a submenu stacked over its parent; a pick is its key.
    @MainActor
    convenience init(_ model: AgentInputMenu, onSelect: @escaping (String) -> Void) {
        func elements(_ sections: [AgentInputMenu.Section]) -> [UIMenuElement] {
            let menus: [UIMenuElement] = sections.map { section in
                UIMenu(title: section.title ?? "", options: .displayInline, children: section.options.map { option in
                    if !option.children.isEmpty {
                        let menu = UIMenu(title: option.label, identifier: UIMenu.Identifier(option.key), children: elements(option.children))
                        menu.subtitle = option.subtitle
                        return menu
                    }
                    let action = UIAction(
                        title: option.label,
                        attributes: option.isDisabled ? .disabled : [],
                        state: option.isChecked || option.key == model.selectedKey ? .on : .off
                    ) { _ in onSelect(option.key) }
                    action.subtitle = option.subtitle
                    return action
                })
            }
            if menus.count == 1, let only = menus.first as? UIMenu, only.title.isEmpty { return only.children }
            return menus
        }
        self.init(children: elements(model.sections))
    }

    /// This menu's submenu that is `visible`'s new version (by identifier),
    /// else this menu: what an open menu shows when it is replaced.
    @MainActor
    func replacing(_ visible: UIMenu) -> UIMenu {
        func find(_ menu: UIMenu) -> UIMenu? {
            if menu.identifier == visible.identifier { return menu }
            for case let child as UIMenu in menu.children {
                if let found = find(child) { return found }
            }
            return nil
        }
        return find(self) ?? self
    }
}

/// One chip: what it shows and the menu it opens.
public struct AgentInputChipConfiguration: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case label(String)
        /// A glyph at `AgentInputCardLayout.Metrics.permissionIconSize`
        /// (the permission chip's `shield-outline` when the mode has no name).
        case icon(Icon)
    }

    public var content: Content
    public var accessibilityLabel: String
    /// Nil draws a chip that does nothing, dimmed to 0.58 (a model chip with
    /// no models to pick).
    public var menu: AgentInputMenu?
    /// The chip opens its owner's own picker instead of a menu: a press is
    /// `agentInputCard(_:didPress:)`, and `menu` is not drawn.
    public var opensPicker: Bool

    public init(content: Content, accessibilityLabel: String, menu: AgentInputMenu?, opensPicker: Bool = false) {
        self.content = content
        self.accessibilityLabel = accessibilityLabel
        self.menu = menu
        self.opensPicker = opensPicker
    }
}

/// A picture waiting to be sent, as the strip shows it.
public struct AgentInputAttachmentPreview: Equatable, Sendable {
    public var id: String
    /// A local image file.
    public var fileURL: URL

    public init(id: String, fileURL: URL) {
        self.id = id
        self.fileURL = fileURL
    }
}

/// Everything about the card that is not the text.
public struct AgentInputCardConfiguration: Equatable, Sendable {
    public var placeholder: String
    /// False keeps the card on screen but out of reach: no caret, no
    /// keyboard, the text at 0.58.
    public var isEditable: Bool
    /// The leading add button (`onPickImages`).
    public var showsAdd: Bool
    /// Overrides "Add photo" for VoiceOver ("Add image" on home).
    public var addAccessibilityLabel: String?
    public var attachments: [AgentInputAttachmentPreview]
    /// Nil hides the chip. The model chip shows whenever it is set; the
    /// separator and the effort chip go together.
    public var permission: AgentInputChipConfiguration?
    public var model: AgentInputChipConfiguration?
    public var effort: AgentInputChipConfiguration?
    public var primaryAction: AgentInputPrimaryAction
    /// A spinner instead of the glyph (`isAborting`).
    public var isPrimaryBusy: Bool
    /// Overrides "Send" / "Stop" for VoiceOver ("Create bot" on home).
    public var primaryAccessibilityLabel: String?
    /// `minHeight` for the input container; nil keeps 44.
    public var inputMinHeight: CGFloat?
    public var autocapitalization: UITextAutocapitalizationType
    /// The keyboard's return key ("done" for a bot's name on home).
    public var returnKey: UIReturnKeyType
    public var primaryStyle: AgentInputPrimaryStyle
    /// While true, add and the chips refuse presses: the pressed one shakes
    /// and the delegate hears `agentInputCardDidRefuse`. The primary button
    /// is unaffected (HomeDock's `RefusableControl` while a session starts).
    public var refusesControls: Bool
    /// AgentInput.tsx `zenMode` (the tablet shell's zen control): the add
    /// button and the chips go; the text, any picked pictures and the
    /// round button stay.
    public var zenMode: Bool
    /// The flat panel and its `desktopActionControls`, AgentInput.tsx in a
    /// window wider than 700 points; nil is the compact card. The chips and
    /// the primary action are then unused, `showsAdd` is the image button,
    /// and `refusesControls` is not consulted (only Home's dock refuses,
    /// and it has no panel).
    public var desktop: AgentInputDesktopConfiguration?
    /// The full-screen editor's button at the text's top right, once the
    /// text is past the lines the card shows; the delegate hears
    /// `agentInputCardDidPressExpand`. The compact card only.
    public var showsExpand: Bool

    public init(
        placeholder: String,
        isEditable: Bool = true,
        showsAdd: Bool = false,
        addAccessibilityLabel: String? = nil,
        attachments: [AgentInputAttachmentPreview] = [],
        permission: AgentInputChipConfiguration? = nil,
        model: AgentInputChipConfiguration? = nil,
        effort: AgentInputChipConfiguration? = nil,
        primaryAction: AgentInputPrimaryAction = .idle,
        isPrimaryBusy: Bool = false,
        primaryAccessibilityLabel: String? = nil,
        inputMinHeight: CGFloat? = nil,
        autocapitalization: UITextAutocapitalizationType = .sentences,
        returnKey: UIReturnKeyType = .default,
        primaryStyle: AgentInputPrimaryStyle = .standard,
        refusesControls: Bool = false,
        zenMode: Bool = false,
        desktop: AgentInputDesktopConfiguration? = nil,
        showsExpand: Bool = false
    ) {
        self.placeholder = placeholder
        self.isEditable = isEditable
        self.showsAdd = showsAdd
        self.addAccessibilityLabel = addAccessibilityLabel
        self.attachments = attachments
        self.permission = permission
        self.model = model
        self.effort = effort
        self.primaryAction = primaryAction
        self.isPrimaryBusy = isPrimaryBusy
        self.primaryAccessibilityLabel = primaryAccessibilityLabel
        self.inputMinHeight = inputMinHeight
        self.autocapitalization = autocapitalization
        self.returnKey = returnKey
        self.primaryStyle = primaryStyle
        self.refusesControls = refusesControls
        self.zenMode = zenMode
        self.desktop = desktop
        self.showsExpand = showsExpand
    }
}

/// What the card reports. Every method has an empty default.
@MainActor
public protocol AgentInputCardDelegate: AnyObject {
    /// The text changed (typed, pasted or dictated).
    func agentInputCardDidChangeText(_ card: AgentInputCardView)
    /// The caret or selection moved without the text changing.
    func agentInputCardDidChangeSelection(_ card: AgentInputCardView)
    func agentInputCardDidChangeFocus(_ card: AgentInputCardView)
    /// `height(fitting:)` changed; lay the card out again (inside an
    /// animation block to animate it).
    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView)
    /// The round button. What it means depends on the live text: read
    /// `card.text`, not the configuration, which may lag a fast tap.
    func agentInputCardDidPressPrimary(_ card: AgentInputCardView)
    /// The flat panel's send, which is only send.
    func agentInputCardDidPressSend(_ card: AgentInputCardView)
    /// The flat panel's stop.
    func agentInputCardDidPressStop(_ card: AgentInputCardView)
    /// The add button, or the flat panel's image button.
    func agentInputCardDidPressAdd(_ card: AgentInputCardView)
    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String)
    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip)
    /// A chip that `opensPicker` was pressed.
    func agentInputCard(_ card: AgentInputCardView, didPress chip: AgentInputChip)
    /// A chip's menu opened.
    func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip)
    /// Return was typed. False swallows the newline (an autocomplete pick).
    func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool
    /// A hardware keyboard's Tab was typed. False swallows the tab (an
    /// autocomplete pick).
    func agentInputCardShouldInsertTab(_ card: AgentInputCardView) -> Bool
    /// A control was pressed while `refusesControls` is on; it has shaken.
    func agentInputCardDidRefuse(_ card: AgentInputCardView, control: AgentInputControl)
    /// The full-screen editor's button (`showsExpand`).
    func agentInputCardDidPressExpand(_ card: AgentInputCardView)
}

extension AgentInputCardDelegate {
    public func agentInputCardDidChangeText(_ card: AgentInputCardView) {}
    public func agentInputCardDidChangeSelection(_ card: AgentInputCardView) {}
    public func agentInputCardDidChangeFocus(_ card: AgentInputCardView) {}
    public func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {}
    public func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {}
    public func agentInputCardDidPressSend(_ card: AgentInputCardView) {}
    public func agentInputCardDidPressStop(_ card: AgentInputCardView) {}
    public func agentInputCardDidPressAdd(_ card: AgentInputCardView) {}
    public func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) {}
    public func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {}
    public func agentInputCard(_ card: AgentInputCardView, didPress chip: AgentInputChip) {}
    public func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip) {}
    public func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool { true }
    public func agentInputCardShouldInsertTab(_ card: AgentInputCardView) -> Bool { true }
    public func agentInputCardDidRefuse(_ card: AgentInputCardView, control: AgentInputControl) {}
    public func agentInputCardDidPressExpand(_ card: AgentInputCardView) {}
}

/// The card. Give it a frame from `height(fitting:)`; it lays itself out.
public final class AgentInputCardView: UIView {
    public weak var delegate: (any AgentInputCardDelegate)?

    public var configuration: AgentInputCardConfiguration {
        didSet {
            guard configuration != oldValue else { return }
            apply(previous: oldValue)
        }
    }

    public let metrics: MobileComposerMetrics

    /// The text view, for owners that need it (input accessories, first
    /// responder chains). Don't set its delegate.
    ///
    /// TextKit 2, as RN's `RCTUITextView` is, in the frame Fabric would give
    /// it: the TextKit 1 height `ComposerTextMeasure` measures off the main
    /// thread. TextKit 2 lays a fractional line height (a scaled 22pt line)
    /// out a little shorter, more so each line, so the text sits inside its
    /// frame as it does in RN. UIKit gives a TextKit 2 view Writing Tools'
    /// inline experience and a TextKit 1 view only its panel. Never ask it
    /// for its `layoutManager`: that turns it into TextKit 1 for good.
    public let textView = AgentInputTextView(usingTextLayoutManager: true)

    private let surface = UIView()
    private let material = PartialBlurView(fraction: ComposerShadow.materialFraction)
    private let frosted = UIView()
    /// The attachment strip and the text, and the action row: each group
    /// fills the card so its children keep card coordinates, and moves as
    /// one for `setReveal`.
    private let inputGroup = PassthroughView()
    private let actionsGroup = PassthroughView()
    private let placeholderLabel = UILabel()
    private let expandButton = ComposerIconButton(icon: .ionicons("expand-outline"), size: AgentInputCardLayout.Metrics.expandIconSize)
    private let attachmentStrip = AttachmentStripView()
    private let addButton = ComposerIconButton(icon: .ionicons("add"), size: MobileComposerMetrics.mobile.addIconSize)
    private let middle = UIView()
    private let permissionChip = ComposerChipButton(chip: .permission)
    private let modelChip = ComposerChipButton(chip: .model)
    private let separator = UILabel()
    private let effortChip = ComposerChipButton(chip: .effort)
    private let primaryHost = PassthroughView()
    private let primaryButton = ComposerPrimaryButton()
    private var installedDesktopControls: AgentInputDesktopControlsView?
    /// A phone's compact card never mounts the hidden desktop button tree.
    /// Keep it after the first wide layout so resizing preserves its controls.
    private var desktopControls: AgentInputDesktopControlsView {
        if let installedDesktopControls { return installedDesktopControls }
        let controls = AgentInputDesktopControlsView()
        controls.onSelect = { [weak self] key, chip in
            guard let self else { return }
            self.delegate?.agentInputCard(self, didSelect: key, in: chip)
        }
        controls.onStop = { [weak self] in
            guard let self else { return }
            self.delegate?.agentInputCardDidPressStop(self)
        }
        controls.onImage = { [weak self] in
            guard let self else { return }
            self.delegate?.agentInputCardDidPressAdd(self)
        }
        controls.onSend = { [weak self] in
            guard let self else { return }
            self.delegate?.agentInputCardDidPressSend(self)
        }
        installedDesktopControls = controls
        actionsGroup.addSubview(controls)
        return controls
    }
    private var primaryFlash: CGFloat = 0
    /// The text, kept off the main thread from the storage's edits, so a
    /// measurement or the draft gets it without a copy on main.
    private let textMirror = ComposerTextMirror()
    /// The text's heights, measured off the main thread.
    private var textHeights = ComposerTextHeights()
    private var measuring: Task<Void, Never>?
    /// Moves on every change to the text, so a measured height is checked
    /// without reading the text, however long it is.
    private var textRevision = 0
    /// Moves when the text is replaced (`setText`) rather than typed.
    private var textGeneration = 0
    /// A text set not to animate its height, until its own measurement
    /// lands or the person edits it.
    private var quietGrowth: ComposerTextHeights.QuietGrowth?
    /// The height a `premeasure`d text brought, for `textChanged` to file
    /// under its revision.
    private var premeasured: PremeasuredText?
    /// Someone waiting for the text's measured height (`whenTextMeasured`).
    private var textWait: TextWait?
    private var textWaits = 0

    /// Whether the height change the delegate is hearing about should
    /// animate: only one the text made, and not a text set with
    /// `animatesHeight: false`, whose height may land a moment after it
    /// was set.
    public private(set) var animatesHeightChange = true
    /// The height the owner last laid the card out at, and at what width:
    /// what a change to the text is measured against.
    private var laidOut: (width: CGFloat, height: CGFloat)?
    /// The person's text size, where the card follows it; nil draws the
    /// designed sizes.
    private var textScale: TextScale?

    /// MultiTextInput's 16/22, as drawn here.
    private var inputStyle: TextStyle {
        textScale.map { TextStyles.composerInput.scaled($0) } ?? TextStyles.composerInput
    }

    private var chipStyle: TextStyle {
        textScale.map { TextStyles.composerChip.scaled($0) } ?? TextStyles.composerChip
    }

    public init(configuration: AgentInputCardConfiguration, metrics: MobileComposerMetrics = .mobile) {
        self.configuration = configuration
        self.metrics = metrics
        super.init(frame: .zero)

        layer.shadowColor = UIColor(Palette.shadow).cgColor
        surface.clipsToBounds = true
        surface.layer.cornerRadius = metrics.shellRadius
        surface.layer.cornerCurve = .continuous
        addSubview(surface)
        material.clipsToBounds = true
        surface.addSubview(material)
        frosted.backgroundColor = UIColor(Palette.composerFrostedOverlay)
        frosted.isUserInteractionEnabled = false
        surface.addSubview(frosted)

        surface.addSubview(inputGroup)
        surface.addSubview(actionsGroup)

        attachmentStrip.onRemove = { [weak self] id in
            guard let self else { return }
            self.delegate?.agentInputCard(self, didRemoveAttachment: id)
        }
        inputGroup.addSubview(attachmentStrip)

        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: metrics.inputPaddingTop, left: 0, bottom: metrics.inputPaddingBottom, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.font = inputStyle.font
        textView.textColor = UIColor(Palette.inputText)
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        textView.isScrollEnabled = false
        textView.autocorrectionType = .yes
        textView.keyboardType = .default
        textView.returnKeyType = .default
        textView.textContentType = nil
        textView.tintColor = UIColor(Palette.radioActive)
        textView.delegate = self
        // Every character edit, typed, marked, corrected, pasted, undone or
        // set, goes through the storage's processEditing.
        NotificationCenter.default.addObserver(
            self, selector: #selector(textStorageDidProcessEditing(_:)),
            name: NSTextStorage.didProcessEditingNotification, object: textView.textStorage
        )
        inputGroup.addSubview(textView)
        placeholderLabel.isAccessibilityElement = false
        placeholderLabel.isUserInteractionEnabled = false
        inputGroup.addSubview(placeholderLabel)
        expandButton.isHidden = true
        expandButton.tint = Palette.textSecondary
        expandButton.accessibilityLabel = Strings.Composer.expandEditor
        expandButton.accessibilityIdentifier = "composer-expand"
        expandButton.addTarget(self, action: #selector(expandTapped), for: .touchUpInside)
        inputGroup.addSubview(expandButton)

        addButton.accessibilityLabel = Strings.Composer.addPhoto
        addButton.addTarget(self, action: #selector(addTapped), for: .touchUpInside)
        actionsGroup.addSubview(addButton)

        middle.clipsToBounds = true
        actionsGroup.addSubview(middle)
        for chip in [permissionChip, modelChip, effortChip] {
            chip.onSelect = { [weak self] key, which in
                guard let self else { return }
                self.delegate?.agentInputCard(self, didSelect: key, in: which)
            }
            chip.onRefuse = { [weak self] which in
                guard let self else { return }
                self.delegate?.agentInputCardDidRefuse(self, control: AgentInputControl(which))
            }
            chip.onPress = { [weak self] which in
                guard let self else { return }
                self.delegate?.agentInputCard(self, didPress: which)
            }
            chip.onMenu = { [weak self] which in
                guard let self else { return }
                self.delegate?.agentInputCard(self, didOpenMenuIn: which)
            }
            middle.addSubview(chip)
        }
        middle.addSubview(separator)

        primaryButton.addTarget(self, action: #selector(primaryTapped), for: .touchUpInside)
        primaryHost.addSubview(primaryButton)
        actionsGroup.addSubview(primaryHost)

        // didSet doesn't run in the initializer.
        syncTextSize()
        applyTextSize()
        apply(previous: nil)
        applyAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyAppearance()
        }
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.textSizeMayHaveChanged()
        }
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        textSizeMayHaveChanged()
    }

    // MARK: Text size

    /// Takes up the text size the traits now give; true if it moved. The
    /// fonts are redrawn, nothing is reported.
    @discardableResult
    private func syncTextSize() -> Bool {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return false }
        textScale = scale
        applyTextSize()
        return true
    }

    /// The text size moved outside a measurement: redraw, and the owner
    /// lays the card out again, unanimated: only what is typed animates.
    private func textSizeMayHaveChanged() {
        guard syncTextSize() else { return }
        reportHeightChange(animated: false)
        setNeedsLayout()
    }

    /// Every font the card draws, at `textScale`.
    private func applyTextSize() {
        separator.attributedText = chipStyle.attributedString("·", color: UIColor(Palette.textSecondary))
        for chip in [permissionChip, modelChip, effortChip] {
            chip.textScale = textScale
        }
        placeholderLabel.attributedText = inputStyle.attributedString(
            configuration.placeholder,
            color: UIColor(Palette.inputPlaceholder),
            lineBreakMode: .byTruncatingTail
        )
        textView.font = inputStyle.font
        restyleText()
    }

    /// The typed text drawn again in the input style and colour, the
    /// selection kept.
    private func restyleText() {
        let selection = textView.selectedRange
        if textView.hasText {
            textView.attributedText = inputStyle.attributedString(text, color: UIColor(Palette.inputText))
            textView.selectedRange = selection
        }
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: Text

    /// The live text.
    public var text: String {
        get { textView.text ?? "" }
        set { setText(newValue, selection: NSRange(location: (newValue as NSString).length, length: 0)) }
    }

    /// The live text's UTF-16 as the text view stores it, not copied out
    /// as `text` is. Read it now: it changes with the text.
    public var textUnits: NSString { textView.textStorage.mutableString }

    /// The live text as a snapshot, copied out off the main thread when it
    /// is read (`ComposerTextSnapshot.text()`): the same one until the next
    /// edit, so the measurement and the draft share it.
    public var textSnapshot: ComposerTextSnapshot {
        let units = textView.textStorage.mutableString
        if textMirror.length != units.length {
            // An edit the mirror never heard of: not known to happen (the
            // UIKit tests count these); if it does, it costs this copy.
            textMirrorResets += 1
            textMirror.reset(units as String)
        }
        return textMirror.snapshot()
    }

    /// How often the mirror had to start again from the text (tests).
    private(set) var textMirrorResets = 0

    /// Moves with every edit to the text: compared in place of the text.
    public var editCount: Int { textMirror.revision }

    /// No text at all.
    public var isEmpty: Bool { !textView.hasText }

    /// Something besides whitespace (`trim().length > 0`), looked for in
    /// the text view's storage rather than in a copy of the text.
    public var hasContent: Bool {
        textUnits.rangeOfCharacter(from: Self.nonBlank).location != NSNotFound
    }

    private static let nonBlank = CharacterSet.whitespacesAndNewlines.inverted

    public var selectedRange: NSRange { textView.selectedRange }

    /// Replaces the text and moves the caret (`setTextAndSelection`).
    /// Reports the change to the delegate, as a keystroke would.
    /// `animatesHeight: false` reports the new height, then and when it is
    /// measured, with `animatesHeightChange` off.
    public func setText(_ text: String, selection: NSRange, animatesHeight: Bool = true) {
        textGeneration += 1
        // `textChanged` moves the revision to this text's.
        quietGrowth = animatesHeight ? nil : .init(generation: textGeneration, revision: textRevision + 1)
        textView.attributedText = inputStyle.attributedString(text, color: UIColor(Palette.inputText))
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        let length = (text as NSString).length
        let location = min(max(0, selection.location), length)
        textView.selectedRange = NSRange(location: location, length: min(selection.length, length - location))
        textChanged()
    }

    /// A text measured off the main thread before it is set, for a card
    /// as wide and drawn as it was then (`premeasure`).
    public struct PremeasuredText: Sendable {
        public let text: String
        /// What it was measured for (`textKey(fitting:)`).
        public let key: ComposerTextHeights.Key
        fileprivate let height: CGFloat
    }

    /// What the text's height at a card `width` wide depends on besides
    /// the text: the width it wraps at, the text size and the panel. A
    /// text premeasured for another key is measured again when set.
    public func textKey(fitting width: CGFloat) -> ComposerTextHeights.Key {
        textStamp(cardWidth: width, desktop: configuration.desktop != nil).key
    }

    /// Measures `text` off the main thread for this card `width` wide, at
    /// the text size and in the panel it has now, without setting it. Set
    /// it with `setText(_:selection:animatesHeight:)` taking it, and its
    /// first frame has its height: for a text that replaces another in a
    /// card already on screen.
    public func premeasure(_ text: String, fitting width: CGFloat) async -> PremeasuredText {
        let key = textStamp(cardWidth: width, desktop: configuration.desktop != nil).key
        guard !text.isEmpty, key.width > 0 else {
            return PremeasuredText(text: text, key: key, height: key.oneLine)
        }
        let job = ComposerTextMeasure(
            stamp: .init(key: key, revision: 0, generation: 0),
            text: text,
            attributes: key.style.attributes(color: UIColor(Palette.inputText))
        )
        let height = await Task.detached(priority: .userInitiated) { job.run() }.value
        return PremeasuredText(text: text, key: key, height: height)
    }

    /// Sets a premeasured text. Its height stands if the card is still as
    /// wide and drawn as it was measured for; otherwise it is measured
    /// again, as any text is.
    public func setText(_ text: PremeasuredText, selection: NSRange, animatesHeight: Bool = true) {
        premeasured = text
        setText(text.text, selection: selection, animatesHeight: animatesHeight)
    }

    public var isTextFocused: Bool { textView.isFirstResponder }

    /// An input method is composing (marked text): replacing the text now
    /// would cut the composition off.
    public var hasMarkedText: Bool { textView.markedTextRange != nil }

    public func focus() {
        guard configuration.isEditable else { return }
        textView.becomeFirstResponder()
    }

    public func blur() {
        textView.resignFirstResponder()
    }

    /// Where a chip stands, in `view`: what its owner's picker opens over.
    /// Nil while the chip is hidden.
    public func chipFrame(_ chip: AgentInputChip, in view: UIView) -> CGRect? {
        let button = switch chip {
        case .permission: permissionChip
        case .model: modelChip
        case .effort: effortChip
        }
        guard !button.isHidden, button.window != nil else { return nil }
        return button.convert(button.bounds, to: view)
    }

    // MARK: Feedback

    /// The whole card shakes: a send the agent refuses (`sendBlockShakerRef`).
    public func shake() {
        Self.shake(self)
    }

    /// Only the round button shakes, or the flat panel's stop: a stop that
    /// failed (`shakerRef`).
    public func shakePrimary() {
        if configuration.desktop != nil {
            desktopControls.shakeStop()
        } else {
            Self.shake(primaryButton)
        }
    }

    /// Shaker.tsx (`ComposerShake.shaker`).
    static func shake(_ view: UIView, _ shake: ComposerShake = .shaker) {
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
        animation.values = shake.values.map { Double($0) }
        animation.keyTimes = shake.keyTimes.map { NSNumber(value: $0) }
        animation.duration = shake.duration
        // Animated.timing's ease-in-out per step; Reanimated's quad is close.
        animation.timingFunctions = Array(
            repeating: CAMediaTimingFunction(name: .easeInEaseOut),
            count: max(0, shake.values.count - 1)
        )
        animation.isAdditive = true
        view.layer.add(animation, forKey: "shake")
    }

    // MARK: Home's motion

    /// HomeDock.tsx's refusal flash, driven by Home (0…1): the round button
    /// swells by a tenth and, on Stop, a lighter wash rises under the glyph.
    public func setPrimaryFlash(_ amount: CGFloat) {
        primaryFlash = amount
        let scale = AgentInputPrimaryFlash.scale(amount)
        primaryHost.transform = CGAffineTransform(scaleX: scale, y: scale)
        primaryButton.flash = AgentInputPrimaryFlash.overlayAlpha(amount)
    }

    /// HomeDock.tsx's open animation: `input` moves the attachment strip and
    /// the text, `actions` the action row. Transform and alpha only
    /// (`AgentInputCardReveal` has HomeDock's ranges).
    public func setReveal(input: (alpha: CGFloat, offsetY: CGFloat), actions: (alpha: CGFloat, offsetY: CGFloat)) {
        inputGroup.alpha = input.alpha
        inputGroup.transform = CGAffineTransform(translationX: 0, y: input.offsetY)
        actionsGroup.alpha = actions.alpha
        actionsGroup.transform = CGAffineTransform(translationX: 0, y: actions.offsetY)
    }

    // MARK: Layout

    /// The card's frames at `width`.
    public func layout(width: CGFloat) -> AgentInputCardLayout {
        let layout = AgentInputCardLayout(layoutInput(width: width))
        laidOut = (width, layout.size.height)
        return layout
    }

    /// The flat panel's frames at `width`; nil for the compact card.
    public func desktopLayout(width: CGFloat) -> AgentInputDesktopLayout? {
        guard let input = desktopLayoutInput(width: width) else { return nil }
        let layout = AgentInputDesktopLayout(input)
        laidOut = (width, layout.size.height)
        return layout
    }

    /// The card's height at `width`, with the text's height as last
    /// measured off the main thread; the delegate hears when it moves.
    public func height(fitting width: CGFloat) -> CGFloat {
        desktopLayout(width: width)?.size.height ?? layout(width: width).size.height
    }

    /// What `AgentInputLayout` places between its rows.
    public func panelInput(width: CGFloat) -> AgentInputLayout.Panel {
        if let input = desktopLayoutInput(width: width) {
            laidOut = (width, AgentInputDesktopLayout(input).size.height)
            return .desktop(input)
        }
        let input = layoutInput(width: width)
        laidOut = (width, AgentInputCardLayout(input).size.height)
        return .card(input)
    }

    /// The live text's stamp for a card (or flat panel) `width` wide: the
    /// width it wraps at, its padding and cap, at the text size it is
    /// drawn at.
    private func textStamp(cardWidth width: CGFloat, desktop: Bool) -> ComposerTextHeights.Stamp {
        // Measured before its first trait update: measure what it will draw.
        syncTextSize()
        let key: ComposerTextHeights.Key
        if desktop {
            typealias M = AgentInputDesktopLayout.Metrics
            key = ComposerTextHeights.Key(
                width: AgentInputDesktopLayout.textWidth(panelWidth: width),
                style: inputStyle,
                lineHeight: inputLineHeight,
                paddingTop: M.textPaddingTop,
                paddingBottom: M.textPaddingBottom,
                maxHeight: M.inputMaxHeight
            )
        } else {
            let contentWidth = max(0, width - 2 * hairline - 2 * metrics.shellInset)
            let insets = AgentInputInsets(shellInset: metrics.shellInset, actionSize: metrics.actionSize, addIconSize: metrics.addIconSize)
            key = ComposerTextHeights.Key(
                width: max(0, contentWidth - insets.inputContainerPaddingLeft - insets.inputContainerPaddingRight),
                style: inputStyle,
                lineHeight: inputLineHeight,
                paddingTop: metrics.inputPaddingTop,
                paddingBottom: metrics.inputPaddingBottom,
                maxHeight: metrics.inputMaxHeight
            )
        }
        return ComposerTextHeights.Stamp(key: key, revision: textRevision, generation: textGeneration)
    }

    /// The text's height for a card `width` wide, its padding included:
    /// as measured off the main thread, or a guess until it is, which
    /// starts the measurement (`ComposerTextHeights`).
    private func textHeight(cardWidth width: CGFloat, desktop: Bool) -> CGFloat {
        let lookup = textHeights.lookup(textStamp(cardWidth: width, desktop: desktop), isEmpty: !textView.hasText)
        if let measure = lookup.measure {
            startMeasuring(measure)
        }
        return lookup.height
    }

    /// Whether `height(fitting: width)` is the text's measured height
    /// rather than a guess. Measures nothing.
    public func isTextMeasured(fitting width: CGFloat) -> Bool {
        textHeights.isMeasured(textStamp(cardWidth: width, desktop: configuration.desktop != nil), isEmpty: !textView.hasText)
    }

    /// Measures the text as it is now off the main thread, where its
    /// snapshot is copied out: nothing here passes over it.
    private func startMeasuring(_ stamp: ComposerTextHeights.Stamp) {
        let snapshot = textSnapshot
        let job = ComposerTextMeasure(
            stamp: stamp,
            text: "",
            attributes: stamp.key.style.attributes(color: UIColor(Palette.inputText))
        )
        measuring = Task { [weak self] in
            let height = await Task.detached(priority: .userInitiated) {
                var job = job
                job.text = await snapshot.text()
                return job.run()
            }.value
            self?.measured(stamp, height: height)
        }
    }

    private func measured(_ stamp: ComposerTextHeights.Stamp, height: CGFloat) {
        measuring = nil
        let live = ComposerTextHeights.Live(revision: textRevision, generation: textGeneration, isEmpty: !textView.hasText)
        let finish = textHeights.finish(stamp, height: height, live: live)
        let animated = quietGrowth?.animates(generation: stamp.generation) ?? true
        // Only the quiet text's own measurement ends it: an earlier text's,
        // landing after it was set, doesn't.
        if quietGrowth?.isEnded(by: stamp) == true {
            quietGrowth = nil
        }
        if let next = finish.measure {
            startMeasuring(next)
        }
        if finish.changed {
            reportHeightChange(animated: animated)
            setNeedsLayout()
        }
        checkTextWait()
    }

    private func reportHeightChange(animated: Bool) {
        animatesHeightChange = animated
        delegate?.agentInputCardDidInvalidateHeight(self)
        animatesHeightChange = true
    }

    // MARK: Waiting for the height

    /// What ended a wait for the text's height (`whenTextMeasured`).
    public enum TextReadiness: Equatable, Sendable {
        /// `height(fitting:)` at the width is the text's measured height.
        case measured
        /// The wait ran out first. The height is the one known then, and
        /// moves (the delegate hears of it) when the measurement lands.
        case timedOut
        /// A newer wait replaced it, or it was cancelled.
        case superseded
    }

    private struct TextWait {
        let id: Int
        let width: CGFloat
        let ready: @MainActor (TextReadiness) -> Void
        let deadline: Task<Void, Never>
    }

    /// Calls `ready` once, on the main thread, when `height(fitting:
    /// width)` gives the text's height as measured off the main thread
    /// (before returning, if it already does), or after `timeout` with the
    /// height known then; nothing is measured on the main thread either
    /// way. It follows the text: an edit or `setText` meanwhile is waited
    /// for too. For an owner that keeps the card hidden until its height
    /// is real (a restored draft), so its first frame is its last.
    public func whenTextMeasured(fitting width: CGFloat, timeout: Duration, _ ready: @escaping @MainActor (TextReadiness) -> Void) {
        endTextWait(.superseded)
        if isTextMeasured(fitting: width) {
            ready(.measured)
            return
        }
        textWaits += 1
        let id = textWaits
        let deadline = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled, let self, self.textWait?.id == id else { return }
            self.endTextWait(.timedOut)
        }
        textWait = TextWait(id: id, width: width, ready: ready, deadline: deadline)
        // Starts (or joins) the measurement.
        _ = textHeight(cardWidth: width, desktop: configuration.desktop != nil)
    }

    /// Ends a wait `whenTextMeasured` started, `.superseded`.
    public func cancelTextReadiness() {
        endTextWait(.superseded)
    }

    private func endTextWait(_ readiness: TextReadiness) {
        guard let wait = textWait else { return }
        textWait = nil
        wait.deadline.cancel()
        wait.ready(readiness)
    }

    /// The wait's text is measured: it ends. Otherwise its text, which may
    /// have moved since, is measured.
    private func checkTextWait() {
        guard let wait = textWait else { return }
        if isTextMeasured(fitting: wait.width) {
            endTextWait(.measured)
        } else {
            _ = textHeight(cardWidth: wait.width, desktop: configuration.desktop != nil)
        }
    }

    /// Returns once the text's height is measured (tests).
    func textMeasured() async {
        while let measuring {
            await measuring.value
        }
    }

    /// One line of the input as drawn.
    private var inputLineHeight: CGFloat {
        inputStyle.lineHeightValue
    }

    func desktopLayoutInput(width: CGFloat) -> AgentInputDesktopLayout.Input? {
        let config = configuration
        guard let desktop = config.desktop else { return nil }
        // First: it takes up the text size the rest is measured at.
        let height = textHeight(cardWidth: width, desktop: true)
        return AgentInputDesktopLayout.Input(
            width: width,
            attachmentCount: config.attachments.count,
            textContentHeight: height,
            hasText: textView.hasText,
            lineHeight: inputLineHeight,
            inputMinHeight: config.inputMinHeight,
            showsSettings: desktop.settings != nil,
            stopContentWidth: desktop.showsStop ? desktopControls.stopContentWidth : nil,
            imageContentWidth: config.showsAdd ? desktopControls.imageContentWidth : nil,
            zenMode: config.zenMode
        )
    }

    func layoutInput(width: CGFloat) -> AgentInputCardLayout.Input {
        let config = configuration
        // First: it takes up the text size the chips are measured at.
        let height = textHeight(cardWidth: width, desktop: false)
        return AgentInputCardLayout.Input(
            width: width,
            metrics: metrics,
            borderWidth: hairline,
            attachmentCount: config.attachments.count,
            textContentHeight: height,
            hasText: textView.hasText,
            lineHeight: textScale == nil ? nil : inputLineHeight,
            inputMinHeight: config.inputMinHeight,
            showsAdd: config.showsAdd,
            permission: config.permission.map { _ in .init(labelSize: permissionChip.contentSize) },
            model: config.model.map { _ in .init(labelSize: modelChip.contentSize) },
            modelIsMenu: config.model?.menu != nil,
            effort: config.effort.map { _ in .init(labelSize: effortChip.contentSize) },
            separator: config.effort == nil ? .zero : separator.sizeThatFits(.zero),
            zenMode: config.zenMode,
            offersExpand: config.showsExpand
        )
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: height(fitting: size.width))
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        surface.frame = bounds
        material.frame = surface.bounds
        frosted.frame = surface.bounds
        for group in [inputGroup, actionsGroup] {
            group.bounds = CGRect(origin: .zero, size: surface.bounds.size)
            group.center = CGPoint(x: surface.bounds.midX, y: surface.bounds.midY)
        }
        if let desktop = desktopLayout(width: bounds.width) {
            layoutDesktop(desktop)
            return
        }
        let layout = layout(width: bounds.width)
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: metrics.shellRadius).cgPath

        if let strip = layout.attachments {
            attachmentStrip.isHidden = false
            attachmentStrip.insets = layout.attachmentInsets
            attachmentStrip.setLayoutFrame(strip)
        } else {
            attachmentStrip.isHidden = true
        }
        textView.setLayoutFrame(layout.text)
        if textView.isScrollEnabled != layout.textScrolls {
            textView.isScrollEnabled = layout.textScrolls
        }
        setTextTrailingInset(layout.textTrailingInset)
        if let expand = layout.expand {
            expandButton.isHidden = false
            expandButton.setLayoutFrame(expand)
        } else {
            expandButton.isHidden = true
        }
        placeholderLabel.setLayoutFrame(CGRect(
            x: layout.text.minX,
            y: layout.text.minY + metrics.inputPaddingTop,
            width: layout.text.width,
            height: inputLineHeight
        ))
        if let add = layout.add {
            addButton.setLayoutFrame(add)
        }
        middle.setLayoutFrame(layout.middle)
        let content = layout.middleContent
        place(permissionChip, content.permission)
        place(modelChip, content.model)
        place(effortChip, content.effort)
        if let frame = content.separator {
            separator.setLayoutFrame(frame)
        }
        // Bounds and centre, so the flash's scale is about the middle.
        let primary = PixelGrid.snap(layout.primary, scale: max(1, traitCollection.displayScale))
        primaryHost.bounds = CGRect(origin: .zero, size: primary.size)
        primaryHost.center = CGPoint(x: primary.midX, y: primary.midY)
        primaryButton.frame = primaryHost.bounds
    }

    /// The flat panel: the strip and text where `AgentInputDesktopLayout`
    /// puts them, and its own action row.
    private func layoutDesktop(_ layout: AgentInputDesktopLayout) {
        typealias M = AgentInputDesktopLayout.Metrics
        layer.shadowPath = nil
        expandButton.isHidden = true
        setTextTrailingInset(0)
        if let strip = layout.attachments {
            attachmentStrip.isHidden = false
            attachmentStrip.insets = .panel
            attachmentStrip.setLayoutFrame(strip)
        } else {
            attachmentStrip.isHidden = true
        }
        textView.setLayoutFrame(layout.text)
        if textView.isScrollEnabled != layout.textScrolls {
            textView.isScrollEnabled = layout.textScrolls
        }
        placeholderLabel.setLayoutFrame(CGRect(
            x: layout.text.minX,
            y: layout.text.minY + M.textPaddingTop,
            width: layout.text.width,
            height: inputLineHeight
        ))
        desktopControls.frame = actionsGroup.bounds
        desktopControls.place(layout)
    }

    /// The text wraps clear of the expand button while it shows. Its height
    /// is measured at the full width: past the cap either way, it scrolls.
    private func setTextTrailingInset(_ inset: CGFloat) {
        guard textView.textContainerInset.right != inset else { return }
        textView.textContainerInset.right = inset
    }

    private func place(_ chip: ComposerChipButton, _ frame: AgentInputCardLayout.ChipFrame?) {
        guard let frame else { return }
        chip.setLayoutFrame(frame.frame)
        chip.labelFrame = frame.label
    }

    // MARK: Configuration

    private func apply(previous: AgentInputCardConfiguration?) {
        let config = configuration
        placeholderLabel.attributedText = inputStyle.attributedString(
            config.placeholder,
            color: UIColor(Palette.inputPlaceholder),
            lineBreakMode: .byTruncatingTail
        )
        textView.isEditable = config.isEditable
        textView.isSelectable = config.isEditable
        textView.alpha = config.isEditable ? 1 : AgentInputCardLayout.Metrics.readOnlyTextOpacity
        placeholderLabel.alpha = textView.alpha
        if !config.isEditable, textView.isFirstResponder {
            textView.resignFirstResponder()
        }
        if textView.autocapitalizationType != config.autocapitalization || textView.returnKeyType != config.returnKey {
            textView.autocapitalizationType = config.autocapitalization
            textView.returnKeyType = config.returnKey
            // The keyboard is up through the change; it takes new traits
            // only when asked.
            if textView.isFirstResponder { textView.reloadInputViews() }
        }
        textView.accessibilityLabel = config.placeholder

        let isDesktop = config.desktop != nil
        if isDesktop != (previous?.desktop != nil) || previous == nil {
            applyPanel()
        }
        addButton.isHidden = !config.showsAdd || config.zenMode || isDesktop
        addButton.accessibilityLabel = config.addAccessibilityLabel ?? Strings.Composer.addPhoto
        // The glyph turns blue while pictures are attached.
        addButton.tint = config.attachments.isEmpty ? Palette.text : Palette.radioActive
        attachmentStrip.attachments = config.attachments

        for chip in [permissionChip, modelChip, effortChip] {
            chip.refuses = config.refusesControls
        }
        permissionChip.configure(config.zenMode ? nil : config.permission)
        modelChip.configure(config.zenMode ? nil : config.model)
        effortChip.configure(config.zenMode ? nil : config.effort)
        separator.isHidden = config.zenMode || config.effort == nil

        primaryButton.configure(
            action: config.primaryAction,
            style: config.primaryStyle,
            busy: config.isPrimaryBusy,
            accessibilityLabel: config.primaryAccessibilityLabel
        )
        if let desktop = config.desktop {
            desktopControls.configure(
                desktop,
                showsImage: config.showsAdd,
                hasAttachments: !config.attachments.isEmpty,
                imageAccessibilityLabel: config.addAccessibilityLabel ?? Strings.Composer.addPhoto
            )
        }
        updatePlaceholder()

        guard let previous else { return }
        if previous.showsExpand != config.showsExpand { setNeedsLayout() }
        if previous.attachments.count != config.attachments.count
            || previous.inputMinHeight != config.inputMinHeight
            || previous.showsAdd != config.showsAdd
            || previous.permission != config.permission
            || previous.model != config.model
            || previous.effort != config.effort
            || previous.zenMode != config.zenMode
            || Self.panelShape(previous.desktop) != Self.panelShape(config.desktop) {
            // Chips that come with the session's record, a picture, the
            // panel: the card takes its new height at once. Only what is
            // typed animates.
            reportHeightChange(animated: false)
            setNeedsLayout()
        }
    }

    /// What of the flat panel moves its frames: whether it is there, the
    /// gear, stop and stop's spinner.
    private static func panelShape(_ desktop: AgentInputDesktopConfiguration?) -> [Bool]? {
        desktop.map { [$0.settings != nil, $0.showsStop, $0.isStopBusy] }
    }

    /// The compact card's frosted glass and its controls, or the flat
    /// panel's fill and its row. The text view stays, with its padding.
    private func applyPanel() {
        let isDesktop = configuration.desktop != nil
        material.isHidden = isDesktop
        frosted.isHidden = isDesktop
        middle.isHidden = isDesktop
        primaryHost.isHidden = isDesktop
        installedDesktopControls?.isHidden = !isDesktop
        surface.layer.cornerRadius = isDesktop ? AgentInputDesktopLayout.Metrics.panelRadius : metrics.shellRadius
        let padding = isDesktop
            ? (top: AgentInputDesktopLayout.Metrics.textPaddingTop, bottom: AgentInputDesktopLayout.Metrics.textPaddingBottom)
            : (top: metrics.inputPaddingTop, bottom: metrics.inputPaddingBottom)
        textView.textContainerInset = UIEdgeInsets(top: padding.top, left: 0, bottom: padding.bottom, right: 0)
        applyAppearance()
    }

    private func applyAppearance() {
        let dark = traitCollection.userInterfaceStyle == .dark
        // The flat panel (`unifiedPanel`) has no shadow and no rim; its
        // fill is input.background.
        let isDesktop = configuration.desktop != nil
        layer.shadowOffset = CGSize(width: 0, height: dark ? ComposerShadow.darkOffsetY : ComposerShadow.lightOffsetY)
        layer.shadowRadius = dark ? ComposerShadow.darkRadius : ComposerShadow.lightRadius
        layer.shadowOpacity = isDesktop ? 0 : dark ? ComposerShadow.darkOpacity : ComposerShadow.lightOpacity
        surface.backgroundColor = isDesktop ? UIColor(Palette.inputBackground) : nil
        surface.layer.borderWidth = isDesktop ? 0 : hairline
        surface.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
        // The typed text keeps the colour it was typed in; re-colour it.
        restyleText()
    }

    private func updatePlaceholder() {
        placeholderLabel.isHidden = textView.hasText
    }

    @objc private func textStorageDidProcessEditing(_ notification: Notification) {
        let storage = textView.textStorage
        guard storage.editedMask.contains(.editedCharacters) else { return }
        textMirror.edited(range: storage.editedRange, changeInLength: storage.changeInLength, in: storage.mutableString)
    }

    fileprivate func textChanged() {
        textRevision += 1
        if let premeasured {
            self.premeasured = nil
            textHeights.seed(.init(key: premeasured.key, revision: textRevision, generation: textGeneration), height: premeasured.height)
        }
        let width = bounds.width
        // Against what the owner laid out for the text before: measuring
        // it now would measure the new text.
        let before = laidOut
        let after = width > 0 ? height(fitting: width) : nil
        updatePlaceholder()
        delegate?.agentInputCardDidChangeText(self)
        if let after, before?.width != width || before?.height != after {
            reportHeightChange(animated: quietGrowth?.animates(generation: textGeneration) ?? true)
        }
        setNeedsLayout()
        checkTextWait()
    }

    // MARK: Actions

    @objc private func addTapped() {
        if configuration.refusesControls {
            Self.shake(addButton, .refusal)
            delegate?.agentInputCardDidRefuse(self, control: .add)
            return
        }
        delegate?.agentInputCardDidPressAdd(self)
    }

    @objc private func primaryTapped() {
        delegate?.agentInputCardDidPressPrimary(self)
    }

    @objc private func expandTapped() {
        delegate?.agentInputCardDidPressExpand(self)
    }
}

extension AgentInputCardView: UITextViewDelegate {
    public func textViewDidChange(_ textView: UITextView) {
        // The person's edit grows as they type it.
        quietGrowth = nil
        textChanged()
    }

    public func textViewDidChangeSelection(_ textView: UITextView) {
        delegate?.agentInputCardDidChangeSelection(self)
    }

    public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        switch text {
        case "\n": delegate?.agentInputCardShouldInsertNewline(self) ?? true
        case "\t": delegate?.agentInputCardShouldInsertTab(self) ?? true
        default: true
        }
    }

    public func textViewDidBeginEditing(_ textView: UITextView) {
        delegate?.agentInputCardDidChangeFocus(self)
    }

    public func textViewDidEndEditing(_ textView: UITextView) {
        delegate?.agentInputCardDidChangeFocus(self)
    }
}

// MARK: - Parts

/// BubblePressable's press: 0.7 opacity and a 1.025 swell, settling back.
class ComposerPressableButton: UIControl {
    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            let pressed = isHighlighted && isEnabled
            UIView.animate(
                withDuration: pressed ? 0.065 : 0.25,
                delay: 0,
                usingSpringWithDamping: pressed ? 1 : 0.55,
                initialSpringVelocity: 0,
                options: [.beginFromCurrentState, .allowUserInteraction]
            ) {
                self.transform = pressed ? CGAffineTransform(scaleX: 1.025, y: 1.025) : .identity
                self.pressedAlphaChanged(pressed)
            }
        }
    }

    func pressedAlphaChanged(_ pressed: Bool) {
        alpha = pressed ? 0.7 : 1
    }

    /// `hitSlop={6}`.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -6, dy: -6).contains(point)
    }
}

/// The add button: a 26pt Ionicon centred in a 42pt circle.
final class ComposerIconButton: ComposerPressableButton {
    private let iconView: IconView

    var tint: ColorToken = Palette.text {
        didSet { iconView.tintColor = UIColor(tint) }
    }

    init(icon: Icon, size: CGFloat) {
        iconView = IconView(icon, size: size, tint: Palette.text)
        super.init(frame: .zero)
        addSubview(iconView)
        accessibilityTraits = .button
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        iconView.frame = bounds
    }
}

/// A chip that opens its menu on tap, with the label where the native
/// trigger draws it.
final class ComposerChipButton: UIButton {
    let chip: AgentInputChip
    var onSelect: ((String, AgentInputChip) -> Void)?
    var onRefuse: ((AgentInputChip) -> Void)?
    /// A press on a chip that opens its owner's picker.
    var onPress: ((AgentInputChip) -> Void)?
    /// The chip's menu opened.
    var onMenu: ((AgentInputChip) -> Void)?
    /// Presses shake the chip instead of opening its menu.
    var refuses = false {
        didSet {
            guard refuses != oldValue else { return }
            applyMenu()
        }
    }
    private let label = UILabel()
    private let iconView = IconView(size: AgentInputCardLayout.Metrics.permissionIconSize, tint: Palette.text)
    private var chipConfiguration: AgentInputChipConfiguration?

    /// The label, in the chip, from the layout.
    var labelFrame: CGRect = .zero {
        didSet { setNeedsLayout() }
    }

    init(chip: AgentInputChip) {
        self.chip = chip
        super.init(frame: .zero)
        label.lineBreakMode = .byTruncatingTail
        label.isUserInteractionEnabled = false
        addSubview(label)
        addSubview(iconView)
        showsMenuAsPrimaryAction = true
        // The menus list their rows top-down in our order (SwiftUI's
        // `.menuOrder(.fixed)`, which happy-app gets by pre-reversing).
        preferredMenuElementOrder = .fixed
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
        addTarget(self, action: #selector(menuOpened), for: .menuActionTriggered)
    }

    @objc private func menuOpened() {
        onMenu?(chip)
    }

    @objc private func tapped() {
        if refuses {
            AgentInputCardView.shake(self, .refusal)
            onRefuse?(chip)
        } else if chipConfiguration?.opensPicker == true {
            onPress?(chip)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The label's or glyph's one-line size.
    var contentSize: CGSize {
        switch chipConfiguration?.content {
        case .icon: iconView.sizeThatFits(.zero)
        case .label: label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        case nil: .zero
        }
    }

    /// The card's text size; nil draws the designed 14.
    var textScale: TextScale? {
        didSet {
            guard textScale != oldValue else { return }
            renderLabel()
        }
    }

    func configure(_ configuration: AgentInputChipConfiguration?) {
        guard configuration != chipConfiguration else { return }
        chipConfiguration = configuration
        isHidden = configuration == nil
        guard let configuration else { return }
        switch configuration.content {
        case .label:
            renderLabel()
            label.isHidden = false
            iconView.isHidden = true
        case .icon(let icon):
            iconView.icon = icon
            iconView.isHidden = false
            label.isHidden = true
        }
        accessibilityLabel = configuration.accessibilityLabel
        alpha = configuration.menu != nil || configuration.opensPicker ? 1 : AgentInputCardLayout.Metrics.disabledChipOpacity
        applyMenu()
    }

    private func renderLabel() {
        guard case .label(let text) = chipConfiguration?.content else { return }
        let style = textScale.map { TextStyles.composerChip.scaled($0) } ?? TextStyles.composerChip
        label.attributedText = style.attributedString(text, color: UIColor(Palette.text), lineBreakMode: .byTruncatingTail)
    }

    /// A refusing chip takes the press itself (RefusableControl's blocker
    /// covers dimmed chips too); otherwise the menu opens on tap.
    private func applyMenu() {
        let model = chipConfiguration?.menu
        let opensPicker = chipConfiguration?.opensPicker == true
        menu = refuses || opensPicker ? nil : model.map(makeMenu)
        // Open while it changed (usage read as it opened): it shows the new one.
        if let menu { contextMenuInteraction?.updateVisibleMenu { menu.replacing($0) } }
        showsMenuAsPrimaryAction = !refuses && !opensPicker
        isEnabled = refuses || opensPicker || model != nil
    }

    private func makeMenu(_ model: AgentInputMenu) -> UIMenu {
        let chip = self.chip
        return UIMenu(model) { [weak self] key in self?.onSelect?(key, chip) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = labelFrame
        iconView.frame = labelFrame
    }

    override var isHighlighted: Bool {
        didSet { label.alpha = isHighlighted ? 0.7 : 1; iconView.alpha = label.alpha }
    }

    /// `hitSlop={6}`.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -6, dy: -6).contains(point)
    }
}

/// The round send / stop button (`mobilePrimaryButton`): 42pt.
final class ComposerPrimaryButton: ComposerPressableButton {
    private let flashOverlay = UIView()
    private let iconView = IconView(size: AgentInputCardLayout.Metrics.primaryIconSize)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var action: AgentInputPrimaryAction = .idle
    private var style: AgentInputPrimaryStyle = .standard
    private var busy = false

    /// The refusal wash's alpha, drawn under the glyph on Stop only.
    var flash: CGFloat = 0 {
        didSet { applyFlash() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        flashOverlay.isUserInteractionEnabled = false
        addSubview(flashOverlay)
        addSubview(iconView)
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        isAccessibilityElement = true
        accessibilityTraits = .button
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(action: AgentInputPrimaryAction, style: AgentInputPrimaryStyle, busy: Bool, accessibilityLabel: String?) {
        self.action = action
        self.style = style
        self.busy = busy
        switch action {
        case .stop:
            iconView.icon = .octicons("stop")
            iconView.size = AgentInputCardLayout.Metrics.primaryIconSize
        case .blocked:
            iconView.icon = .ionicons("lock-closed")
            iconView.size = AgentInputCardLayout.Metrics.lockIconSize
        case .voice:
            iconView.icon = .ionicons("mic-outline")
            iconView.size = AgentInputCardLayout.Metrics.primaryIconSize
        case .send, .idle:
            // HomeDock draws Ionicons' arrow; AgentInput Octicons'.
            iconView.icon = style == .newSession ? .ionicons("arrow-up") : .octicons("arrow-up")
            iconView.size = AgentInputCardLayout.Metrics.primaryIconSize
        }
        // `disabled={!canPressSendButton}`: idle can't be pressed, nor can
        // anything while a stop is in flight.
        isEnabled = !busy && action != .idle
        if busy {
            spinner.startAnimating()
            iconView.isHidden = true
        } else {
            spinner.stopAnimating()
            iconView.isHidden = false
        }
        self.accessibilityLabel = accessibilityLabel ?? (action == .stop ? Strings.Composer.stop : Strings.Composer.send)
        applyColors()
    }

    private func applyColors() {
        layer.borderWidth = 0
        flashOverlay.backgroundColor = UIColor(Palette.composerPrimaryFlash)
        applyFlash()
        if style == .newSession {
            // HomeDock's 'busy' is its own action, on the unfilled button.
            let filled = !busy && (action == .send || action == .stop)
            backgroundColor = UIColor(filled ? Palette.composerNewSessionPrimaryFill : Palette.surfaceHighest)
            iconView.tintColor = UIColor(filled ? Palette.composerNewSessionPrimaryIcon : Palette.textSecondary)
            spinner.color = UIColor(Palette.textSecondary)
            return
        }
        // Stop first: a blank composer on a non-steerable agent is both
        // blocked and abortable, and must not look locked.
        switch action {
        case .stop:
            backgroundColor = UIColor(Palette.composerStopFill)
            iconView.tintColor = UIColor(Palette.composerStopIcon)
        case .blocked:
            backgroundColor = UIColor(Palette.surfaceHigh)
            layer.borderWidth = 1
            layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
            iconView.tintColor = UIColor(Palette.textSecondary)
        case .send, .voice:
            backgroundColor = UIColor(Palette.surfaceHighest)
            iconView.tintColor = UIColor(Palette.text)
        case .idle:
            backgroundColor = UIColor(Palette.composerPrimaryInactive)
            iconView.tintColor = UIColor(Palette.textSecondary)
        }
        // AgentInput.tsx: black on Stop in dark, the text colour otherwise.
        spinner.color = action == .stop && traitCollection.userInterfaceStyle == .dark
            ? .black
            : UIColor(Palette.text)
    }

    private func applyFlash() {
        flashOverlay.isHidden = action != .stop || (busy && style == .newSession)
        flashOverlay.alpha = flash
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        flashOverlay.frame = bounds
        iconView.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

/// A container that takes no touches itself, only its subviews'.
final class PassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

/// AgentInputAttachmentStrip: 64pt thumbnails in a horizontal scroll, each
/// with a remove button hanging over its corner. The scroll view clips, as
/// React Native's does; `insets` leave the buttons room inside it.
final class AttachmentStripView: UIScrollView {
    var onRemove: ((String) -> Void)?

    var insets: AgentInputCardLayout.AttachmentInsets = .panel {
        didSet { if insets != oldValue { setNeedsLayout() } }
    }

    var attachments: [AgentInputAttachmentPreview] = [] {
        didSet {
            guard attachments != oldValue else { return }
            rebuild()
        }
    }

    private var thumbnails: [AttachmentThumbnailView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        alwaysBounceHorizontal = false
        clipsToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func rebuild() {
        let existing = Dictionary(thumbnails.map { ($0.attachment.id, $0) }, uniquingKeysWith: { first, _ in first })
        var next: [AttachmentThumbnailView] = []
        for attachment in attachments {
            if let view = existing[attachment.id], view.attachment == attachment {
                next.append(view)
            } else {
                let view = AttachmentThumbnailView(attachment: attachment)
                view.onRemove = { [weak self] id in self?.onRemove?(id) }
                addSubview(view)
                next.append(view)
            }
        }
        let kept = Set(next.map(ObjectIdentifier.init))
        for view in thumbnails where !kept.contains(ObjectIdentifier(view)) {
            view.removeFromSuperview()
        }
        thumbnails = next
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let placed = AgentInputCardLayout.attachmentThumbnails(count: thumbnails.count, insets: insets)
        for (view, frame) in zip(thumbnails, placed.frames) {
            view.setLayoutFrame(frame)
        }
        contentSize = CGSize(width: placed.contentWidth, height: bounds.height)
    }
}

/// One thumbnail: the picture (cover, radius 8) in a 1pt divider ring,
/// and an 18pt remove button.
final class AttachmentThumbnailView: UIView {
    let attachment: AgentInputAttachmentPreview
    var onRemove: ((String) -> Void)?
    private let imageView = UIImageView()
    /// The ring is a view of its own under the remove button: a layer's
    /// border is drawn over its sublayers, and would cross the button.
    private let ring = UIView()
    private let removeButton = ComposerIconButton(icon: .ionicons("close"), size: AgentInputCardLayout.Metrics.attachmentRemoveIconSize)

    init(attachment: AgentInputAttachmentPreview) {
        self.attachment = attachment
        super.init(frame: .zero)
        layer.cornerRadius = AgentInputCardLayout.Metrics.attachmentRadius
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = AgentInputCardLayout.Metrics.attachmentRadius
        imageView.alpha = 0
        addSubview(imageView)
        ring.layer.cornerRadius = AgentInputCardLayout.Metrics.attachmentRadius
        ring.layer.borderWidth = AgentInputCardLayout.Metrics.attachmentBorder
        ring.isUserInteractionEnabled = false
        addSubview(ring)
        removeButton.backgroundColor = UIColor(Palette.surfaceHigh)
        removeButton.addTarget(self, action: #selector(removeTapped), for: .touchUpInside)
        removeButton.accessibilityIdentifier = "composer-attachment-remove"
        addSubview(removeButton)
        accessibilityIdentifier = "composer-attachment"
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
        load()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func applyColors() {
        ring.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }

    private func load() {
        let url = attachment.fileURL
        let side = AgentInputCardLayout.Metrics.attachmentSize * max(1, traitCollection.displayScale)
        Task { [weak self] in
            let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                guard let image = UIImage(contentsOfFile: url.path) else { return nil }
                let scale = side / max(1, min(image.size.width, image.size.height))
                let size = CGSize(width: image.size.width * min(1, scale), height: image.size.height * min(1, scale))
                return image.preparingThumbnail(of: size) ?? image
            }.value
            guard let self, let image else { return }
            self.imageView.image = image
            // expo-image's `transition={150}`.
            UIView.animate(withDuration: 0.15) { self.imageView.alpha = 1 }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = bounds
        ring.frame = bounds
        removeButton.frame = AgentInputCardLayout.attachmentRemoveButton
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) || removeButton.frame.insetBy(dx: -4, dy: -4).contains(point)
    }

    @objc private func removeTapped() {
        onRemove?(attachment.id)
    }
}
#endif
