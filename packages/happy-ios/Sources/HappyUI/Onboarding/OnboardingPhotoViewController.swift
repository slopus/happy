#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The avatar gate: the person's picture, as Create your profile shows it
/// (round, the person's placeholder until one is picked, a camera badge),
/// under the words. Choose Photo opens the photo picker; once picked,
/// Continue saves it (`PUT /v0/profile/photo`) and the flow moves on as the
/// server says. Skip for Now while the gate is optional.
final class OnboardingPhotoViewController: CloudStageViewController, OnboardingStepScreen {
    typealias Save = @MainActor (Data) async throws -> Void

    private let save: Save
    private let seed: String
    let avatar = UIImageView()
    private let placeholder = AvatarPlaceholderSlot()
    private let badge = UIView()
    private let badgeGlyph = UIImageView()
    let status = CloudStageViewController.bodyLabel("")
    private lazy var picker = ProfilePhotoPicker { [weak self] in self?.choose($0) }
    private(set) var photo: UIImage?

    init(context: AppContext, seed: String, optional: Bool, save: @escaping Save) {
        self.save = save
        self.seed = seed
        super.init(context: context, scene: nil, title: Strings.CloudOnboarding.photoTitle, body: Strings.CloudOnboarding.photoBody,
                   primary: Strings.CloudOnboarding.choosePhoto, secondary: optional ? Strings.CloudOnboarding.skip : nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-photo"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.action = { [weak self] in await self?.primaryTapped() }
        avatar.clipsToBounds = true
        avatar.contentMode = .scaleAspectFill
        avatar.layer.cornerRadius = CloudProfileLayout.Metrics.avatar / 2
        avatar.backgroundColor = UIColor(Palette.startDot)
        avatar.isUserInteractionEnabled = true
        avatar.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pick)))
        avatar.isAccessibilityElement = true
        avatar.accessibilityTraits = .button
        avatar.accessibilityLabel = Strings.CloudOnboarding.choosePhoto
        placeholder.liveHost = avatar
        badge.isUserInteractionEnabled = false
        badge.layer.borderWidth = CloudProfileLayout.Metrics.badgeBorder
        badgeGlyph.image = Glyphs.image("camera", size: CloudProfileLayout.Metrics.badgeGlyph).withRenderingMode(.alwaysTemplate)
        badgeGlyph.contentMode = .center
        badge.addSubview(badgeGlyph)
        for subview in [avatar, badge] { scroll.addSubview(subview) }
        status.textColor = UIColor(Palette.textDestructive)
        content.addSubview(status)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        showPhoto()
    }

    private func applyColors() {
        let ink = UIColor(Palette.startText).resolvedColor(with: traitCollection)
        let ground = StartViewController.Colors.grain.back.resolvedColor(with: traitCollection)
        badge.backgroundColor = ink
        badge.layer.borderColor = ground.cgColor
        badgeGlyph.tintColor = ground
    }

    override var artSide: CGFloat { CloudProfileLayout.Metrics.avatar }

    override func layoutArt(_ art: CGRect, caption: CGRect) {
        avatar.setLayoutFrame(art)
        let badgeFrame = CloudProfileLayout.badge(avatar: art)
        badge.setLayoutFrame(badgeFrame)
        badge.layer.cornerRadius = badgeFrame.width / 2
        badgeGlyph.setLayoutFrame(badge.bounds)
    }

    override func contentHeight(width: CGFloat) -> CGFloat { Self.statusHeight(status, width: width) }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { Self.statusRoom }
    override func layoutContent() { status.setLayoutFrame(content.bounds) }

    @objc private func pick() { picker.present(from: self) }

    /// Picked: shown in place, and Continue saves it.
    func choose(_ image: UIImage) {
        photo = image
        status.string = ""
        primary.title = Strings.CloudConnect.continueAction
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
        relayout()
    }

    private func primaryTapped() async {
        guard let photo else { return pick() }
        status.string = ""
        relayout()
        secondary?.isEnabled = false
        avatar.isUserInteractionEnabled = false
        defer { secondary?.isEnabled = true; avatar.isUserInteractionEnabled = true }
        guard let jpeg = await ProfilePhotoPicker.jpeg(photo) else { return say(Strings.CloudOnboarding.photoFailed) }
        do { try await save(jpeg) }
        catch { say(Strings.CloudOnboarding.photoFailed) }
    }

    func say(_ problem: String?) {
        status.string = problem ?? ""
        relayout()
    }
}
#endif
