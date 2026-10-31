#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// components/Avatar.tsx: a session, bot or task avatar, its picture when it
/// has one and otherwise the placeholder its seed picks (`AvatarPlaceholder`),
/// whatever avatar style is set, with the optional harness badge.
public final class AvatarView: UIView {
    public struct Content: Equatable {
        public var avatar: SessionAvatar
        public var style: AvatarStyle
        public var monochrome: Bool
        public var square: Bool

        public init(avatar: SessionAvatar, style: AvatarStyle, monochrome: Bool, square: Bool = false) {
            self.avatar = avatar
            self.style = style
            self.monochrome = monochrome
            self.square = square
        }
    }

    public var content: Content? {
        didSet { if content != oldValue { apply() } }
    }

    public weak var pictures: AvatarPictures? {
        didSet { if pictures !== oldValue { updateImage() } }
    }
    let photo = UIImageView()
    private(set) var imageTask: Task<Void, Never>?
    private var imageSource: AvatarImageSource?
    private weak var imageOwner: AvatarPictures?
    private var imageGeneration: UInt64 = 0

    let disc = UIView()
    /// The seed's placeholder, under the picture.
    let glyph = UIImageView()
    private let placeholder = AvatarPlaceholderSlot()
    let badge = UIView()
    let badgeGlyph = UIImageView()

    public override init(frame: CGRect) {
        super.init(frame: frame)
        disc.clipsToBounds = true
        disc.backgroundColor = UIColor(Palette.surface)
        glyph.contentMode = .scaleAspectFill
        photo.contentMode = .scaleAspectFill
        photo.clipsToBounds = true
        photo.isHidden = true
        badge.backgroundColor = UIColor(Palette.surface)
        badge.layer.shadowColor = UIColor.black.cgColor
        badge.layer.shadowOpacity = 0.2
        badge.layer.shadowRadius = 2
        badge.layer.shadowOffset = CGSize(width: 0, height: 1)
        badgeGlyph.contentMode = .scaleAspectFit
        addSubview(disc)
        disc.addSubview(glyph)
        disc.addSubview(photo)
        addSubview(badge)
        badge.addSubview(badgeGlyph)
        isUserInteractionEnabled = false
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let size = bounds.width
        disc.setLayoutFrame(bounds)
        disc.layer.cornerRadius = size / 2
        if content?.square == true { disc.layer.cornerRadius = 0 }
        photo.setLayoutFrame(disc.bounds)
        glyph.setLayoutFrame(disc.bounds)
        if let content {
            // Decoded at the size it is drawn, which is known here.
            placeholder.show(seed: content.avatar.seed, side: size, monochrome: content.monochrome) { [weak self] in self?.glyph.image = $0 }
            if let harness = content.avatar.harness {
                let frames = AvatarBadge.badge(avatarSize: size, glyphRatio: AvatarBadge.badgeGlyphRatio(harness: harness.rawValue))
                badge.setLayoutFrame(frames.circle)
                badge.layer.cornerRadius = frames.circle.width / 2
                badgeGlyph.setLayoutFrame(frames.glyph.offsetBy(dx: -frames.circle.minX, dy: -frames.circle.minY))
            }
        }
    }

    private func apply() {
        updateImage()
        guard let content else {
            placeholder.cancel()
            glyph.image = nil
            badge.isHidden = true
            return
        }
        if bounds.width > 0 {
            placeholder.show(seed: content.avatar.seed, side: bounds.width, monochrome: content.monochrome) { [weak self] in self?.glyph.image = $0 }
        }
        badge.isHidden = content.avatar.harness == nil || ((content.avatar.isBot || content.avatar.isTask) && photo.image == nil)
        if let harness = content.avatar.harness {
            let image = AvatarImages.harness(harness)
            // Codex's and Happy Agent's marks are black; they follow the text
            // colour so they show in dark mode.
            let tinted = harness == .codex || harness == .rig
            badgeGlyph.image = tinted ? image?.withRenderingMode(.alwaysTemplate) : image
            badgeGlyph.tintColor = UIColor(Palette.text)
        }
        setNeedsLayout()
    }

    private func updateImage() {
        let source = content?.avatar.image
        guard source != imageSource || pictures !== imageOwner else { return }
        imageTask?.cancel()
        imageTask = nil
        imageGeneration &+= 1
        imageSource = source
        imageOwner = pictures
        photo.image = nil
        photo.isHidden = true
        guard let source, let pictures else { return }
        if let image = pictures.cached(source) as? UIImage {
            photo.image = image
            photo.isHidden = false
            return
        }
        let generation = imageGeneration
        imageTask = Task { [weak self] in
            let image = await pictures.picture(source, decode: AccountPictureImages.decode) as? UIImage
            guard !Task.isCancelled, let self, self.imageGeneration == generation,
                  self.imageSource == source, self.pictures === pictures, let image else { return }
            self.photo.image = image
            self.photo.isHidden = false
            self.badge.isHidden = self.content?.avatar.harness == nil
        }
    }

    deinit { imageTask?.cancel() }
}

/// The harness marks.
@MainActor
enum AvatarImages {
    static func harness(_ harness: SessionAvatar.Harness) -> UIImage? {
        switch harness {
        case .claude: UIImage.happy("icon-claude")
        case .codex: UIImage.happy("icon-gpt")
        case .agy: UIImage.happy("icon-agy")
        case .rig: UIImage.happy("logo-black")
        }
    }
}
#endif
