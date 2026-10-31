#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The detail's shared media, Telegram's grid in our card: each picture,
/// recording and file a square, a recording's first frame under a play
/// button, a file its glyph and name; "Show more" under them.
final class DetailMediaCardView: UIView {
    var onSelect: ((Int) -> Void)?
    var onMore: (() -> Void)?
    private var cells: [SharedMediaCell] = []
    private let moreView = SettingsCardView.RowView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsCard)
        layer.cornerRadius = SessionDetailLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        moreView.isHidden = true
        addSubview(moreView)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ media: [Shared.Media]) {
        while cells.count < media.count {
            let cell = SharedMediaCell()
            let index = cells.count
            cell.accessibilityIdentifier = "detail-media:\(index)"
            cell.addAction(UIAction { [weak self] _ in self?.onSelect?(index) }, for: .touchUpInside)
            insertSubview(cell, belowSubview: moreView)
            cells.append(cell)
        }
        while cells.count > media.count { cells.removeLast().removeFromSuperview() }
        for (cell, one) in zip(cells, media) { cell.show(one) }
    }

    func place(_ card: SessionDetailLayout.MediaCard) {
        frame = card.frame
        for (cell, frame) in zip(cells, card.cells) { cell.frame = frame }
        moreView.isHidden = card.more == nil
        if let frames = card.more {
            moreView.show(SettingsRow(id: "media-more", title: Strings.showMore, accessory: .none, action: { [weak self] in self?.onMore?() }), frames: frames)
            moreView.accessibilityIdentifier = "detail-media-more"
        }
    }
}

/// One square of the grid: a picture or recording is the chat's own tile
/// (`ChatMediaView`) filling it, so it reads, rings and recovers as the
/// chat does: a photo the rules allow arrives by itself, anything else
/// shows its ring and size until a tap, and one that failed is asked
/// again when the computer is back. A file is its glyph over its name.
final class SharedMediaCell: UIControl {
    private let tile = ChatMediaView()
    private let glyph = UIImageView()
    private let name = UILabel()
    private let dim = UIView()
    private var media: Shared.Media?

    private static let glyphSize: CGFloat = 30

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        backgroundColor = UIColor(Palette.surfacePressed)
        tile.fills = true
        tile.isAccessibilityElement = false
        addSubview(tile)
        glyph.contentMode = .center
        glyph.image = Glyphs.image("document-outline", size: Self.glyphSize)
        glyph.tintColor = UIColor(Palette.settingsSecondary)
        addSubview(glyph)
        name.font = Fonts.ui(.regular, size: 12)
        name.textColor = UIColor(Palette.settingsSecondary)
        name.textAlignment = .center
        name.numberOfLines = 2
        name.lineBreakMode = .byTruncatingMiddle
        addSubview(name)
        dim.backgroundColor = UIColor(Palette.rowPressed)
        dim.isUserInteractionEnabled = false
        dim.isHidden = true
        addSubview(dim)
        isAccessibilityElement = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// What it shows, for tests.
    var shown: Shared.Media? { media }
    var pictureImage: UIImage? { tile.pictureImage }
    var mediaTile: ChatMediaView? { tile.isHidden ? nil : tile }

    override var isHighlighted: Bool {
        didSet { dim.isHidden = !isHighlighted }
    }

    override var accessibilityValue: String? {
        get { tile.isHidden ? nil : tile.accessibilityValue }
        set {}
    }

    func show(_ media: Shared.Media) {
        guard media != self.media else { return }
        self.media = media
        var file: Media?
        let shown: ChatMedia
        switch media {
        case .picture:
            shown = ChatMedia(key: media.key, isVideo: false, thumbhash: nil, label: Strings.picture)
        case .tool(let one):
            file = one.isVisual ? nil : one
            shown = ChatMedia(key: one.key, isVideo: one.isVideo, thumbhash: one.item.thumbhash, label: one.isVideo ? Strings.sharedVideo : one.item.name)
        }
        tile.isHidden = file != nil
        tile.apply(file == nil ? shown : nil)
        glyph.isHidden = file == nil
        name.isHidden = file == nil
        name.text = file?.item.name
        accessibilityLabel = shown.label
        accessibilityTraits = file == nil && !shown.isVideo ? [.image, .button] : .button
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        tile.frame = bounds
        dim.frame = bounds
        let nameHeight = ceil(name.font.lineHeight * 2)
        let block = Self.glyphSize + 6 + nameHeight
        let top = ((bounds.height - block) / 2).rounded()
        glyph.frame = CGRect(x: 0, y: top, width: bounds.width, height: Self.glyphSize)
        name.frame = CGRect(x: 8, y: glyph.frame.maxY + 6, width: max(0, bounds.width - 16), height: nameHeight)
    }
}
#endif
