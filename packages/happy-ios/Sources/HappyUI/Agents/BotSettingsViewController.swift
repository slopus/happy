#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A personal bot's settings on a Happy Cloud server, pushed from its
/// profile (`SessionDetailViewController`) where its `editable` says the
/// person may change it: its picture, name and instructions, as the
/// server keeps them (`BotEdit`). Save sends what changed, and the server
/// deploys it to every member's conversation at its next turn. A shared
/// bot, or one the person may not change, has no such page. Back with
/// unsaved changes asks first, as Instructions does. Frames are
/// `BotSettingsLayout`'s.
final class BotSettingsViewController: UIViewController, UITextFieldDelegate, UITextViewDelegate {
    private let session: Session
    let botId: String
    /// The face its home row wears, until a picture is picked here.
    private let mark: Row.Mark
    /// Nil until the bot is read.
    private(set) var edit: BotEdit?
    private var saving = false
    private var failed = false
    private var problem: String?
    private var keyboardTop: CGFloat?
    private var photoImage: UIImage?

    private let scroll = DetailScrollView()
    let avatar = DetailMarkView()
    private let picked = UIImageView()
    let photoButton = UIButton(type: .system)
    private let nameHeading = DetailTileView.heading()
    private let nameCard = DetailCardView()
    let nameField = UITextField()
    private let instructionsHeading = DetailTileView.heading()
    private let instructionsCard = DetailCardView()
    let instructionsView = UITextView(usingTextLayoutManager: true)
    private let placeholder = UILabel()
    let note = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private lazy var picker = ProfilePhotoPicker { [weak self] in self?.choose($0) }
    private lazy var saveItem = UIBarButtonItem(title: Strings.Bots.save, primaryAction: UIAction { [weak self] _ in
        Task { await self?.save() }
    })
    private lazy var retryItem = UIBarButtonItem(title: Strings.Bots.tryAgain, primaryAction: UIAction { [weak self] _ in self?.load() })

    private static let captionFont = Fonts.ui(.semiBold, size: 17)

    init(session: Session, botId: String, mark: Row.Mark) {
        self.session = session
        self.botId = botId
        self.mark = mark
        super.init(nibName: nil, bundle: nil)
        title = Strings.Bots.editTitle
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "bot-settings"
        navigationItem.largeTitleDisplayMode = .never
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)

