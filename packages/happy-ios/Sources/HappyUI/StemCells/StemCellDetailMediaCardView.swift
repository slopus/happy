#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The detail's shared media, Telegram's grid in our card: each picture,
/// recording and file a square, a recording's first frame under a play
/// button, a file its glyph and name; "Show more" under them.
final class StemCellDetailMediaCardView: UIView {
    var onSelect: ((Int) -> Void)?
    var onMore: (() -> Void)?
    weak var source: ChatMediaSource?
    private var cells: [StemCellSharedMediaCell] = []
    private let moreView = StemCellsSettingsCardView.RowView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.stemCellsSettingsCard)
        layer.cornerRadius = StemCellSessionDetailLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        moreView.isHidden = true
        addSubview(moreView)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ media: [StemCellsShared.Media]) {
        while cells.count < media.count {
            let cell = StemCellSharedMediaCell()
            let index = cells.count
            cell.accessibilityIdentifier = "stem-detail-media:\(index)"
            cell.addAction(UIAction { [weak self] _ in self?.onSelect?(index) }, for: .touchUpInside)
            insertSubview(cell, belowSubview: moreView)
            cells.append(cell)
        }
        while cells.count > media.count { cells.removeLast().removeFromSuperview() }
        for (cell, one) in zip(cells, media) {
            cell.source = source
            cell.show(one)
        }
    }

    func place(_ card: StemCellSessionDetailLayout.MediaCard) {
        frame = card.frame
        for (cell, frame) in zip(cells, card.cells) { cell.frame = frame }
        moreView.isHidden = card.more == nil
        if let frames = card.more {
            moreView.show(StemCellsSettingsRow(id: "media-more", title: Strings.StemCells.showMore, accessory: .none, action: { [weak self] in self?.onMore?() }), frames: frames)
            moreView.accessibilityIdentifier = "stem-detail-media-more"
        }
    }
}

/// One square of the grid: the picture filling it over its thumbhash, a
/// recording's first frame under a play button, or a file's glyph over its
/// name. Decoded at the square's size, off the main thread.
final class StemCellSharedMediaCell: UIControl {
    weak var source: ChatMediaSource?
    private let placeholder = UIImageView()
    private let picture = UIImageView()
    private let play = UIView()
    private let playIcon = UIImageView()
    private let glyph = UIImageView()
    private let name = UILabel()
    private let dim = UIView()
    private var media: StemCellsShared.Media?
    private var loadedPixels = 0
    private var task: Task<Void, Never>?
    private var placeholderTask: Task<Void, Never>?
    /// Not asked again until the cell comes back into a window: the
    /// computer may be away.
    private var failed = false

    private static let playSize: CGFloat = 36
    private static let glyphSize: CGFloat = 30

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        backgroundColor = UIColor(Palette.surfacePressed)
        for view in [placeholder, picture] {
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        play.backgroundColor = UIColor(Palette.stemCellsPlayFill)
        play.layer.cornerRadius = Self.playSize / 2
        play.isUserInteractionEnabled = false
        playIcon.contentMode = .center
        playIcon.image = .icon(.ionicons("play"), size: 16)
        playIcon.tintColor = UIColor(Palette.stemCellsPlayGlyph)
        play.addSubview(playIcon)
        addSubview(play)
        glyph.contentMode = .center
        glyph.image = StemCellsGlyphs.image("document-outline", size: Self.glyphSize)
        glyph.tintColor = UIColor(Palette.stemCellsSettingsSecondary)
        addSubview(glyph)
        name.font = StemCellsFonts.ui(.regular, size: 12)
        name.textColor = UIColor(Palette.stemCellsSettingsSecondary)
        name.textAlignment = .center
        name.numberOfLines = 2
        name.lineBreakMode = .byTruncatingMiddle
        addSubview(name)
        dim.backgroundColor = UIColor(Palette.stemCellsRowPressed)
        dim.isUserInteractionEnabled = false
        dim.isHidden = true
        addSubview(dim)
        isAccessibilityElement = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { dim.isHidden = !isHighlighted }
    }

    func show(_ media: StemCellsShared.Media) {
        guard media != self.media else { return }
        task?.cancel()
        task = nil
        placeholderTask?.cancel()
        placeholderTask = nil
        self.media = media
        loadedPixels = 0
        failed = false
        placeholder.image = nil
        picture.layer.removeAllAnimations()
        picture.alpha = 1
        picture.image = nil
        var video = false
        var file: StemCellMedia?
        var label = Strings.StemCells.picture
        var thumbhash: String?
        if case .tool(let one) = media {
            video = one.isVideo
            file = one.isVisual ? nil : one
            label = video ? Strings.StemCells.sharedVideo : one.item.name
            thumbhash = one.item.thumbhash
        }
        play.isHidden = !video
        glyph.isHidden = file == nil
        name.isHidden = file == nil
        name.text = file?.item.name
        accessibilityLabel = label
        accessibilityTraits = file == nil && !video ? [.image, .button] : .button
        if let thumbhash, let source {
            placeholderTask = Task { [weak self] in
                let image = await source.placeholder(thumbhash)
                guard let self, !Task.isCancelled, self.media == media, self.picture.image == nil else { return }
                self.placeholder.image = image
            }
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholder.frame = bounds
        picture.frame = bounds
        dim.frame = bounds
        play.frame = CGRect(x: ((bounds.width - Self.playSize) / 2).rounded(), y: ((bounds.height - Self.playSize) / 2).rounded(), width: Self.playSize, height: Self.playSize)
        playIcon.frame = play.bounds
        let nameHeight = ceil(name.font.lineHeight * 2)
        let block = Self.glyphSize + 6 + nameHeight
        let top = ((bounds.height - block) / 2).rounded()
        glyph.frame = CGRect(x: 0, y: top, width: bounds.width, height: Self.glyphSize)
        name.frame = CGRect(x: 8, y: glyph.frame.maxY + 6, width: max(0, bounds.width - 16), height: nameHeight)
        load()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { failed = false }
        load()
    }

    /// The picture at the square's pixels, once; a file has none.
    private func load() {
        guard window != nil, let media, let source, bounds.width > 0, task == nil, !failed else { return }
        if case .tool(let one) = media, !one.isVisual { return }
        let pixels = Int((max(bounds.width, bounds.height) * max(1, traitCollection.displayScale)).rounded(.up))
        guard pixels > loadedPixels else { return }
        if let image = source.cachedImage(media.key, pixels: pixels) {
            loadedPixels = pixels
            picture.image = image
            return
        }
        task = Task { [weak self] in
            let image = await source.image(media.key, pixels: pixels)
            guard let self, !Task.isCancelled, self.media == media else { return }
            self.task = nil
            guard let image else {
                self.failed = true
                return
            }
            let first = self.picture.image == nil
            self.loadedPixels = pixels
            self.picture.image = image
            if first {
                self.picture.alpha = 0
                UIView.animate(withDuration: ChatMediaView.fade) { self.picture.alpha = 1 }
            }
            // Grown while it read: the larger one now.
            self.load()
        }
    }
}
#endif
