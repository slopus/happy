#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// An image, image series or video artifact (`ArtifactMediaLayout`): one
/// item large in the middle of the screen, or several under their count
/// in the conversation's media flow, each a `ChatMediaView` (its
/// placeholder first, a recording's first frame under a play button) with
/// a recording's length in a pill. A tap opens the item it lands on.
final class ArtifactGalleryView: UIScrollView {
    struct Item: Equatable {
        var media: ChatMedia
        /// Upright pixels, once known.
        var size: CGSize?
        /// A recording's seconds, once known.
        var duration: Double?
    }

    var onOpen: ((Int) -> Void)?
    private(set) var items: [Item] = []
    private let count = UILabel()
    private var tiles: [ChatMediaView] = []
    private var badges: [UILabel] = []
    private var placed: ArtifactMediaLayout?

    /// The tiles as they are drawn, for tests.
    var tileViews: [ChatMediaView] { tiles }

    override init(frame: CGRect) {
        super.init(frame: frame)
        alwaysBounceVertical = true
        contentInsetAdjustmentBehavior = .never
        accessibilityIdentifier = "artifact-gallery"
        count.font = Fonts.ui(.medium, size: 13)
        count.textColor = UIColor(Palette.textSecondary)
        count.accessibilityIdentifier = "artifact-count"
        addSubview(count)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ items: [Item]) {
        guard items != self.items else { return }
        self.items = items
        while tiles.count < items.count {
            let tile = ChatMediaView()
            addSubview(tile)
            tiles.append(tile)
            let badge = UILabel()
            badge.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
            badge.textColor = UIColor(Palette.playGlyph)
            badge.backgroundColor = UIColor(Palette.playFill)
            badge.textAlignment = .center
            badge.layer.cornerRadius = ArtifactMediaLayout.Metrics.badgeHeight / 2
            badge.layer.cornerCurve = .continuous
            badge.clipsToBounds = true
            badge.isAccessibilityElement = false
            addSubview(badge)
            badges.append(badge)
        }
        while tiles.count > items.count {
            tiles.removeLast().removeFromSuperview()
            badges.removeLast().removeFromSuperview()
        }
        for (index, item) in items.enumerated() {
            tiles[index].apply(item.media)
            tiles[index].accessibilityIdentifier = "artifact-tile-\(index)"
            badges[index].text = item.duration.map(Strings.ArtifactMedia.duration)
        }
        let videos = items.filter(\.media.isVideo).count
        count.text = items.count > 1 ? Strings.ArtifactMedia.count(images: items.count - videos, videos: videos) : nil
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let input = items.map { item in
            MediaLayout.Item(isVideo: item.media.isVideo, image: MediaFlow.Image(width: item.size?.width, height: item.size?.height))
        }
        let layout = ArtifactMediaLayout(
            size: bounds.size, safeArea: LayoutInsets(safeAreaInsets), items: input,
            count: count.text == nil ? nil : count.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)),
            badges: badges.map { $0.text == nil ? nil : $0.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).width }
        )
        placed = layout
        count.isHidden = layout.count == nil
        count.setLayoutFrame(layout.count ?? .zero)
        for (index, tile) in tiles.enumerated() where index < layout.tiles.count {
            tile.setLayoutFrame(layout.tiles[index])
            badges[index].isHidden = layout.badges[index] == nil
            badges[index].setLayoutFrame(layout.badges[index] ?? .zero)
        }
        if contentSize != layout.contentSize { contentSize = layout.contentSize }
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        let point = recognizer.location(in: self)
        guard let index = placed?.tiles.firstIndex(where: { $0.contains(point) }) else { return }
        onOpen?(index)
    }
}
#endif