        avatar.images = session.images
        avatar.mark = mark
        avatar.isUserInteractionEnabled = true
        avatar.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pickPhoto)))
        picked.contentMode = .scaleAspectFill
        picked.clipsToBounds = true
        picked.layer.cornerRadius = BotSettingsLayout.Metrics.avatarRadius
        picked.layer.cornerCurve = .continuous
        picked.isHidden = true
        avatar.addSubview(picked)
        photoButton.titleLabel?.font = Self.captionFont
        photoButton.tintColor = UIColor(Palette.settingsPrimary)
        photoButton.setTitle(Strings.Bots.changePhoto, for: .normal)
        photoButton.accessibilityIdentifier = "bot-settings-photo"
        photoButton.addTarget(self, action: #selector(pickPhoto), for: .touchUpInside)

        nameHeading.text = Strings.Bots.name.uppercased()
        nameField.font = Fonts.ui(.regular, size: 17)
        nameField.textColor = UIColor(Palette.settingsText)
        nameField.tintColor = UIColor(Palette.settingsPrimary)
        nameField.autocapitalizationType = .words
        nameField.returnKeyType = .next
        nameField.clearButtonMode = .whileEditing
        nameField.accessibilityIdentifier = "bot-settings-name"
        nameField.accessibilityLabel = Strings.Bots.name
        nameField.delegate = self
        nameField.addTarget(self, action: #selector(nameEdited), for: .editingChanged)

        instructionsHeading.text = Strings.Bots.instructions.uppercased()
        instructionsView.backgroundColor = .clear
        instructionsView.font = Fonts.ui(.regular, size: 17)
        instructionsView.textColor = UIColor(Palette.settingsText)
        instructionsView.tintColor = UIColor(Palette.settingsPrimary)
        instructionsView.isScrollEnabled = false
        instructionsView.textContainerInset = .zero
        instructionsView.textContainer.lineFragmentPadding = 0
        instructionsView.accessibilityIdentifier = "bot-settings-instructions"
        instructionsView.accessibilityLabel = Strings.Bots.instructions
        instructionsView.delegate = self
        placeholder.font = instructionsView.font
        placeholder.textColor = UIColor(Palette.inputPlaceholder)
        placeholder.numberOfLines = 0
        placeholder.text = Strings.Bots.instructionsPlaceholder
        placeholder.isUserInteractionEnabled = false

        note.font = Fonts.ui(.regular, size: 13)
        note.numberOfLines = 0
        note.accessibilityIdentifier = "bot-settings-note"
        spinner.hidesWhenStopped = true
        for subview in [avatar, photoButton, nameHeading, nameCard, nameField, instructionsHeading, instructionsCard, instructionsView, placeholder, note, spinner] as [UIView] {
            scroll.addSubview(subview)
        }
        saveItem.accessibilityIdentifier = "bot-settings-save"
        navigationItem.backAction = UIAction { [weak self] _ in self?.leave() }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        load()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }

    // MARK: Reading

    func load() {
        failed = false
        spinner.startAnimating()
        update()
        let client = session.client
        let botId = botId
        Task { [weak self] in
            let read = try? await client.bot(botId)
            guard let self else { return }
            spinner.stopAnimating()
            if let read { show(BotEdit(read)) } else if edit == nil { failed = true }
            update()
        }
    }

    /// `next` in the fields; the picture picked here stays.
    func show(_ next: BotEdit) {
        var next = next
        next.photo = edit?.photo
        edit = next
        if nameField.text != next.name { nameField.text = next.name }
        if instructionsView.text != next.instructions { instructionsView.text = next.instructions }
    }

    // MARK: Editing

    @objc private func pickPhoto() {
        guard edit != nil, !saving else { return }
        picker.present(from: self)
    }

    /// Shows `image` as the picture to save, made JPEG at once.
    func choose(_ image: UIImage) {
        photoImage = image
        picked.image = image
        picked.isHidden = false
        Task { [weak self] in
            let jpeg = await ProfilePhotoPicker.jpeg(image)
            guard let self, photoImage === image else { return }
            edit?.photo = jpeg
            update()
        }
    }

    @objc private func nameEdited() {
        edit?.name = nameField.text ?? ""
        problem = nil
        update()
    }

    func textViewDidChange(_ textView: UITextView) {
        edit?.instructions = textView.text ?? ""
        problem = nil
        update()
        view.layoutIfNeeded()
        // The caret stays in sight as the card grows under it.
        if let range = textView.selectedTextRange {
            let caret = textView.convert(textView.caretRect(for: range.end), to: scroll)
            scroll.scrollRectToVisible(caret.insetBy(dx: 0, dy: -12), animated: false)
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        instructionsView.becomeFirstResponder()
        return false
    }

    // MARK: Saving

    func save() async {
        guard let edit, edit.canSave, !saving else { return }
        saving = true
        problem = nil
        view.endEditing(true)
        update()
        do {
            let saved = try await edit.save(with: session.client)
            saving = false
            self.edit = BotEdit(saved)
            Haptics.play(.renamed)
            navigationController?.popViewController(animated: true)
        } catch BotEdit.SaveError.conflict(let newer) {
            // Theirs under what was typed here: the person decides again.
            var rebased = edit
            rebased.rebase(on: newer)
            show(rebased)
            problem = Strings.Bots.changedElsewhere
        } catch AgentClientError.status(403, _, _) {
            problem = Strings.Bots.notAllowed
        } catch {
            problem = Strings.Bots.saveFailed
        }
        saving = false
        update()
    }

    private func leave() {
        guard edit?.isDirty == true, !saving else { navigationController?.popViewController(animated: true); return }
        let alert = UIAlertController(title: Strings.Bots.discardTitle, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Bots.keepEditing, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Bots.discard, style: .destructive) { [weak self] _ in
            self?.navigationController?.popViewController(animated: true)
        })
        present(alert, animated: true)
    }

    // MARK: State

    private func update() {
        let ready = edit != nil && !saving
        for control in [nameField, photoButton] as [UIControl] { control.isEnabled = ready }
        instructionsView.isEditable = ready
        avatar.isUserInteractionEnabled = ready
        for shown in [nameField, instructionsView, nameCard, instructionsCard, nameHeading, instructionsHeading, avatar, photoButton] as [UIView] {
            shown.isHidden = edit == nil
        }
        placeholder.isHidden = edit == nil || !(instructionsView.text ?? "").isEmpty
        navigationItem.rightBarButtonItem = edit != nil ? saveItem : (failed ? retryItem : nil)
        saveItem.isEnabled = edit?.canSave == true && !saving
        // Swiping back would lose what was typed: Back asks instead.
        navigationController?.interactivePopGestureRecognizer?.isEnabled = edit?.isDirty != true
        let (words, warning): (String, Bool) = if let problem { (problem, true) }
            else if failed { (Strings.Bots.loadFailed, true) }
            else if let shown = edit?.problem, edit?.isDirty == true { (Strings.Bots.problem(shown), true) }
            else if edit == nil { ("", false) }
            else { (Strings.Bots.about, false) }
        note.text = words
        note.textColor = UIColor(warning ? Palette.textDestructive : Palette.settingsSecondary)
        view.setNeedsLayout()
    }

    // MARK: Layout

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let screen = view.window?.screen,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(end, from: screen.coordinateSpace)
        keyboardTop = local.minY >= view.bounds.maxY || local.isEmpty ? nil : local.minY
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if scroll.frame != view.bounds { scroll.frame = view.bounds }
        let width = scroll.readableColumn(width: view.bounds.width)
        let textWidth = BotSettingsLayout.instructionsTextWidth(width: width)
        let caption = ((photoButton.title(for: .normal) ?? "") as NSString).size(withAttributes: [.font: Self.captionFont]).width
        let measuring = CGSize(width: textWidth, height: .greatestFiniteMagnitude)
        let noteWidth = BotSettingsLayout.noteWidth(width: width)
        let layout = BotSettingsLayout(
            width: width, captionWidth: caption,
            instructionsHeight: instructionsView.sizeThatFits(measuring).height,
            noteHeight: note.text?.isEmpty == false ? note.sizeThatFits(CGSize(width: noteWidth, height: .greatestFiniteMagnitude)).height : 0
        )
        avatar.frame = layout.avatar
        picked.frame = avatar.bounds
        photoButton.frame = layout.photoButton
        nameHeading.frame = layout.nameHeading
        nameCard.frame = layout.nameCard
        nameField.frame = layout.nameText
        instructionsHeading.frame = layout.instructionsHeading
        instructionsCard.frame = layout.instructionsCard
        instructionsView.frame = layout.instructionsText
        placeholder.frame = CGRect(origin: layout.instructionsText.origin, size: placeholder.sizeThatFits(measuring))
        note.isHidden = layout.note == nil
        if let frame = layout.note { note.frame = frame }
        spinner.center = CGPoint(x: layout.avatar.midX, y: layout.avatar.midY)
        let bottom = keyboardTop.map { max(0, view.bounds.maxY - $0) } ?? 0
        if scroll.contentInset.bottom != bottom {
            scroll.contentInset.bottom = bottom
            scroll.verticalScrollIndicatorInsets.bottom = bottom
        }
        let size = CGSize(width: width, height: layout.contentHeight)
        if scroll.contentSize != size { scroll.contentSize = size }
    }
}
#endif
