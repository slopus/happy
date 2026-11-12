#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Create your profile, as agreed with desktop: a Happy Cloud member's name
/// and picture, asked once, before a server that has neither opens. The
/// picture is round over Add photo (Change photo once there is one), the
/// person's placeholder until then with a camera badge; either opens the
/// photo picker Settings › Profile uses. The name is offered as Apple gave
/// it, else as the server suggests it, with the keyboard up.
///
/// Continue spins while `save` keeps the name, then the picture: the name
/// first, as the server refuses everything else until there is one, and on
/// until `finished` has opened the server. A name that isn't kept says so
/// under the field, in the same words whatever went wrong, in room kept for
/// it; a picture that isn't is said once the person has landed, and never
/// holds them up. Back leaves without saving anything.
final class CloudProfileViewController: CloudStageViewController, UITextFieldDelegate {
    /// Saves the name, then `photo` (JPEG) when there is one; throws when
    /// the name isn't saved, else answers whether the picture was.
    typealias Save = @MainActor (_ name: String, _ photo: Data?) async throws -> Bool

    private let save: Save
    /// What the placeholder is picked by: the server's identity, as the
    /// app seeds that server's own picture (`AgentConnections.placeholderSeed`),
    /// never a name, so a name offered late or typed never swaps it.
    let seed: String
    let avatar = UIImageView()
    private let placeholder = AvatarPlaceholderSlot()
    let badge = UIView()
    private let badgeGlyph = UIImageView()
    let photoButton = UIButton(type: .system)
    let nameField = CloudField(prefix: nil, placeholder: Strings.CloudConnect.profileNamePlaceholder)
    let status = StartGalleryView.bodyLabel("")
    private lazy var picker = ProfilePhotoPicker { [weak self] in self?.choose($0) }
    /// The picture picked here, kept on the phone until Continue.
    private(set) var photo: UIImage?
    /// Told once: whether the picture was saved, or nil when the person
    /// left without saving. Continue spins until it returns.
    var finished: ((Bool?) async -> Void)?
    private var done = false

    private static let buttonFont = Fonts.ui(.semiBold, size: 17)

