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
///   account has more than one, the folder on it, and the harness.
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
    let machine = NewWorkMenuRow(icon: .ionicons("desktop-outline"))
    let folder = NewWorkMenuRow(icon: .ionicons("folder-outline"))
    let harness = NewWorkMenuRow(icon: .ionicons("hardware-chip-outline"))
    private let note = UILabel()

    /// Every change, as it is made.
    var onChange: ((NewTask.Choice) -> Void)?
    /// Return in the name: on to the composer.
    var onReturn: (() -> Void)?

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

    init(mode: Mode) {
        self.mode = mode
        super.init(frame: .zero)
        accessibilityIdentifier = "new-work"
        switch mode {
        case .work:
            kind.selectedSegmentIndex = 0
            kind.accessibilityIdentifier = "new-work-kind"
            kind.addTarget(self, action: #selector(kindChanged), for: .valueChanged)
            field.backgroundColor = UIColor(Palette.inputBackground)
            field.layer.cornerRadius = NewWorkLayout.Metrics.rowHeight / 2
            field.layer.cornerCurve = .continuous
            name.font = Fonts.ui(.regular, size: 16)
            name.textColor = UIColor(Palette.inputText)
            name.attributedPlaceholder = NSAttributedString(string: Strings.newWorkName, attributes: [
                .font: Fonts.ui(.regular, size: 16),
                .foregroundColor: UIColor(Palette.inputPlaceholder),
            ])
            name.textAlignment = .center
            name.autocapitalizationType = .sentences
            name.returnKeyType = .next
            name.delegate = self
            name.accessibilityIdentifier = "new-work-name"
            name.addTarget(self, action: #selector(nameChanged), for: .editingChanged)
            note.font = Fonts.ui(.regular, size: 13)
            note.textColor = UIColor(Palette.textSecondary)
            note.textAlignment = .center
            note.numberOfLines = 0
            field.addSubview(name)
            for view in [kind, field, note] { addSubview(view) }
            showNote()
        case .session:
            machine.accessibilityIdentifier = "new-work-machine"
            folder.accessibilityIdentifier = "new-work-folder"
            harness.accessibilityIdentifier = "new-work-harness"
            machine.isHidden = true
            for view in [machine, folder, harness] { addSubview(view) }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Laid out between `top` and `bottom` in its superview, which it
    /// fills across; it places itself.
    func layout(width: CGFloat, top: CGFloat, bottom: CGFloat) -> NewWorkLayout {
        switch mode {
        case .work:
            let note = note
            return NewWorkLayout(
                width: width, top: top, bottom: bottom,
                kindHeight: kind.intrinsicContentSize.height, rows: 1,
                note: Measurable { width in
                    let size = note.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
                    return CGSize(width: ceil(size.width), height: ceil(size.height))
                }
            )
        case .session:
            return NewWorkLayout(width: width, top: top, bottom: bottom, kindHeight: nil, rows: showsMachine ? 3 : 2, note: nil)
        }
    }

    func place(_ layout: NewWorkLayout) {
        frame = layout.block
        switch mode {
        case .work:
            if let frame = layout.kind { kind.frame = frame }
            field.frame = layout.rows[0]
            name.frame = field.bounds.insetBy(dx: 16, dy: 0)
            if let frame = layout.note { note.frame = frame }
        case .session:
            var rows = layout.rows.makeIterator()
            if showsMachine, let frame = rows.next() { machine.frame = frame }
            if let frame = rows.next() { folder.frame = frame }
            if let frame = rows.next() { harness.frame = frame }
        }
    }

    /// Only the controls take touches: a drag anywhere else is the
    /// transcript's, which takes the keyboard down.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let controls: [UIView] = mode == .work ? [kind, field] : [machine, folder, harness]
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
        showNote()
        onChange?(choice)
    }

    @objc private func nameChanged() {
        onChange?(choice)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        onReturn?()
        return false
    }
}

/// One of `.session`'s rows: an icon, what is chosen, and the menu that
/// chooses it, on the name field's ground.
final class NewWorkMenuRow: UIButton {
    init(icon: Icon) {
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
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var title: String {
        get { configuration?.title ?? "" }
        set {
            guard configuration?.title != newValue else { return }
            configuration?.title = newValue
            accessibilityValue = newValue
        }
    }
}
#endif
