#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A poster's picture: an agent's as its row draws it, a person's photo.
@MainActor
final class StoryMarkView: UIView {
    private let picture = UIImageView()
    private let seedling = MarkView()
    private let loader = MarkPicture()
    private let placeholder = AvatarPlaceholderSlot()

    override init(frame: CGRect) {
        super.init(frame: frame)
        (picture.contentMode, clipsToBounds, layer.cornerCurve, isUserInteractionEnabled) = (.scaleAspectFill, true, .continuous, false)
        addSubview(picture)
        addSubview(seedling)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ mark: Row.Mark, images: Images?) {
        loader.cancel()
        placeholder.cancel()
        (picture.image, seedling.seed) = (nil, nil)
        switch mark {
        case .seedling(let seed): seedling.seed = seed
        case .happy: picture.image = ClayIconImages.happy
        case .clay(let slug): picture.image = ClayIconImages.image(slug)
        case .image(let path, let thumbhash): loader.load(path, thumbhash: thumbhash, pixels: 192, images: images, into: picture)
        case .placeholder(let seed): placeholder.show(seed: seed, side: 64) { [weak self] in self?.picture.image = $0 }
        default: break
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        (picture.frame, seedling.frame) = (bounds, bounds)
    }
}

/// Home's stories row: a tile per poster, unseen first, an agent's a
/// rounded square and a person's a circle, ringed as a row's icon is.
@MainActor
final class StoriesRowView: UIScrollView {
    var onOpen: ((Int) -> Void)?
    var images: Images?
    private(set) var posters: [StoryPoster] = []
    private var tiles: [(ring: UIView, mark: StoryMarkView, name: UILabel)] = []
    private let font = UIFont.systemFont(ofSize: 11)

    override init(frame: CGRect) {
        super.init(frame: frame)
        (showsHorizontalScrollIndicator, alwaysBounceHorizontal) = (false, true)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsLayout() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ posters: [StoryPoster]) {
        guard posters != self.posters else { return }
        self.posters = posters
        tiles.forEach { $0.ring.removeFromSuperview(); $0.mark.removeFromSuperview(); $0.name.removeFromSuperview() }
        tiles = posters.map { poster in
            let tile = (ring: UIView(), mark: StoryMarkView(), name: UILabel())
            tile.mark.show(poster.mark, images: images)
            (tile.name.text, tile.name.font, tile.name.textAlignment, tile.name.textColor) = (poster.me ? Strings.Stories.you : poster.name, font, .center, .secondaryLabel)
            (tile.ring.isAccessibilityElement, tile.ring.accessibilityTraits, tile.ring.accessibilityLabel) = (true, .button, tile.name.text)
            tile.ring.accessibilityValue = poster.unseen ? "story unseen" : "story seen"
            tile.ring.accessibilityIdentifier = "storyTile:\(poster.id)"
            [tile.ring, tile.mark, tile.name].forEach(addSubview)
            return tile
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = StoryLayout.row(count: tiles.count, nameHeight: font.lineHeight.rounded(.up))
        contentSize = CGSize(width: layout.width, height: bounds.height)
        for ((tile, frames), poster) in zip(zip(tiles, layout.tiles), posters) {
            let radius = poster.person ? frames.mark.width / 2 : frames.mark.width * 0.27
            (tile.mark.frame, tile.mark.layer.cornerRadius, tile.name.frame) = (frames.mark, radius, frames.name)
            let ring = StoryLayout.ring(around: frames.mark, markRadius: radius)
            (tile.ring.frame, tile.ring.layer.cornerRadius, tile.ring.layer.cornerCurve, tile.ring.layer.borderWidth) = (ring.frame, ring.radius, .continuous, StoryLayout.Metrics.ringWidth)
            tile.ring.layer.borderColor = UIColor(poster.unseen ? Palette.storyUnseen : Palette.storySeen).resolvedColor(with: traitCollection).cgColor
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        if let index = tiles.firstIndex(where: { $0.ring.frame.union($0.name.frame).contains(point) }) { onOpen?(index) }
    }
}
#endif
