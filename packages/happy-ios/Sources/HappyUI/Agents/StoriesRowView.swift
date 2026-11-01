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
    var onAdd: (() -> Void)?
    private(set) var enabled = false
    private let add = UIButton(type: .system)
    var images: Images?
    private(set) var posters: [StoryPoster] = []
    private(set) var personMark: Row.Mark = .placeholder(seed: "person:")
    private var tiles: [(ring: UIView, mark: StoryMarkView, name: UILabel, index: Int)] = []
    private let font = UIFont.systemFont(ofSize: 11)

    override init(frame: CGRect) {
        super.init(frame: frame)
        (showsHorizontalScrollIndicator, alwaysBounceHorizontal) = (false, true)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:))); tap.cancelsTouchesInView = false; addGestureRecognizer(tap)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsLayout() }
        add.setImage(UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)), for: .normal)
        (add.tintColor, add.backgroundColor, add.layer.cornerRadius, add.layer.borderWidth, add.layer.borderColor) = (.white, .systemBlue, 11, 2, UIColor.white.cgColor)
        add.accessibilityLabel = Strings.Stories.yourStory
        add.accessibilityIdentifier = "storyAdd"
        add.addAction(UIAction { [weak self] _ in self?.onAdd?() }, for: .touchUpInside)
        addSubview(add)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ posters: [StoryPoster], enabled: Bool, personMark: Row.Mark = .placeholder(seed: "person:")) {
        guard posters != self.posters || enabled != self.enabled || personMark != self.personMark else { return }
        self.enabled = enabled
        self.posters = posters
        self.personMark = personMark
        tiles.forEach { $0.ring.removeFromSuperview(); $0.mark.removeFromSuperview(); $0.name.removeFromSuperview() }
        tiles = (enabled ? [posters.firstIndex(where: \.me) ?? -1] + posters.indices.filter { !posters[$0].me } : []).enumerated().map { position, index in
            let poster = index >= 0 ? posters[index] : nil, own = position == 0
            let tile = (ring: UIView(), mark: StoryMarkView(), name: UILabel(), index: index)
            tile.mark.show(own ? personMark : poster!.mark, images: images)
            (tile.name.text, tile.name.font, tile.name.textAlignment, tile.name.textColor) = (own ? Strings.Stories.yourStory : poster?.name, font, .center, .secondaryLabel)
            (tile.ring.isAccessibilityElement, tile.ring.accessibilityTraits, tile.ring.accessibilityLabel) = (true, .button, tile.name.text)
            tile.ring.accessibilityValue = poster.map { $0.unseen ? "story unseen" : "story seen" }
            tile.ring.accessibilityIdentifier = own ? "storyOwn" : "storyTile:\(poster!.id)"
            [tile.ring, tile.mark, tile.name].forEach(addSubview)
            return tile
        }
        bringSubviewToFront(add)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        add.isHidden = !enabled
        let layout = StoryLayout.row(count: tiles.count, nameHeight: font.lineHeight.rounded(.up))
        contentSize = CGSize(width: layout.width, height: bounds.height)
        if enabled, let first = layout.tiles.first { add.frame = first.add }
        for (tile, frames) in zip(tiles, layout.tiles) {
            let poster = tile.index >= 0 ? posters[tile.index] : nil
            let radius = poster?.person != false ? frames.mark.width / 2 : frames.mark.width * 0.27
            (tile.mark.frame, tile.mark.layer.cornerRadius, tile.name.frame) = (frames.mark, radius, frames.name)
            let ring = StoryLayout.ring(around: frames.mark, markRadius: radius)
            (tile.ring.frame, tile.ring.layer.cornerRadius, tile.ring.layer.cornerCurve, tile.ring.layer.borderWidth) = (ring.frame, ring.radius, .continuous, poster == nil ? 0 : StoryLayout.Metrics.ringWidth)
            tile.ring.layer.borderColor = UIColor(poster?.unseen == true ? Palette.storyUnseen : Palette.storySeen).resolvedColor(with: traitCollection).cgColor
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        guard !add.frame.contains(point) else { return }
        if let tile = tiles.first(where: { $0.ring.frame.union($0.name.frame).contains(point) }) { if tile.index >= 0 { onOpen?(tile.index) } else { onAdd?() } }
    }
}
#endif
