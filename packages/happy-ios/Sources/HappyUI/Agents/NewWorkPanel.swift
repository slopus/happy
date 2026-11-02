#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What new work will be, in the middle of its empty conversation
/// (`NewWorkLayout`), on both homes. The composer stays where it is, and
/// its first message makes what was chosen here.
///
/// - `.work` (Happy Agent): Task (the default) or Bot, an optional name,
///   and a line saying what that kind is. Desktop asks a bot's name the
///   same way ("generated if left blank"); here a task's too.
/// - `.session` (a legacy account): the computer, shown only when the
///   account has more than one, the folder on it, and the harness. Where
///   the computer's Happy Agent makes bots or tasks, Session | Bot | Task
///   heads it, as home's dock did: a task asks only the computer, a bot
///   the computer and its name, which it can't go without.
final class NewWorkPanel: UIView, UITextFieldDelegate {
    enum Mode {
        case work
        case session
    }

    let mode: Mode
    let kind = UISegmentedControl(items: [Strings.newWorkTask, Strings.newWorkBot])
    let name = UITextField()
    private let field = UIView()
    /// `.session`'s rows.
    let machine = NewWorkMenuRow(icon: .ionicons("desktop-outline"), showsStatus: true)
    let folder = NewWorkMenuRow(icon: .ionicons("folder-outline"))
    let harness = NewWorkMenuRow(icon: .ionicons("hardware-chip-outline"))
    private let note = UILabel()

    /// `.session`: why the bot's name is refused, until it is typed into:
    /// a red edge on the field and the reason, in red, in place of its
    /// placeholder. Nothing is added around the field, so nothing moves.
    var validation: String? {
        didSet {
            guard validation != oldValue else { return }
            field.layer.borderWidth = validation == nil ? 0 : 1
            name.attributedPlaceholder = validation.map { Self.placeholder($0, color: UIColor(Palette.textDestructive)) }
                ?? Self.placeholder(NewSessionChoices.botNamePlaceholder)
            name.accessibilityHint = validation
        }
    }

    /// `.session`: the bot needs a name before it is made. The field takes
    /// the keyboard and says why; false when what is typed hides the
    /// reason, for the caller to say it another way.
    @discardableResult
    func askName(_ reason: String) -> Bool {
        validation = reason
        name.becomeFirstResponder()
        Haptics.play(.pick)
        return name.text?.isEmpty ?? true
    }

    /// Every change, as it is made.
    var onChange: ((NewTask.Choice) -> Void)?
    /// Return in the name: on to the composer.
    var onReturn: (() -> Void)?
    /// `.session`: Session | Bot | Task picked.
    var onSessionKind: ((HomeDockKind) -> Void)?
    /// `.session`: the bot's name as typed; returns what the field keeps.
    var onBotName: ((String) -> String)?

    var choice: NewTask.Choice {
        get { NewTask.Choice(kind: kind.selectedSegmentIndex == 1 ? .bot : .task, name: name.text ?? "") }
        set {
            kind.selectedSegmentIndex = newValue.kind == .bot ? 1 : 0
            if name.text != newValue.name { name.text = newValue.name }
            showNote()
        }
    }

    /// `.session`: whether the computer is asked.
    var showsMachine = false {
        didSet {
            guard showsMachine != oldValue else { return }
            machine.isHidden = !showsMachine
            superview?.setNeedsLayout()
        }
    }

    /// `.session`: the kinds this computer makes; one alone hides the
    /// control.
    private(set) var sessionKinds: [HomeDockKind] = [.session]
    /// `.session`: what the first send makes.
    private(set) var sessionKind: HomeDockKind = .session

    /// `.session`: the kinds shown, those that can be picked (the rest
    /// show disabled), the one picked, and the bot's name.
    func setSessionKinds(_ kinds: [HomeDockKind], enabled: Set<HomeDockKind>? = nil, current: HomeDockKind, botName: String) {
        guard mode == .session else { return }
        if kinds != sessionKinds {
            sessionKinds = kinds
            kind.removeAllSegments()
            for (index, offered) in kinds.enumerated() {
                kind.insertSegment(withTitle: Strings.Home.composerKind(offered), at: index, animated: false)
            }
        }
        for (index, shown) in kinds.enumerated() {
            kind.setEnabled(enabled?.contains(shown) ?? true, forSegmentAt: index)
        }
        let current = kinds.contains(current) ? current : .session
        kind.selectedSegmentIndex = kinds.firstIndex(of: current) ?? 0
        if name.text != botName { name.text = botName }
        let hidesKind = kinds.count < 2
        guard current != sessionKind || kind.isHidden != hidesKind else { return }
        sessionKind = current
        kind.isHidden = hidesKind
        folder.isHidden = current != .session
        harness.isHidden = current != .session
        field.isHidden = current != .bot
        note.isHidden = current != .bot
        if current != .bot { validation = nil }
        if current != .bot, name.isFirstResponder { onReturn?() }
        superview?.setNeedsLayout()
    }

