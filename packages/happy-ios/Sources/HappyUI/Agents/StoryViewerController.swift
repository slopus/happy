#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// One task's or bot's live stories, full screen and oldest first: a
/// segment for each across the top, the poster's icon and name, the
/// caption over the bottom. A tap on the left third goes back, anywhere
/// else on; close, or the last one played through, ends it. One that
/// fails to load moves on as if played. Each story is seen once it shows.
@MainActor
final class StoryViewerController: UIViewController {
    private let client: AgentClient
    private let library: MediaLibrary?
    private let seen: @MainActor (String) -> Void
    private let stories: [Story]
    private(set) var index: Int
    private let picture = UIImageView()
    private let video = StoryPlayerView()
    private var player: AVPlayer?
    private var failure: NSKeyValueObservation?
    /// The video's bytes; its asset holds it only weakly.
    private var stream: MediaStream?
    private let segments: [UIProgressView]
    private let mark = UIImageView()
    private let name = UILabel()
    private let close = UIButton(type: .system)
    private let caption = UILabel()
    private var loading: Task<Void, Never>?
    /// When the shown picture started its clock; nil until it is on screen.
    private var shownAt: CFTimeInterval?
    private var clock: CADisplayLink?

    init(client: AgentClient, library: MediaLibrary?, stories: [Story], name: String, mark: UIImage?, seen: @escaping @MainActor (String) -> Void) {
        (self.client, self.library, self.seen) = (client, library, seen)
        self.stories = stories
        index = stories.firstIndex { !$0.seen } ?? 0
        segments = stories.map { _ in UIProgressView(progressViewStyle: .bar) }
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
        modalTransitionStyle = .crossDissolve
        (self.name.text, self.mark.image) = (name, mark)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        picture.contentMode = .scaleAspectFit
        mark.contentMode = .scaleAspectFill
        mark.clipsToBounds = true
        mark.layer.cornerRadius = StoryLayout.Metrics.markRadius
        mark.layer.cornerCurve = .continuous
        name.font = .systemFont(ofSize: 15, weight: .semibold)
        caption.font = .systemFont(ofSize: 16)
        caption.numberOfLines = 0
        for label in [name, caption] { (label.textColor, label.layer.shadowOpacity, label.layer.shadowRadius, label.layer.shadowOffset) = (.white, 0.6, 3, .zero) }
        close.setImage(Glyphs.image("close", size: 24), for: .normal)
        close.tintColor = .white
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        for segment in segments { (segment.trackTintColor, segment.progressTintColor) = (UIColor.white.withAlphaComponent(0.35), .white) }
        for view in [picture, video, mark, name, caption, close] + segments { self.view.addSubview(view) }
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        for name in [AVPlayerItem.didPlayToEndTimeNotification, AVPlayerItem.failedToPlayToEndTimeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(playerItemEnded(_:)), name: name, object: nil)
        }
        show(index)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        clock?.invalidate()
        clock = CADisplayLink(target: self, selector: #selector(tick))
        clock?.add(to: .main, forMode: .common)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        clock?.invalidate()
        clock = nil
        loading?.cancel()
        player?.pause()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width - 2 * StoryLayout.Metrics.captionInset
        let layout = StoryLayout.viewer(
            size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), count: stories.count,
            nameHeight: name.font.lineHeight.rounded(.up),
            captionHeight: caption.text == nil ? 0 : caption.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height.rounded(.up)
        )
        (picture.frame, video.frame, mark.frame) = (view.bounds, view.bounds, layout.mark)
        (name.frame, close.frame, caption.frame) = (layout.name, layout.close, layout.caption)
        for (segment, frame) in zip(segments, layout.segments) { segment.frame = frame }
    }

    // MARK: Showing

    private func show(_ next: Int) {
        index = next
        let story = stories[next]
        loading?.cancel()
        player?.pause()
        (player, stream, failure, video.playerLayer.player, picture.image, shownAt) = (nil, nil, nil, nil, nil, nil)
        caption.text = story.caption
        view.setNeedsLayout()
        seen(story.id)
        if story.isVideo, let library {
            // From what is on this phone and what streams in, as a chat's video plays.
            let stream = MediaStream(downloads: library.downloads, id: "story/\(story.id)", source: client.storySource(story), name: "story.mp4", mimeType: story.media.mimeType)
            let item = AVPlayerItem(asset: stream.asset())
            // One that can't be read at all is done, as one that stopped short is.
            failure = item.observe(\.status) { item, _ in
                if item.status == .failed { NotificationCenter.default.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: item) }
            }
            (self.stream, player) = (stream, AVPlayer(playerItem: item))
            video.playerLayer.player = player
            player?.play()
        } else {
            // A picture, or a video with nowhere to stream to; one that can't be read shows black for a picture's time.
            loading = Task { [weak self, client] in
                let body = story.isVideo ? nil : try? await client.storyMedia(story.id).body
                guard !Task.isCancelled else { return }
                self?.picture.image = body.flatMap(UIImage.init(data:))
                self?.shownAt = CACurrentMediaTime()
            }
        }
    }

    /// A video played to its end, or failed: the next story.
    @objc private nonisolated func playerItemEnded(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem else { return }
        let id = ObjectIdentifier(item)
        DispatchQueue.main.async { MainActor.assumeIsolated { if self.playerItem.map(ObjectIdentifier.init) == id { self.step(1) } } }
    }

    var playerItem: AVPlayerItem? { player?.currentItem }

    /// How far the shown story is, 0 to 1: a video by its time, a picture by its clock.
    private var progress: Double {
        if let item = player?.currentItem {
            let duration = item.duration.seconds
            return duration.isFinite && duration > 0 ? item.currentTime().seconds / duration : 0
        }
        return shownAt.map { (CACurrentMediaTime() - $0) / StoryLayout.Metrics.imageDuration } ?? 0
    }

    @objc private func tick() {
        let current = progress
        for (offset, segment) in segments.enumerated() {
            segment.progress = offset < index ? 1 : offset > index ? 0 : Float(min(current, 1))
        }
        if player == nil, current >= 1 { step(1) }
    }

    private func step(_ by: Int) {
        if stories.indices.contains(index + by) { return show(index + by) }
        if by > 0 { dismiss(animated: true) } else { show(index) }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        step(StoryLayout.step(atX: gesture.location(in: view).x, width: view.bounds.width))
    }

    @objc private func closeTapped() { dismiss(animated: true) }
}

private final class StoryPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
#endif
