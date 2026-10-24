#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The screen that can load a conversation's pictures and recordings, found
/// up the responder chain from the view that shows one.
@MainActor
protocol ChatMediaProviding: AnyObject {
    var chatMedia: ChatMediaSource? { get }
}

/// A conversation's pictures and recordings by `ChatMedia.key`, decoded off
/// the main thread at no more than `pixels` on their longer side. A
/// recording's picture is its first frame.
@MainActor
protocol ChatMediaSource: AnyObject {
    func cachedImage(_ key: String, pixels: Int) -> UIImage?
    func image(_ key: String, pixels: Int) async -> UIImage?
    func placeholder(_ thumbhash: String) async -> UIImage?
}

/// Desktop's MediaImageTile and MediaVideoTile: the thumbhash in
/// `surface-pressed`, the picture faded in over it (160 ms), a hairline
/// over the whole tile and corners rounded 8. A recording shows its first
/// frame under a play button; a tap plays it. A picture that failed keeps
/// its placeholder under a quiet glyph and is asked for again when the
/// computer is back (`StemCellMediaLoader.retry`).
final class ChatMediaView: UIView {
    static let radius: CGFloat = 8
    static let fade: TimeInterval = 0.16
    static let playIconSize: CGFloat = 22

    private let placeholder = UIImageView()
    private let picture = UIImageView()
    private let outline = UIView()
    private let play = UIView()
    private let playIcon = UIImageView()
    private let failure = UIImageView()
    private var failed = false
    private var media: ChatMedia?
    private var loadedPixels = 0
    private var task: Task<Void, Never>?
    private var placeholderTask: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        layer.cornerRadius = Self.radius
        layer.cornerCurve = .continuous
        backgroundColor = UIColor(Palette.surfacePressed)
        isUserInteractionEnabled = false
        // Its own element in a row that shows media, so it can be found and opened.
        isAccessibilityElement = true
        accessibilityIdentifier = "stem-media"
        placeholder.contentMode = .scaleToFill
        picture.contentMode = .scaleAspectFit
        for view in [placeholder, picture] {
            view.clipsToBounds = true
            addSubview(view)
        }
        play.backgroundColor = UIColor(Palette.stemCellsPlayFill)
        play.layer.cornerRadius = StemCellMediaFlow.playSize / 2
        playIcon.contentMode = .center
        playIcon.image = .icon(.ionicons("play"), size: Self.playIconSize)
        playIcon.tintColor = UIColor(Palette.stemCellsPlayGlyph)
        play.addSubview(playIcon)
        addSubview(play)
        failure.contentMode = .center
        failure.image = .icon(.ionicons("image-outline"), size: Self.playIconSize - 2)
        failure.tintColor = UIColor(Palette.stemCellsMediaFailed)
        failure.isHidden = true
        addSubview(failure)
        NotificationCenter.default.addObserver(self, selector: #selector(retry(_:)), name: StemCellMediaLoader.retry, object: nil)
        outline.isUserInteractionEnabled = false
        outline.layer.cornerRadius = Self.radius
        outline.layer.cornerCurve = .continuous
        outline.layer.borderWidth = 1
        addSubview(outline)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateOutline() }
        updateOutline()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Nil lets go of the picture.
    func apply(_ media: ChatMedia?) {
        guard media != self.media else { return }
        task?.cancel()
        task = nil
        placeholderTask?.cancel()
        placeholderTask = nil
        self.media = media
        loadedPixels = 0
        setFailed(false)
        placeholder.image = nil
        picture.image = nil
        play.isHidden = media?.isVideo != true
        accessibilityLabel = media?.label
        accessibilityTraits = media?.isVideo == true ? .button : .image
        accessibilityValue = Strings.StemCells.mediaLoading
        setNeedsLayout()
        loadIfNeeded()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        loadIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholder.frame = bounds
        picture.frame = bounds
        outline.frame = bounds
        play.frame = StemCellMediaFlow.playButton(in: bounds.size)
        failure.frame = play.frame
        playIcon.frame = play.bounds
        loadIfNeeded()
    }

    private func updateOutline() {
        outline.layer.borderColor = UIColor(Palette.stemCellsDivider).resolvedColor(with: traitCollection).cgColor
    }

    private var pixels: Int {
        Int((max(bounds.width, bounds.height) * max(1, traitCollection.displayScale)).rounded(.up))
    }

    private func loadIfNeeded() {
        guard window != nil, let media, bounds.width > 0, let source = source() else { return }
        if placeholderTask == nil, placeholder.image == nil, picture.image == nil, let thumbhash = media.thumbhash {
            placeholderTask = Task { @MainActor [weak self] in
                let image = await source.placeholder(thumbhash)
                guard !Task.isCancelled, let self, self.media == media, self.picture.image == nil else { return }
                self.placeholder.image = image
            }
        }
        let pixels = pixels
        guard task == nil, pixels > loadedPixels else { return }
        if let image = source.cachedImage(media.key, pixels: pixels) {
            show(image, pixels: pixels, fade: false)
            return
        }
        task = Task { @MainActor [weak self] in
            let image = await source.image(media.key, pixels: pixels)
            guard !Task.isCancelled, let self, self.media == media else { return }
            self.task = nil
            guard let image else {
                // Not again until asked: the computer may be away.
                self.loadedPixels = pixels
                if self.picture.image == nil { self.setFailed(true) }
                return
            }
            self.show(image, pixels: pixels, fade: true)
        }
    }

    @objc private func retry(_ notification: Notification) {
        guard failed, let source = source(), notification.object as AnyObject? === source else { return }
        setFailed(false)
        loadedPixels = 0
        loadIfNeeded()
    }

    private func setFailed(_ value: Bool) {
        failed = value
        failure.isHidden = !value || media?.isVideo == true
        if value { accessibilityValue = Strings.StemCells.mediaFailed } else if picture.image == nil { accessibilityValue = Strings.StemCells.mediaLoading }
    }

    private func show(_ image: UIImage, pixels: Int, fade: Bool) {
        setFailed(false)
        let first = picture.image == nil
        loadedPixels = pixels
        picture.image = image
        accessibilityValue = Strings.StemCells.mediaLoaded
        guard first, fade else {
            placeholder.image = nil
            return
        }
        picture.alpha = 0
        UIView.animate(withDuration: Self.fade) {
            self.picture.alpha = 1
        } completion: { _ in
            if self.picture.image != nil { self.placeholder.image = nil }
        }
    }

    private func source() -> ChatMediaSource? {
        var responder: UIResponder? = self
        while let current = responder {
            if let provider = current as? ChatMediaProviding { return provider.chatMedia }
            responder = current.next
        }
        return nil
    }
}
#endif