    init(mode: Mode) {
        self.mode = mode
        super.init(frame: .zero)
        accessibilityIdentifier = "new-work"
        kind.accessibilityIdentifier = "new-work-kind"
        kind.addTarget(self, action: #selector(kindChanged), for: .valueChanged)
        field.backgroundColor = UIColor(Palette.inputBackground)
        field.layer.cornerRadius = NewWorkLayout.Metrics.rowHeight / 2
        field.layer.cornerCurve = .continuous
        name.font = Fonts.ui(.regular, size: 16)
        name.textColor = UIColor(Palette.inputText)
        name.textAlignment = .center
        name.returnKeyType = .next
        name.delegate = self
        name.accessibilityIdentifier = "new-work-name"
        name.addTarget(self, action: #selector(nameChanged), for: .editingChanged)
        note.font = Fonts.ui(.regular, size: 13)
        note.textColor = UIColor(Palette.textSecondary)
        note.textAlignment = .center
        note.numberOfLines = 0
        field.addSubview(name)
        switch mode {
        case .work:
            kind.selectedSegmentIndex = 0
            name.attributedPlaceholder = Self.placeholder(Strings.newWorkName)
            name.autocapitalizationType = .sentences
            for view in [kind, field, note] { addSubview(view) }
            showNote()
        case .session:
            kind.accessibilityLabel = Strings.Home.composerKindLabel
            kind.removeAllSegments()
            kind.insertSegment(withTitle: Strings.Home.composerKind(.session), at: 0, animated: false)
            kind.selectedSegmentIndex = 0
            kind.isHidden = true
            name.attributedPlaceholder = Self.placeholder(NewSessionChoices.botNamePlaceholder)
            name.autocapitalizationType = .words
            field.isHidden = true
            note.text = Strings.Home.botLede
            note.isHidden = true
            machine.accessibilityIdentifier = "new-work-machine"
            folder.accessibilityIdentifier = "new-work-folder"
            harness.accessibilityIdentifier = "new-work-harness"
            machine.isHidden = true
            field.layer.borderColor = UIColor(Palette.textDestructive).cgColor
            for view in [kind, machine, folder, harness, field, note] { addSubview(view) }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private static func placeholder(_ text: String, color: UIColor = UIColor(Palette.inputPlaceholder)) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: Fonts.ui(.regular, size: 16),
            .foregroundColor: color,
        ])
    }

    /// `.session`'s rows, top to bottom, as the kind shows them.
    private var sessionRows: [UIView] {
        [machine, folder, harness, field].filter { !$0.isHidden }
    }

    private var measuredNote: Measurable { Self.measured(note) }

    private static func measured(_ label: UILabel) -> Measurable {
        Measurable { width in
            let size = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            return CGSize(width: ceil(size.width), height: ceil(size.height))
        }
    }

    /// Laid out between `top` and `bottom` in its superview, which it
    /// fills across; it places itself.
    func layout(width: CGFloat, top: CGFloat, bottom: CGFloat) -> NewWorkLayout {
        switch mode {
        case .work:
            return NewWorkLayout(
                width: width, top: top, bottom: bottom,
                kindHeight: kind.intrinsicContentSize.height, rows: 1,
                note: measuredNote
            )
        case .session:
            return NewWorkLayout(
                width: width, top: top, bottom: bottom,
                kindHeight: kind.isHidden ? nil : kind.intrinsicContentSize.height,
                givingWay: sessionRows.count,
                note: note.isHidden ? nil : measuredNote
            )
        }
    }

    func place(_ layout: NewWorkLayout) {
        frame = layout.block
        if let frame = layout.kind { kind.frame = frame }
        if let frame = layout.note { note.frame = frame }
        switch mode {
        case .work:
            field.frame = layout.rows[0]
        case .session:
            for (row, frame) in zip(sessionRows, layout.rows) { row.frame = frame }
            // Short of room the note gives way first (`NewWorkLayout`).
            note.alpha = layout.showsNote ? 1 : 0
        }
        name.frame = field.bounds.insetBy(dx: 16, dy: 0)
    }

    /// Only the controls take touches: a drag anywhere else is the
    /// transcript's, which takes the keyboard down.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let controls: [UIView] = mode == .work ? [kind, field] : [kind, machine, folder, harness, field]
        return controls.contains { !$0.isHidden && $0.frame.insetBy(dx: -8, dy: -8).contains(point) }
    }

    /// Made, or on its way: nothing here changes it now.
    var isLocked = false {
        didSet {
            kind.isEnabled = !isLocked
            name.isEnabled = !isLocked
            machine.isEnabled = !isLocked
            folder.isEnabled = !isLocked
            harness.isEnabled = !isLocked
        }
    }

