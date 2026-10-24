#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// One frame drawn on the story canvas at any size: the background's
/// gradient, the media placed by its transform, the overlays from their
/// data, and the caption under its fade. The viewer, the editor and the
/// inline story all draw a frame with it.
final class StoryCanvasView: UIView {
    /// The frame's picture is on screen (or it has none to wait for).
    var onReady: (() -> Void)?
    /// A recording reached its end.
    var onVideoEnd: (() -> Void)?

    private weak var media: StoriesMedia?
    private let background = CAGradientLayer()
    private let mediaView = UIImageView()
    private let playerView = StoryPlayerView()
    private let overlayLayer = UIView()
    private let captionFade = CAGradientLayer()
    private let captionLabel = UILabel()
    private let unavailable = UILabel()
    private var overlayViews: [String: StoryOverlayView] = [:]
    private var overlayOrder: [String] = []
    private var loading: Task<Void, Never>?
    nonisolated(unsafe) private var endObserver: NSObjectProtocol?

    private(set) var storyId: String?
    private(set) var shownFrame: StoryFrame?
    private var caption: String?
    private var reactions: [StoryReactionCount] = []
    private var myReaction: String?
    private var showsCounts = false
    /// Whether the picture (or a recording's first frame) has been drawn.
    private(set) var isReady = false
    private(set) var player: AVPlayer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        backgroundColor = .black
        background.startPoint = CGPoint(x: 0.5, y: 0)
        background.endPoint = CGPoint(x: 0.5, y: 1)
        layer.addSublayer(background)
        mediaView.contentMode = .scaleToFill
        mediaView.isUserInteractionEnabled = false
        addSubview(mediaView)
        playerView.isUserInteractionEnabled = false
        playerView.isHidden = true
        addSubview(playerView)
        unavailable.textColor = UIColor(white: 1, alpha: 0.8)
        unavailable.textAlignment = .center
        unavailable.numberOfLines = 0
        unavailable.isHidden = true
        addSubview(unavailable)
        overlayLayer.isUserInteractionEnabled = false
        addSubview(overlayLayer)
        captionFade.colors = [UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.55).cgColor]
        layer.addSublayer(captionFade)
        captionLabel.textColor = .white
        captionLabel.numberOfLines = 0
        captionLabel.font = .systemFont(ofSize: 16)
        addSubview(captionLabel)
        accessibilityIdentifier = "story-canvas"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    }

    /// Shows `frame` of `story`. The same frame again only takes what changed.
    func show(_ story: Story, frame: StoryFrame, media: StoriesMedia?, playsVideo: Bool = true) {
        self.media = media
        let sameFrame = storyId == story.id && shownFrame?.id == frame.id
        storyId = story.id
        let previous = shownFrame
        shownFrame = frame
        caption = story.caption
        reactions = story.reactions
        myReaction = story.myReaction
        showsCounts = story.status == .posted
        background.colors = frame.background.compactMap { UIColor(hex: $0)?.cgColor }
        if !sameFrame || previous?.available != frame.available { loadMedia(story.id, frame, playsVideo: playsVideo) }
        applyOverlays(frame.overlays)
        captionLabel.text = caption
        captionLabel.isHidden = caption?.isEmpty ?? true
        setNeedsLayout()
    }

    // MARK: Media

    private func loadMedia(_ storyId: String, _ frame: StoryFrame, playsVideo: Bool) {
        loading?.cancel()
        isReady = false
        stopPlayer()
        mediaView.image = nil
        unavailable.isHidden = frame.available
        unavailable.text = frame.kind == .video ? Strings.Stories.videoUnavailable : Strings.Stories.photoUnavailable
        guard frame.available, let media else {
            markReady()
            return
        }
        let pixels = Self.pixels(bounds.size, scale: traitCollection.displayScale)
        if let cached = media.cachedFrame(storyId, frame.id, pixels: pixels) {
            mediaView.image = cached
            if frame.kind == .image { markReady() }
        }
        if frame.kind == .video, playsVideo {
            let player = media.player(storyId, frame)
            player.isMuted = false
            self.player = player
            playerView.player = player
            playerView.isHidden = false
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onVideoEnd?() }
            }
        }
        guard mediaView.image == nil || frame.kind == .video else { return }
        loading = Task { [weak self] in
            if let placeholder = await media.placeholder(frame.thumbhash), let self, !Task.isCancelled, self.mediaView.image == nil {
                self.mediaView.image = placeholder
            }
            let image = await media.frame(storyId, frame, pixels: pixels)
            guard let self, !Task.isCancelled, self.shownFrame?.id == frame.id else { return }
            if let image { self.mediaView.image = image }
            if self.shownFrame?.width == nil, let image { self.measured = image.size }
            self.setNeedsLayout()
            self.markReady()
        }
    }

    /// A recording measured by its first frame, before the daemon has.
    private var measured: CGSize?

    private func markReady() {
        guard !isReady else { return }
        isReady = true
        onReady?()
    }

    private func stopPlayer() {
        player?.pause()
        player = nil
        playerView.player = nil
        playerView.isHidden = true
        measured = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }

    /// The pixels a frame is read at for a canvas of `size`; the viewer's
    /// preload asks for the same, so both find one cached picture.
    static func pixels(_ size: CGSize, scale: CGFloat) -> Int {
        Int(max(size.width, size.height, 400) * max(1, scale))
    }

    func play() { player?.play() }

    /// A recording starts again from its beginning.
    func restart() { player?.seek(to: .zero) }
    func pause() { player?.pause() }

    /// How far a recording has played, 0…1; nil for a picture.
    var videoProgress: Double? {
        // One that can't play runs on the frame's own clock instead.
        guard let player, let item = player.currentItem, item.status != .failed else { return nil }
        let duration = item.duration.seconds
        guard duration.isFinite, duration > 0 else { return 0 }
        // At most a minute is shown (API.md "Frames").
        let shown = min(duration, Double(StoryCanvas.maxVideoDurationMs) / 1000)
        return min(1, max(0, player.currentTime().seconds / shown))
    }

    /// Lets go of the recording (the viewer moved on).
    func stop() {
        loading?.cancel()
        stopPlayer()
        storyId = nil
        shownFrame = nil
        mediaView.image = nil
        isReady = false
    }

    // MARK: Overlays

    private func applyOverlays(_ overlays: [StoryOverlay]) {
        var live = Set<String>()
        var order: [String] = []
        for overlay in overlays {
            guard let id = overlay.id else { continue }
            live.insert(id)
            order.append(id)
            if let view = overlayViews[id], view.update(overlay) { continue }
            overlayViews[id]?.removeFromSuperview()
            guard let view = StoryOverlayView.make(overlay, media: media) else { continue }
            overlayViews[id] = view
        }
        for (id, view) in overlayViews where !live.contains(id) {
            view.removeFromSuperview()
            overlayViews.removeValue(forKey: id)
        }
        overlayOrder = order
        for id in order { if let view = overlayViews[id] { overlayLayer.addSubview(view) } }
        for view in overlayViews.values {
            guard let reaction = view as? StoryReactionOverlayView else { continue }
            reaction.count = showsCounts ? reactions.first { $0.emoji == reaction.emoji }?.count : nil
            reaction.chosen = myReaction == reaction.emoji
        }
    }

    /// The topmost overlay a tap at `point` (in this view) lands on, of the
    /// kinds the viewer answers: links and reaction bubbles.
    func tappable(at point: CGPoint) -> StoryOverlay? {
        for id in overlayOrder.reversed() {
            guard let view = overlayViews[id] else { continue }
            switch view.overlay {
            case .link, .reaction: break
            default: continue
            }
            let local = view.convert(point, from: self)
            if view.bounds.insetBy(dx: -8, dy: -8).contains(local) { return view.overlay }
        }
        return nil
    }

    func overlayView(_ id: String) -> StoryOverlayView? { overlayViews[id] }

    /// Overlays, and the caption, hide while the person holds the frame.
    var chromeHidden = false {
        didSet {
            guard chromeHidden != oldValue else { return }
            UIView.animate(withDuration: 0.2) {
                self.captionLabel.alpha = self.chromeHidden ? 0 : 1
            }
            captionFade.opacity = chromeHidden ? 0 : 1
        }
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = bounds.size
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        background.frame = bounds
        if let frame = shownFrame {
            let pixels = frame.width.flatMap { w in frame.height.map { CGSize(width: w, height: $0) } } ?? measured ?? mediaView.image?.size
            let box = StoryCanvasLayout.media(pixels: pixels, x: frame.placement.x, y: frame.placement.y, scale: frame.placement.scale, canvas: size)
            for view in [mediaView, playerView] as [UIView] {
                view.transform = .identity
                view.bounds = CGRect(origin: .zero, size: box.size)
                view.center = CGPoint(x: box.midX, y: box.midY)
                view.transform = CGAffineTransform(rotationAngle: CGFloat(frame.placement.rotation))
            }
        }
        overlayLayer.frame = bounds
        for view in overlayViews.values { view.place(canvas: size) }
        unavailable.font = .systemFont(ofSize: max(13, size.width / 24), weight: .medium)
        unavailable.frame = bounds.insetBy(dx: size.width * 0.1, dy: 0)
        if captionLabel.isHidden {
            captionFade.frame = .zero
        } else {
            captionLabel.font = .systemFont(ofSize: max(12, min(16, size.width / 24)))
            let height = captionLabel.sizeThatFits(CGSize(width: max(0, size.width - 32), height: .greatestFiniteMagnitude)).height
            let caption = StoryCanvasLayout.caption(textHeight: min(height, size.height / 3), canvas: size, bottomInset: captionInset)
            captionLabel.frame = caption.text
            captionFade.frame = caption.fade
        }
        CATransaction.commit()
    }

    /// Room kept under the caption (the inline story's buttons).
    var captionInset: CGFloat = 16 { didSet { setNeedsLayout() } }
}

/// A recording's picture.
final class StoryPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    var player: AVPlayer? {
        get { playerLayer.player }
        set { playerLayer.player = newValue; playerLayer.videoGravity = .resize }
    }
}
#endif
