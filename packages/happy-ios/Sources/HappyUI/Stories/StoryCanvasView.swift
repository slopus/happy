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
    /// Whether the recording shown has sound, once that is known.
    var onAudioKnown: ((Bool) -> Void)?
    private(set) var hasAudio: Bool?
    var isMuted = false { didSet { player?.isMuted = isMuted } }
    private var audioCheck: Task<Void, Never>?
    /// The caption opened in full or folded again. Set, a caption too long
    /// for its lines folds with "… Show more" and opens on a tap, as
    /// Telegram's do; unset (the editor, the inline story) it shows whole.
    var onCaptionExpanded: ((Bool) -> Void)? {
        didSet { if (onCaptionExpanded == nil) != (oldValue == nil) { applyCaption() } }
    }

    private weak var media: StoriesMedia?
    private let background = CAGradientLayer()
    private let mediaView = UIImageView()
    private let playerView = StoryPlayerView()
    private let overlayLayer = UIView()
    private let captionFade = CAGradientLayer()
    private let captionLabel = UILabel()
    /// Over a folded caption: a tap opens it.
    private let captionMore = UIControl()
    /// The open caption over the darkened frame; a tap anywhere folds it.
    private let captionOpen = UIControl()
    /// Telegram's shadow behind an open caption: clear above, 0.8 at the foot.
    private let captionDim = CAGradientLayer()
    private let captionScroll = UIScrollView()
    private let captionFull = UILabel()
    private(set) var captionExpanded = false
    /// Lines a folded caption keeps (Telegram's `maximumNumberOfLines: 3`).
    private static let captionLines = 3
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
    /// Media the editor holds on the device, by frame: drawn from here, not
    /// read from the computer, which doesn't have it yet.
    var local: [String: StoryLocalMedia] = [:]

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
        captionLabel.accessibilityIdentifier = "story-caption"
        addSubview(captionLabel)
        captionMore.isHidden = true
        captionMore.accessibilityIdentifier = "story-caption-more"
        captionMore.isAccessibilityElement = true
        captionMore.accessibilityTraits = .button
        captionMore.addAction(UIAction { [weak self] _ in self?.setCaptionExpanded(true) }, for: .touchUpInside)
        addSubview(captionMore)
        captionDim.colors = [0, 0.25, 0.55, 0.8].map { UIColor(white: 0, alpha: $0).cgColor }
        captionDim.locations = [0, 0.3, 0.6, 1]
        captionOpen.layer.addSublayer(captionDim)
        captionScroll.showsVerticalScrollIndicator = false
        captionScroll.alwaysBounceVertical = false
        captionScroll.contentInsetAdjustmentBehavior = .never
        captionOpen.addSubview(captionScroll)
        captionFull.textColor = .white
        captionFull.numberOfLines = 0
        captionFull.accessibilityIdentifier = "story-caption-open"
        captionScroll.addSubview(captionFull)
        captionOpen.isHidden = true
        captionOpen.alpha = 0
        captionOpen.accessibilityIdentifier = "story-caption-panel"
        captionOpen.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(captionFolded)))
        addSubview(captionOpen)
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
        if caption != story.caption || !sameFrame { setCaptionExpanded(false, animated: false) }
        caption = story.caption
        reactions = story.reactions
        myReaction = story.myReaction
        showsCounts = story.status == .posted
        background.colors = frame.background.compactMap { UIColor(hex: $0)?.cgColor }
        if !sameFrame || previous?.available != frame.available { loadMedia(story.id, frame, playsVideo: playsVideo) }
        applyOverlays(frame.overlays)
        applyCaption()
    }

    // MARK: Caption

    private func applyCaption() {
        captionLabel.text = caption
        captionFull.text = caption
        captionLabel.isHidden = caption?.isEmpty ?? true
        if captionLabel.isHidden || onCaptionExpanded == nil { setCaptionExpanded(false, animated: false) }
        setNeedsLayout()
    }

    @objc private func captionFolded() { setCaptionExpanded(false) }

    /// The full caption's panel over the frame: a drag on it still closes
    /// the viewer, except where its text scrolls.
    func passesDrag(_ touch: UITouch) -> Bool {
        guard captionExpanded, let view = touch.view, view.isDescendant(of: captionOpen) else { return false }
        let scrolls = captionScroll.contentSize.height > captionScroll.bounds.height + 1
        return !(scrolls && view.isDescendant(of: captionScroll))
    }

    /// Opens the caption in full over the darkened frame, or folds it.
    func setCaptionExpanded(_ expanded: Bool, animated: Bool = true) {
        guard expanded != captionExpanded, !expanded || (onCaptionExpanded != nil && !captionMore.isHidden) else { return }
        captionExpanded = expanded
        layoutIfNeeded()
        captionScroll.contentOffset.y = expanded ? max(0, captionScroll.contentSize.height - captionScroll.bounds.height) : 0
        if expanded { captionOpen.isHidden = false }
        captionMore.isAccessibilityElement = !expanded
        let apply = {
            self.captionOpen.alpha = expanded ? 1 : 0
            self.captionLabel.alpha = expanded || self.chromeHidden ? 0 : 1
            self.captionMore.alpha = expanded ? 0 : 1
        }
        let done = { (_: Bool) in if !self.captionExpanded { self.captionOpen.isHidden = true } }
        if animated {
            UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState], animations: apply, completion: done)
        } else {
            apply()
            done(true)
        }
        onCaptionExpanded?(expanded)
    }

    /// The caption cut to `lines` with "… Show more", or nil when it fits.
    static func folded(_ text: String, font: UIFont, width: CGFloat, lines: Int) -> NSAttributedString? {
        guard width > 0 else { return nil }
        let room = ceil(font.lineHeight * CGFloat(lines)) + 1
        func height(_ string: NSAttributedString) -> CGFloat {
            ceil(string.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
        }
        let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        guard height(NSAttributedString(string: text, attributes: plain)) > room else { return nil }
        let bold = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)
        func cut(_ count: Int) -> NSAttributedString {
            let kept = String(text.prefix(count)).trimmingCharacters(in: .whitespacesAndNewlines)
            let result = NSMutableAttributedString(string: kept + "\u{2026} ", attributes: plain)
            result.append(NSAttributedString(string: Strings.Stories.captionShowMore, attributes: [.font: bold, .foregroundColor: UIColor.white]))
            return result
        }
        // The most of the caption that still leaves room for the token.
        var low = 0
        var high = text.count
        while low < high {
            let middle = (low + high + 1) / 2
            if height(cut(middle)) <= room { low = middle } else { high = middle - 1 }
        }
        return cut(low)
    }

    // MARK: Media

    private func loadMedia(_ storyId: String, _ frame: StoryFrame, playsVideo: Bool) {
        loading?.cancel()
        isReady = false
        stopPlayer()
        mediaView.image = nil
        unavailable.isHidden = frame.available
        unavailable.text = frame.kind == .video ? Strings.Stories.videoUnavailable : Strings.Stories.photoUnavailable
        if let local = local[frame.id] {
            unavailable.isHidden = true
            switch local {
            case .image(let image):
                mediaView.image = image
            case .video(let url, let poster):
                mediaView.image = poster
                if playsVideo { attach(AVPlayer(url: url)) }
            case .asset(let asset, let poster):
                mediaView.image = poster
                if frame.kind == .video, playsVideo, let media { attach(media.player(asset)) }
                if frame.kind == .image, let media {
                    let pixels = Self.pixels(bounds.size, scale: traitCollection.displayScale)
                    loading = Task { [weak self] in
                        let image = await media.assetImage(asset, pixels: pixels)
                        guard let self, !Task.isCancelled, self.shownFrame?.id == frame.id, let image else { return }
                        self.mediaView.image = image
                    }
                }
            }
            markReady()
            return
        }
        guard frame.available, let media else {
            markReady()
            return
        }
        let pixels = Self.pixels(bounds.size, scale: traitCollection.displayScale)
        if let cached = media.cachedFrame(storyId, frame.id, pixels: pixels) {
            mediaView.image = cached
            if frame.kind == .image { markReady() }
        }
        if frame.kind == .video, playsVideo { attach(media.player(storyId, frame)) }
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

    private func attach(_ player: AVPlayer) {
        player.isMuted = isMuted
        self.player = player
        if let asset = player.currentItem?.asset {
            audioCheck = Task { [weak self, weak player] in
                let tracks = (try? await asset.loadTracks(withMediaType: .audio)) ?? []
                guard let self, !Task.isCancelled, let player, self.player === player else { return }
                hasAudio = !tracks.isEmpty
                onAudioKnown?(!tracks.isEmpty)
            }
        }
        playerView.player = player
        playerView.isHidden = false
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onVideoEnd?() }
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
        audioCheck?.cancel()
        audioCheck = nil
        hasAudio = nil
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

    /// The topmost overlay of any kind under `point` (in this view), as the
    /// editor's fingers take them.
    func overlayView(at point: CGPoint, slop: CGFloat = 8) -> StoryOverlayView? {
        for id in overlayOrder.reversed() {
            guard let view = overlayViews[id], !view.isHidden else { continue }
            let local = view.convert(point, from: self)
            // The view's own points shrink with its scale only when the canvas scales it.
            let reach = view.scalesWithTransform ? slop / max(0.05, CGFloat(view.overlay.transform?.scale ?? 1)) : slop
            if view.bounds.insetBy(dx: -reach, dy: -reach).contains(local) { return view }
        }
        return nil
    }

    /// Overlays, and the caption, hide while the person holds the frame.
    var chromeHidden = false {
        didSet {
            guard chromeHidden != oldValue else { return }
            UIView.animate(withDuration: 0.2) {
                self.captionLabel.alpha = self.chromeHidden || self.captionExpanded ? 0 : 1
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
            captionMore.isHidden = true
        } else {
            let font = UIFont.systemFont(ofSize: max(12, min(16, size.width / 24)))
            let width = max(0, size.width - 32)
            captionLabel.font = font
            captionFull.font = font
            // Folded only where something can open it.
            let folded = onCaptionExpanded == nil ? nil : Self.folded(caption ?? "", font: font, width: width, lines: Self.captionLines)
            if let folded { captionLabel.attributedText = folded } else { captionLabel.text = caption }
            captionMore.isHidden = folded == nil
            // Folded, the control reads the whole caption; the cut label stays quiet.
            captionLabel.isAccessibilityElement = folded == nil
            captionMore.accessibilityLabel = (caption ?? "") + ", " + Strings.Stories.captionShowMore
            let height = captionLabel.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
            let full = folded == nil ? height : captionFull.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
            let caption = StoryCanvasLayout.caption(textHeight: folded == nil ? min(height, size.height / 3) : height, fullHeight: full, canvas: size, bottomInset: captionInset)
            captionLabel.frame = caption.text
            captionFade.frame = caption.fade
            captionMore.frame = caption.text.insetBy(dx: -8, dy: -8)
            captionOpen.frame = bounds
            captionDim.frame = caption.shade
            captionScroll.frame = caption.scroll
            captionScroll.contentSize = caption.content
            captionScroll.isScrollEnabled = caption.scrolls
            captionFull.frame = caption.openText
            // Resized while open: the offset stays inside what scrolls.
            if captionExpanded {
                captionScroll.contentOffset.y = caption.scrolls ? min(captionScroll.contentOffset.y, max(0, caption.content.height - caption.scroll.height)) : 0
            }
        }
        CATransaction.commit()
        // Resized so the caption fits whole: nothing is left to open.
        if captionExpanded, captionMore.isHidden { setCaptionExpanded(false, animated: false) }
    }

    /// Room kept under the caption (the inline story's buttons).
    var captionInset: CGFloat = 16 { didSet { setNeedsLayout() } }
}

/// A frame's media while it is only on the device.
enum StoryLocalMedia {
    case image(UIImage)
    case video(URL, poster: UIImage?)
    /// A conversation's item, read from there until a save places it.
    case asset(StoryAsset, poster: UIImage?)

    var poster: UIImage? {
        switch self {
        case .image(let image): image
        case .video(_, let poster), .asset(_, let poster): poster
        }
    }
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
