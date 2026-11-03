#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A face over a Feed row (`FeedListItems.faceKind`, `.actorKind`): a mark
/// as home draws it, a picture over its ThumbHash, a placeholder, Happy's
/// own, round for a person and a rounded square for anything else. An
/// actor's is ringed in the card's colour, so faces that overlap stand
/// apart.
@MainActor
final class FeedFaceView: UIView {
    private let picture = UIImageView()
    private let seedling = MarkView()
    private let markPicture = MarkPicture()
    private let placeholder = AvatarPlaceholderSlot()
    private let ringed: Bool

    init(face: FeedFace, radius: CGFloat, ringed: Bool, side: CGFloat, images: Images?) {
        self.ringed = ringed
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        clipsToBounds = true
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        addSubview(picture)
        seedling.isHidden = true
        addSubview(seedling)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        guard case .mark(let mark, _) = face else { return }
        switch mark {
        case .none:
            placeholder.show(seed: "feed", side: side) { [weak self] in self?.picture.image = $0 }
        case .happy:
            picture.contentMode = .scaleAspectFit
            picture.image = ClayIconImages.happy
        case .clay(let slug):
            picture.contentMode = .scaleAspectFit
            picture.image = ClayIconImages.image(slug)
        case .seedling(let seed):
            seedling.isHidden = false
            seedling.seed = seed
        case .glyph(let name):
            picture.contentMode = .center
            picture.tintColor = UIColor(Palette.settingsSecondary)
            picture.image = Glyphs.image(name, size: side * 0.6)
        case .placeholder(let seed):
            placeholder.show(seed: seed, side: side) { [weak self] in self?.picture.image = $0 }
        case .image(let path, let thumbhash):
            let pixels = Int((side * 3).rounded(.up))
            markPicture.load(path, thumbhash: thumbhash, pixels: pixels, images: images, into: picture) { [weak self] in
                // No ThumbHash and no picture yet: a placeholder stands in.
                self?.placeholder.show(seed: path, side: side) { [weak self] in self?.picture.image = $0 }
            }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        layer.borderWidth = ringed ? FeedMetrics.faceRing : 0
        layer.borderColor = UIColor(Palette.groupedCard).resolvedColor(with: traitCollection).cgColor
        backgroundColor = UIColor(Palette.groupedCard)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
        seedling.frame = bounds
    }
}
#endif