    /// The first message is in: the panel fades, and the conversation is
    /// an ordinary one.
    func dismiss() {
        isLocked = true
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.alpha = 0
        } completion: { _ in
            self.isHidden = true
        }
    }

    private func showNote() {
        let text = kind.selectedSegmentIndex == 1 ? Strings.newWorkBotNote : Strings.newWorkTaskNote
        if note.text != text {
            note.text = text
            superview?.setNeedsLayout()
        }
    }

    @objc private func kindChanged() {
        Haptics.play(.pick)
        switch mode {
        case .work:
            showNote()
            onChange?(choice)
        case .session:
            guard sessionKinds.indices.contains(kind.selectedSegmentIndex) else { return }
            onSessionKind?(sessionKinds[kind.selectedSegmentIndex])
        }
    }

    @objc private func nameChanged() {
        switch mode {
        case .work:
            onChange?(choice)
        case .session:
            validation = nil
            guard let kept = onBotName?(name.text ?? ""), kept != name.text else { return }
            name.text = kept
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        onReturn?()
        return false
    }
}

/// One of `.session`'s rows: an icon, what is chosen, and the menu that
/// chooses it, on the name field's ground, centred. The computer's row
/// also says whether it answers, in a small chip on its top-right corner
/// (`NewWorkStatusLayout`): laid over the row, it takes no part in its
/// layout, so the icon and the name sit as in any row and a status
/// coming, going or changing moves nothing.
final class NewWorkMenuRow: UIButton {
    let showsStatus: Bool
    private let chip = UIView()
    private let statusLabel = UILabel()

    init(icon: Icon, showsStatus: Bool = false) {
        self.showsStatus = showsStatus
        super.init(frame: .zero)
        var configuration = UIButton.Configuration.plain()
        configuration.image = .icon(icon, size: 16)
        configuration.imagePadding = 8
        configuration.baseForegroundColor = UIColor(Palette.inputText)
        configuration.titleLineBreakMode = .byTruncatingMiddle
        configuration.background.backgroundColor = UIColor(Palette.inputBackground)
        configuration.cornerStyle = .capsule
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Fonts.ui(.regular, size: 16)
            return attributes
        }
        self.configuration = configuration
        showsMenuAsPrimaryAction = true
        if showsStatus {
            chip.backgroundColor = UIColor(Palette.surface)
            chip.layer.cornerRadius = NewWorkStatusLayout.height / 2
            chip.layer.cornerCurve = .continuous
            chip.layer.borderWidth = 1
            chip.layer.borderColor = UIColor(Palette.legacyDivider).cgColor
            chip.isUserInteractionEnabled = false
            chip.isHidden = true
            chip.accessibilityIdentifier = "new-work-machine-status"
            statusLabel.font = Fonts.ui(.medium, size: NewWorkStatusLayout.fontSize)
            statusLabel.lineBreakMode = .byTruncatingTail
            chip.addSubview(statusLabel)
            addSubview(chip)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var title: String {
        get { configuration?.title ?? "" }
        set {
            guard configuration?.title != newValue else { return }
            configuration?.title = newValue
            updateAccessibility()
        }
    }

    var icon: Icon? {
        didSet {
            guard let icon, icon != oldValue else { return }
            configuration?.image = .icon(icon, size: 16)
        }
    }

    /// The computer's row: "● Online", or a warning ("● Offline · 2h",
    /// "● Agent offline") in its colour, "● …" while the computers are
    /// still arriving; nil for no chip.
    var status: (text: String, color: UIColor)? {
        didSet {
            guard showsStatus, status?.text != oldValue?.text || status?.color != oldValue?.color else { return }
            statusLabel.text = status?.text
            statusLabel.textColor = status?.color
            chip.isHidden = status == nil
            setNeedsLayout()
            updateAccessibility()
        }
    }

    /// The chip's text, for tests.
    var statusText: String? { statusLabel.text }
    /// Where the chip is, in the row, for tests.
    var statusFrame: CGRect { chip.frame }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard showsStatus else { return }
        let text = statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: NewWorkStatusLayout.height))
        chip.frame = NewWorkStatusLayout.chip(rowWidth: bounds.width, textWidth: text.width)
        statusLabel.frame = chip.bounds.insetBy(dx: NewWorkStatusLayout.padding, dy: 0)
        bringSubviewToFront(chip)
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        chip.layer.borderColor = UIColor(Palette.legacyDivider).resolvedColor(with: traitCollection).cgColor
    }

    private func updateAccessibility() {
        accessibilityValue = [title, status?.text].compactMap { $0 }.joined(separator: ", ")
    }
}
#endif