    init(context: AppContext, handle: String, prefill: String?, seed: String, save: @escaping Save) {
        let offered = prefill?.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = offered?.isEmpty == false ? offered : nil
        self.save = save
        self.seed = seed
        super.init(context: context, scene: nil, title: Strings.CloudConnect.profileTitle, body: Strings.CloudConnect.profileMessage(handle),
                   primary: Strings.CloudConnect.continueAction)
        nameField.text.text = named
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-profile"
        primary.accessibilityIdentifier = "cloud-profile-continue"
        primary.action = { [weak self] in await self?.submit() }

        avatar.clipsToBounds = true
        avatar.contentMode = .scaleAspectFill
        avatar.layer.cornerRadius = CloudProfileLayout.Metrics.avatar / 2
        avatar.backgroundColor = UIColor(Palette.startDot)
        avatar.isUserInteractionEnabled = true
        avatar.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pickPhoto)))
        avatar.accessibilityIdentifier = "cloud-profile-avatar"
        avatar.isAccessibilityElement = true
        avatar.accessibilityTraits = .button
        placeholder.liveHost = avatar
        badge.isUserInteractionEnabled = false
        badge.layer.borderWidth = CloudProfileLayout.Metrics.badgeBorder
        badgeGlyph.image = Glyphs.image("camera", size: CloudProfileLayout.Metrics.badgeGlyph).withRenderingMode(.alwaysTemplate)
        badgeGlyph.contentMode = .center
        badge.addSubview(badgeGlyph)
        photoButton.titleLabel?.font = Self.buttonFont
        photoButton.accessibilityIdentifier = "cloud-profile-photo"
        photoButton.addTarget(self, action: #selector(pickPhoto), for: .touchUpInside)
        for subview in [avatar, badge, photoButton] { scroll.addSubview(subview) }

        let field = nameField.text
        field.autocapitalizationType = .words
        field.textContentType = .name
        field.keyboardType = .default
        field.returnKeyType = .continue
        field.accessibilityIdentifier = "cloud-profile-name"
        field.accessibilityLabel = Strings.CloudConnect.profileNamePlaceholder
        field.delegate = self
        field.addTarget(self, action: #selector(edited), for: .editingChanged)
        status.textColor = UIColor(Palette.textDestructive)
        for subview in [nameField, status] { content.addSubview(subview) }
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        showPhoto()
        edited()
    }

    private func applyColors() {
        let ink = UIColor(Palette.startText).resolvedColor(with: traitCollection)
        let ground = StartViewController.Colors.grain.back.resolvedColor(with: traitCollection)
        badge.backgroundColor = ink
        badge.layer.borderColor = ground.cgColor
        badgeGlyph.tintColor = ground
        photoButton.tintColor = ink
    }

    /// The name has the keyboard until it is saved.
    override var typingField: UITextField? { done ? nil : nameField.text }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Back, or the whole flow put away: nothing saved.
        guard !done, isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true else { return }
        done = true
        let finished = finished
        Task { await finished?(nil) }
    }

    // MARK: Layout

    override var artSide: CGFloat { CloudProfileLayout.Metrics.avatar }

    override var captionSize: CGSize {
        let title = photoButton.title(for: .normal) ?? ""
        return CloudProfileLayout.caption(textWidth: (title as NSString).size(withAttributes: [.font: Self.buttonFont]).width)
    }

    override func layoutArt(_ art: CGRect, caption: CGRect) {
        avatar.setLayoutFrame(art)
        let badgeFrame = CloudProfileLayout.badge(avatar: art)
        badge.setLayoutFrame(badgeFrame)
        badge.layer.cornerRadius = badgeFrame.width / 2
        badgeGlyph.setLayoutFrame(badge.bounds)
        photoButton.setLayoutFrame(caption)
    }

    /// The status line's room is kept whether or not it says anything.
    private func items(width: CGFloat, steady: Bool = false) -> [CloudColumnLayout.Item] {
        [
            .init(height: CloudField.height),
            .init(height: steady ? Self.statusRoom : Self.statusHeight(status, width: width), gap: 12),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width, steady: true), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        nameField.setLayoutFrame(frames[0])
        status.setLayoutFrame(frames[1])
    }

    // MARK: The picture

    @objc private func pickPhoto() {
        picker.present(from: self)
    }

    /// Shows `image` as the picture to save, as picking it does.
    func choose(_ image: UIImage) {
        photo = image
        showPhoto()
    }

    private func showPhoto() {
        if let photo {
            placeholder.show(seed: nil, side: CloudProfileLayout.Metrics.avatar) { _ in }
            avatar.image = photo
        } else {
            placeholder.show(seed: seed, side: CloudProfileLayout.Metrics.avatar) { [weak self] image in
                guard let self, self.photo == nil else { return }
                avatar.image = image
            }
        }
        let title = photo == nil ? Strings.CloudConnect.addPhoto : Strings.CloudConnect.changePhoto
        photoButton.setTitle(title, for: .normal)
        avatar.accessibilityLabel = title
        relayout()
    }

    // MARK: The name

    private var name: String { (nameField.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    @objc func edited() { primary.isEnabled = !name.isEmpty }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if primary.isEnabled { primary.tapped() }
        return false
    }

    /// Continue: the name, then the picture. Like `join`, it leaves
    /// `isLoading` to the button.
    /// Saved, the screen stays as it is, keyboard and all, while the
    /// server opens and the flow ends over it.
    func submit() async {
        let name = name
        guard !name.isEmpty, !done else { return }
        status.string = ""
        relayout()
        setBusy(true)
        let picked = photo
        var jpeg: Data?
        if let picked { jpeg = await ProfilePhotoPicker.jpeg(picked) }
        do {
            let photoSaved = try await save(name, jpeg)
            done = true
            await finished?(photoSaved && (picked == nil || jpeg != nil))
        } catch {
            status.string = Strings.CloudConnect.nameFailed
            relayout()
            setBusy(false)
        }
    }

    /// Nothing else is touched while saving, Back included.
    private func setBusy(_ busy: Bool) {
        navigationItem.hidesBackButton = busy
        navigationItem.leftBarButtonItem?.isEnabled = !busy
        navigationController?.interactivePopGestureRecognizer?.isEnabled = !busy
        nameField.text.isEnabled = !busy
        avatar.isUserInteractionEnabled = !busy
        photoButton.isEnabled = !busy
    }

    #if DEBUG
    /// A made-up picture for the harness: a sunset over the sea.
    static func previewPhoto() -> UIImage {
        let side: CGFloat = 512
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            let colors = [UIColor(red: 0.98, green: 0.62, blue: 0.36, alpha: 1).cgColor, UIColor(red: 0.85, green: 0.33, blue: 0.52, alpha: 1).cgColor]
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1]) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: side * 0.62), options: [])
            }
            UIColor(red: 1, green: 0.88, blue: 0.55, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(x: side * 0.32, y: side * 0.36, width: side * 0.36, height: side * 0.36)).fill()
            UIColor(red: 0.16, green: 0.24, blue: 0.48, alpha: 1).setFill()
            UIRectFill(CGRect(x: 0, y: side * 0.6, width: side, height: side * 0.4))
        }
    }
    #endif
}
#endif
