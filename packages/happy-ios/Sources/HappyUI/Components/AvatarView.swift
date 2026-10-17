#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// components/Avatar.tsx for generated session avatars: brutalist (a tinted
/// glyph on a coloured disc), gradient, or an 8×8 pixel grid, a chip for a
/// bot without a picture, and the optional harness badge. Every pick comes
/// from `GeneratedAvatar`, so a session has the same face in both apps.
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
    let glyph = UIImageView()
    let pixels = PixelGridView()
    let badge = UIView()
    let badgeGlyph = UIImageView()

    public override init(frame: CGRect) {
        super.init(frame: frame)
        disc.clipsToBounds = true
        glyph.contentMode = .scaleAspectFit
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
        disc.addSubview(pixels)
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
        pixels.setLayoutFrame(disc.bounds)
        if let content {
            if content.avatar.isBot {
                // Avatar.tsx: hardware-chip-outline at round(size * 0.55),
                // centred in the disc. Drawn here, where the size is known.
                let iconSize = GeneratedAvatar.botGlyphFrame(avatarSize: size).width
                glyph.image = .icon(.ionicons("hardware-chip-outline"), size: iconSize)
                glyph.setLayoutFrame(disc.bounds)
            } else if content.style == .brutalist {
                glyph.setLayoutFrame(GeneratedAvatar.brutalistGlyphFrame(avatarSize: size))
            } else {
                glyph.setLayoutFrame(disc.bounds)
            }
            if let harness = content.avatar.harness {
                let frames = GeneratedAvatar.badge(avatarSize: size, glyphRatio: GeneratedAvatar.badgeGlyphRatio(harness: harness.rawValue))
                badge.setLayoutFrame(frames.circle)
                badge.layer.cornerRadius = frames.circle.width / 2
                badgeGlyph.setLayoutFrame(frames.glyph.offsetBy(dx: -frames.circle.minX, dy: -frames.circle.minY))
            }
        }
    }

    private func apply() {
        updateImage()
        guard let content else {
            glyph.image = nil
            pixels.colors = []
            badge.isHidden = true
            return
        }
        let seed = content.avatar.seed
        pixels.isHidden = true
        glyph.isHidden = false
        if content.avatar.isBot {
            disc.backgroundColor = UIColor(Palette.surface)
            glyph.image = nil
            glyph.contentMode = .center
            glyph.tintColor = UIColor(content.monochrome ? Palette.textSecondary : Palette.text)
            setNeedsLayout()
        } else {
            glyph.contentMode = .scaleAspectFit
            switch content.style {
            case .brutalist:
                let pick = GeneratedAvatar.brutalist(seed: seed, monochrome: content.monochrome)
                disc.backgroundColor = UIColor(pick.background)
                glyph.image = AvatarImages.brutalist(pick.imageName)
                glyph.tintColor = UIColor(pick.tint)
            case .gradient:
                disc.backgroundColor = nil
                let name = GeneratedAvatar.gradientImageName(seed: seed)
                glyph.image = content.monochrome ? AvatarImages.grayscaleGradient(name) : AvatarImages.gradient(name)
                glyph.tintColor = nil
            case .pixelated:
                disc.backgroundColor = nil
                glyph.isHidden = true
                pixels.isHidden = false
                pixels.colors = GeneratedAvatar.pixels(seed: seed, monochrome: content.monochrome).map { UIColor($0) }
            }
        }
        badge.isHidden = content.avatar.harness == nil || (content.avatar.isBot && photo.image == nil)
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

/// The pixelated avatar: 64 cells drawn at `GeneratedAvatar.pixelFrames`.
final class PixelGridView: UIView {
    var colors: [UIColor] = [] {
        didSet { setNeedsDisplay() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        for (frame, color) in zip(GeneratedAvatar.pixelFrames(size: bounds.width), colors) {
            context.setFillColor(color.cgColor)
            // A hair of overlap so neighbouring cells never show a seam.
            context.fill(frame.insetBy(dx: -0.25, dy: -0.25))
        }
    }
}

/// The bundled avatar artwork, decoded once.
@MainActor
enum AvatarImages {
    private static let cache = NSCache<NSString, UIImage>()

    static func brutalist(_ name: String) -> UIImage? {
        cached("b:" + name) {
            UIImage.happy(name)?.withRenderingMode(.alwaysTemplate)
        }
    }

    static func gradient(_ name: String) -> UIImage? {
        cached("g:" + name) { UIImage.happy(name) }
    }

    /// AvatarGradient.tsx drains the colour with a grey sheet in saturation
    /// blend mode; luminosity over grey is the same result, baked once.
    static func grayscaleGradient(_ name: String) -> UIImage? {
        cached("gm:" + name) {
            guard let source = UIImage.happy(name) else { return nil }
            let renderer = UIGraphicsImageRenderer(size: source.size, format: .init(for: source.traitCollection))
            return renderer.image { context in
                UIColor(white: 0.5, alpha: 1).setFill()
                context.fill(CGRect(origin: .zero, size: source.size))
                source.draw(at: .zero, blendMode: .luminosity, alpha: 1)
            }
        }
    }

    static func harness(_ harness: SessionAvatar.Harness) -> UIImage? {
        switch harness {
        case .claude: UIImage.happy("icon-claude")
        case .codex: UIImage.happy("icon-gpt")
        case .agy: UIImage.happy("icon-agy")
        case .rig: UIImage.happy("logo-black")
        }
    }

    private static func cached(_ key: String, _ make: () -> UIImage?) -> UIImage? {
        if let image = cache.object(forKey: key as NSString) { return image }
        guard let image = make() else { return nil }
        cache.setObject(image, forKey: key as NSString)
        return image
    }
}
#endif
