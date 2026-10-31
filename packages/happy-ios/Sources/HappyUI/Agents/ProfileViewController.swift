#if canImport(UIKit)
import HappyCore
import HappyLayout
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The person's own profile on a paired computer, opened from Settings'
/// Profile row: their picture, large and round, with "Change Photo" (the
/// system's photo picker) under it, the name as a field in a settings
/// card, and "Remove Photo" while there is a picture. A change shows at
/// once and stays until the computer answers (`ProfileSource`); a failure
/// puts the computer's back and says so.
final class ProfileViewController: UIViewController, UITextFieldDelegate, PHPickerViewControllerDelegate {
    private let source: ProfileSource
    private let scroll = UIScrollView()
    private let avatar = UIImageView()
    private let changePhoto = UIButton(type: .system)
    /// Where the name is typed, over its card's row.
    let nameField = UITextField()
    private var cards: [SettingsCardView] = []
    private var rows: [[SettingsRow]] = []
    private var watch: Watch?
    private var appeared = false

    /// What the page shows now, card by card: for the tests.
    var shownRowIDs: [[String]] { rows.map { $0.map(\.id) } }
    /// Runs the row `id`'s action, as a finger on it would.
    func tapRow(_ id: String) { rows.joined().first { $0.id == id }?.action?() }
    var shownPhoto: UIImage? { avatar.image === Self.placeholder ? nil : avatar.image }

    init(source: ProfileSource) {
        self.source = source
        super.init(nibName: nil, bundle: nil)
        title = Strings.Profile.title
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private static let placeholder = Glyphs.image("person-outline", size: 48)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "profile"
        navigationItem.largeTitleDisplayMode = .never
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        HeaderBar.edge(scroll, in: self)
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = ProfileLayout.Metrics.avatar / 2
        avatar.tintColor = UIColor(Palette.settingsText)
        avatar.accessibilityIdentifier = "profile-avatar"
        avatar.isUserInteractionEnabled = true
        avatar.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pickPhoto)))
        scroll.addSubview(avatar)
        changePhoto.setTitle(Strings.Profile.changePhoto, for: .normal)
        changePhoto.titleLabel?.font = SettingsCardView.RowView.titleFont
        changePhoto.tintColor = UIColor(Palette.textLink)
        changePhoto.accessibilityIdentifier = "profile-change-photo"
        changePhoto.addTarget(self, action: #selector(pickPhoto), for: .touchUpInside)
        scroll.addSubview(changePhoto)
        nameField.font = SettingsCardView.RowView.titleFont
        nameField.textColor = UIColor(Palette.settingsText)
        nameField.tintColor = UIColor(Palette.settingsPrimary)
        nameField.placeholder = Strings.Profile.name
        nameField.returnKeyType = .done
        nameField.autocapitalizationType = .words
        nameField.autocorrectionType = .no
        nameField.clearButtonMode = .whileEditing
        nameField.textContentType = .name
        nameField.accessibilityIdentifier = "profile-name"
        nameField.delegate = self
        watch = source.watch { [weak self] in self?.apply() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Every time it shows, not only when the computer says so.
        source.refresh()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Going back keeps a name being typed.
        if nameField.isFirstResponder { nameField.resignFirstResponder() }
    }

    // MARK: Showing

    private func apply() {
        let state = source.state
        if let photo = source.photo {
            avatar.image = photo
            avatar.contentMode = .scaleAspectFill
            avatar.backgroundColor = nil
        } else {
            avatar.image = Self.placeholder
            avatar.contentMode = .center
            avatar.backgroundColor = UIColor(Palette.settingsAddFill)
        }
        // Never under the person's fingers.
        if !nameField.isFirstResponder, nameField.text != state.name { nameField.text = state.name }
        var rows: [[SettingsRow]] = [[SettingsRow(id: "profile-name", title: "", accessory: .none, action: { [weak self] in self?.nameField.becomeFirstResponder() })]]
        if state.hasPhoto {
            rows.append([SettingsRow(id: "remove-photo", title: Strings.Profile.removePhoto, accessory: .none, destructive: true, action: { [weak self] in self?.removePhoto() })])
        }
        guard rows.map({ $0.map(\.id) }) != shownRowIDs || cards.isEmpty else { return }
        self.rows = rows
        while cards.count < rows.count { let card = SettingsCardView(); scroll.insertSubview(card, belowSubview: changePhoto); cards.append(card) }
        while cards.count > rows.count { cards.removeLast().removeFromSuperview() }
        if nameField.superview == nil { scroll.addSubview(nameField) }
        if appeared {
            UIView.animate(withDuration: 0.2) { self.view.layoutIfNeeded() }
        } else {
            view.setNeedsLayout()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        scroll.frame = view.bounds
        let specs = rows.map { card in
            card.map { SettingsLayout.RowSpec(hasIcon: $0.icon != nil, valueWidth: SettingsCardView.valueWidth($0.value), accessory: $0.accessory) }
        }
        let layout = ProfileLayout(width: width, buttonWidth: changePhoto.titleLabel?.intrinsicContentSize.width ?? 0, cards: specs)
        avatar.frame = layout.avatar
        changePhoto.frame = layout.changePhoto
        nameField.frame = layout.nameField
        for (index, card) in cards.enumerated() where layout.cards.indices.contains(index) {
            card.frame = layout.cards[index].frame
            card.show(rows[index], layout: layout.cards[index])
        }
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    // MARK: Name

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        let name = (textField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // A name can't be cleared: an empty field shows the name again.
        guard !name.isEmpty, name != source.state.name else {
            textField.text = source.state.name
            return
        }
        textField.text = name
        save(name)
    }

    /// Shown at once by the source; an alert if the computer refuses it.
    private func save(_ name: String) {
        Haptics.play(.renamed)
        let saving = source.rename(name)
        Task { [weak self, source] in
            do {
                try await saving.value
            } catch {
                guard let self else { return }
                if !nameField.isFirstResponder { nameField.text = source.state.name }
                fail(Strings.Profile.couldNotSave, error)
            }
        }
    }

    private func fail(_ title: String, _ error: Error) {
        let message = Store.describe(error)
        // Gone back already: Settings is where it is said.
        let host = view.window != nil ? self : navigationController?.topViewController ?? self
        guard host.view.window != nil, host.presentedViewController == nil else { return }
        Alerts.show(title, message.isEmpty ? error.localizedDescription : message, on: host)
    }

    // MARK: Photo

    @objc private func pickPhoto() {
        guard presentedViewController == nil else { return }
        if nameField.isFirstResponder { nameField.resignFirstResponder() }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        present(picker, animated: true)
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let item = results.first.map { PickedPhoto(provider: $0.itemProvider) }
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            guard let item else { return }
            Task { [weak self] in
                guard let image = await Self.load(item) else { return }
                self?.setPhoto(image)
            }
        }
    }

    /// The picker's file only lives inside its callback, so it is decoded,
    /// cut square and shrunk there, off the main thread.
    private nonisolated static func load(_ item: PickedPhoto) async -> UIImage? {
        await withCheckedContinuation { continuation in
            _ = item.provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { @Sendable url, _ in
                guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return continuation.resume(returning: nil) }
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 2048,
                ]
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return continuation.resume(returning: nil) }
                continuation.resume(returning: ProfileSource.prepare(UIImage(cgImage: image)))
            }
        }
    }

    func setPhoto(_ image: UIImage) {
        let saving = source.setPhoto(image)
        Task { [weak self] in
            do {
                try await saving.value
            } catch {
                self?.fail(Strings.Profile.couldNotChangePhoto, error)
            }
        }
    }

    private func removePhoto() {
        let removing = source.removePhoto()
        Task { [weak self] in
            do {
                try await removing.value
            } catch {
                self?.fail(Strings.Profile.couldNotRemovePhoto, error)
            }
        }
    }
}

/// The picker's item. NSItemProvider is safe to hand across threads (its
/// loads call back on their own queues), but this SDK doesn't mark it
/// Sendable.
private struct PickedPhoto: @unchecked Sendable {
    let provider: NSItemProvider
}
#endif
