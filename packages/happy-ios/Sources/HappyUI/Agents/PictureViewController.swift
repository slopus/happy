#if canImport(UIKit)
import AVKit
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A source whose recordings the viewer plays where they are paged.
@MainActor
protocol ChatMediaPlaying: ChatMediaSource {
    func player(_ key: String) -> AVPlayer?
}

/// A source that hands an item to the share sheet as a file, which offers
/// Save Image and Save Video with the rest.
@MainActor
protocol ChatMediaSharing: ChatMediaSource {
    func shareable(_ key: String) async -> URL?
}

/// One picture of a conversation's, as the viewer pages them.
struct Picture: Equatable {
    let key: String
    let thumbhash: String?
    let label: String
    /// Its pixels as stated, so its placeholder takes the picture's place.
    var size: CGSize?
    /// A recording, played in its page by a source that plays them.
    var isVideo = false

    init(key: String, thumbhash: String?, label: String, size: CGSize? = nil, isVideo: Bool = false) {
        self.key = key
        self.thumbhash = thumbhash
        self.label = label
        self.size = size
        self.isVideo = isVideo
    }

    /// A picture an agent presented.
    init(_ media: Media) {
        let item = media.item
        var size: CGSize?
        if let width = item.width, let height = item.height, width > 0, height > 0 { size = CGSize(width: width, height: height) }
        self.init(key: media.key, thumbhash: item.thumbhash, label: item.name, size: size)
    }

    /// Every picture `items` show, in the conversation's order: the ones
    /// the person sent and the ones agents presented. Recordings play in
    /// the system's player, and files open in Quick Look.
    static func all(in items: [ChatItem]) -> [Picture] {
        var pictures: [Picture] = []
        for item in items {
            for piece in item.pieces {
                switch piece {
                case .picture(let id, _, _):
                    pictures.append(Picture(key: MediaLoader.sentKey(id), thumbhash: nil, label: Strings.picture))
                case .gallery(let media, _), .tree(let media, _):
                    for one in media where one.isVisual && !one.isVideo {
                        pictures.append(Picture(one))
                    }
                case .sentFile(let file) where file.isVisual && !file.isVideo:
                    pictures.append(Picture(key: MediaLoader.sentKey(file.id), thumbhash: nil, label: file.name))
                case .text, .file, .artifact, .story, .sidebarProposal, .sentFile:
                    break
                }
            }
        }
        return pictures
    }
}

/// Desktop's Lightbox on the phone, as Photos and Telegram hold it: a
/// conversation's pictures whole on black, swiped between in its order,
/// each pinched or double-tapped to zoom; dragged up or down it follows
/// the finger as the black fades, and goes; its button or a tap closes it.
/// A recording plays in its page with the system's controls, from a
/// source that plays them; one that shares adds a share button.
final class PictureViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let source: ChatMediaSource
    private let pictures: [Picture]
    private(set) var index: Int
    private let pager = UIScrollView()
    /// The page in view and the ones either side of it.
    private var pages: [Int: any ViewerPage] = [:]
    private let closeButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private let sharing = UIActivityIndicatorView(style: .medium)
    private let drag = UIPanGestureRecognizer()
    /// Set while the pager is placed for a new size, so its offset moving
    /// doesn't turn the page.
    private var placing = false

    init(source: ChatMediaSource, pictures: [Picture], index: Int) {
        self.source = source
        self.pictures = pictures
        self.index = min(max(0, index), max(0, pictures.count - 1))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    private var ground: UIColor { UIColor(Palette.viewerGround) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ground
        pager.delegate = self
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.showsVerticalScrollIndicator = false
        pager.contentInsetAdjustmentBehavior = .never
        pager.alwaysBounceVertical = false
        view.addSubview(pager)
        closeButton.setImage(.icon(.ionicons("close"), size: 26), for: .normal)
        closeButton.tintColor = UIColor(Palette.viewerControl)
        closeButton.accessibilityLabel = Strings.close
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        view.addSubview(closeButton)
        if source is ChatMediaSharing {
            shareButton.setImage(.icon(.ionicons("share-outline"), size: 24), for: .normal)
            shareButton.tintColor = UIColor(Palette.viewerControl)
            shareButton.accessibilityLabel = Strings.ArtifactMedia.share
            shareButton.accessibilityIdentifier = "picture-share"
            shareButton.addTarget(self, action: #selector(share), for: .touchUpInside)
            view.addSubview(shareButton)
            sharing.color = UIColor(Palette.viewerControl)
            sharing.hidesWhenStopped = true
            view.addSubview(sharing)
        }
        drag.addTarget(self, action: #selector(dragged(_:)))
        drag.delegate = self
        view.addGestureRecognizer(drag)
        // A swipe to the side turns the page only once it's no drag to close.
        pager.panGestureRecognizer.require(toFail: drag)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = PictureViewerLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), picture: .zero)
        closeButton.setLayoutFrame(layout.close)
        shareButton.setLayoutFrame(layout.share)
        sharing.setLayoutFrame(layout.share)
        let pagerLayout = PicturePagerLayout(size: view.bounds.size, count: pictures.count)
        for page in pages.values { page.safeArea = LayoutInsets(view.safeAreaInsets) }
        guard pager.frame != pagerLayout.pager || pager.contentSize != pagerLayout.contentSize else { return }
        placing = true
        pager.frame = pagerLayout.pager
        pager.contentSize = pagerLayout.contentSize
        pager.contentOffset = CGPoint(x: pagerLayout.offset(index), y: 0)
        placing = false
        for (number, page) in pages {
            // A new size is a whole picture again, laid out for it.
            if page.zoomScale != 1 { page.setZoomScale(1, animated: false) }
            page.transform = .identity
            page.frame = pagerLayout.page(number)
            page.setNeedsLayout()
        }
        showPages()
    }

    /// The page in view and its neighbours, made as they come near and
    /// let go as they leave.
    private func showPages() {
        guard !pictures.isEmpty, view.bounds.width > 0 else { return }
        let layout = PicturePagerLayout(size: view.bounds.size, count: pictures.count)
        let wanted = Set(max(0, index - 1)...min(pictures.count - 1, index + 1))
        for (number, page) in pages where !wanted.contains(number) {
            if let page = page as? VideoPage { release(page) }
            page.removeFromSuperview()
            pages[number] = nil
        }
        for number in wanted where pages[number] == nil {
            let picture = pictures[number]
            let page: any ViewerPage
            if picture.isVideo, let player = (source as? ChatMediaPlaying)?.player(picture.key) {
                let video = VideoPage(player: player, label: picture.label)
                addChild(video.playback)
                page = video
            } else {
                page = PicturePage(source: source, picture: picture)
            }
            page.frame = layout.page(number)
            page.safeArea = LayoutInsets(view.safeAreaInsets)
            page.onTap = { [weak self] in self?.close() }
            page.panGestureRecognizer.require(toFail: drag)
            pager.addSubview(page)
            pages[number] = page
            if let video = page as? VideoPage { video.playback.didMove(toParent: self) }
        }
        for (number, page) in pages {
            page.isCurrent = number == index
            page.position = Strings.pictureNumber(number + 1, of: pictures.count)
        }
    }

    // MARK: Paging

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard !placing, view.bounds.width > 0 else { return }
        let layout = PicturePagerLayout(size: view.bounds.size, count: pictures.count)
        let next = layout.index(at: scrollView.contentOffset.x, count: pictures.count)
        guard next != index else { return }
        index = next
        showPages()
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        settlePages()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settlePages() }
    }

    /// Turned away from, a page is whole again when it comes back.
    private func settlePages() {
        for (number, page) in pages where number != index && page.zoomScale != 1 { page.setZoomScale(1, animated: false) }
    }

    // MARK: Closing

    private var current: (any ViewerPage)? { pages[index] }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard recognizer === drag, let current else { return true }
        let velocity = drag.velocity(in: view)
        // Mostly up or down, on a whole picture, with no page turning.
        return abs(velocity.y) > abs(velocity.x) && current.zoomScale <= current.minimumZoomScale + 0.01 && !pager.isDragging && !pager.isDecelerating
    }

    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        guard let page = current else { return }
        let translation = recognizer.translation(in: view)
        let velocity = recognizer.velocity(in: view)
        let dismissal = PictureDismissal(translation: translation.y, velocity: velocity.y, height: view.bounds.height)
        switch recognizer.state {
        case .changed:
            follow(page, translation: translation, dismissal: dismissal)
        case .ended, .cancelled, .failed:
            if recognizer.state == .ended, dismissal.closes {
                leave(page, translation: translation, velocity: velocity)
            } else {
                UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                    self.follow(page, translation: .zero, dismissal: PictureDismissal(translation: 0, velocity: 0, height: self.view.bounds.height))
                }
            }
        default:
            break
        }
    }

    private func follow(_ page: UIView, translation: CGPoint, dismissal: PictureDismissal) {
        page.transform = CGAffineTransform(translationX: translation.x, y: translation.y).scaledBy(x: dismissal.scale, y: dismissal.scale)
        view.backgroundColor = ground.withAlphaComponent(dismissal.groundAlpha)
        closeButton.alpha = dismissal.groundAlpha
    }

    /// Let go far or fast enough: it carries on off the screen the way it
    /// was going as the rest of the black goes, then the viewer is gone.
    private func leave(_ page: UIView, translation: CGPoint, velocity: CGPoint) {
        let down = velocity.y == 0 ? translation.y >= 0 : velocity.y > 0
        let distance = view.bounds.height
        let remaining = max(1, distance - abs(translation.y))
        let duration = min(0.3, max(0.15, TimeInterval(remaining / max(abs(velocity.y), 1))))
        let scale = PictureDismissal.minScale
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut]) {
            page.transform = CGAffineTransform(translationX: translation.x, y: down ? distance : -distance).scaledBy(x: scale, y: scale)
            self.view.backgroundColor = self.ground.withAlphaComponent(0)
            self.closeButton.alpha = 0
        } completion: { _ in
            self.dismiss(animated: false)
        }
    }

    @objc private func close() {
        dismiss(animated: true)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        for case let page as VideoPage in pages.values { page.player.pause() }
    }

    /// A recording's page leaves: its player stops and its controller goes.
    private func release(_ page: VideoPage) {
        page.player.pause()
        page.playback.willMove(toParent: nil)
        page.playback.removeFromParent()
    }

    // MARK: Sharing

    /// The item in view as a file, in the share sheet; the button waits
    /// while its bytes come.
    @objc private func share() {
        guard let source = source as? ChatMediaSharing, pictures.indices.contains(index) else { return }
        let key = pictures[index].key
        shareButton.isHidden = true
        sharing.startAnimating()
        Task { [weak self] in
            let url = await source.shareable(key)
            guard let self else { return }
            self.sharing.stopAnimating()
            self.shareButton.isHidden = false
            guard let url, self.presentedViewController == nil else { return }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = self.shareButton
            self.present(sheet, animated: true)
        }
    }
}

/// A page of the viewer: a picture, or a recording.
@MainActor
protocol ViewerPage: UIScrollView {
    var safeArea: LayoutInsets { get set }
    var isCurrent: Bool { get set }
    var position: String? { get set }
    var onTap: (() -> Void)? { get set }
}

extension PicturePage: ViewerPage {}

/// A recording in the viewer, played by the system's player with its own
/// controls (scrubbing, full screen, picture in picture) in the safe area
/// under the viewer's buttons. It plays while it is the page in view.
final class VideoPage: UIScrollView, ViewerPage {
    let player: AVPlayer
    let playback = AVPlayerViewController()
    var onTap: (() -> Void)?
    var safeArea = LayoutInsets() {
        didSet { if safeArea != oldValue { setNeedsLayout() } }
    }

    var isCurrent = false {
        didSet {
            guard isCurrent != oldValue else { return }
            playback.view.accessibilityElementsHidden = !isCurrent
            if isCurrent { player.play() } else { player.pause() }
        }
    }

    var position: String? {
        get { playback.view.accessibilityValue }
        set { playback.view.accessibilityValue = newValue }
    }

    init(player: AVPlayer, label: String) {
        self.player = player
        super.init(frame: .zero)
        // Turned and dragged by the viewer, never scrolled or zoomed itself.
        isScrollEnabled = false
        minimumZoomScale = 1
        maximumZoomScale = 1
        contentInsetAdjustmentBehavior = .never
        playback.player = player
        playback.view.backgroundColor = .clear
        playback.view.accessibilityIdentifier = "video-viewer"
        playback.view.accessibilityLabel = label
        playback.entersFullScreenWhenPlaybackBegins = false
        addSubview(playback.view)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        contentSize = bounds.size
        playback.view.frame = PictureViewerLayout(size: bounds.size, safeArea: safeArea, picture: .zero).player
    }
}

/// One picture, fitted inside the safe area and never enlarged past its
/// own size, read from the conversation's media as it comes near.
final class PicturePage: UIScrollView, UIScrollViewDelegate {
    private let source: ChatMediaSource
    private let picture: Picture
    private let canvas = UIView()
    private let imageView = UIImageView()
    private var loading: Task<Void, Never>?
    var onTap: (() -> Void)?
    var safeArea = LayoutInsets() {
        didSet { if safeArea != oldValue { setNeedsLayout() } }
    }

    /// The one in view is the viewer's picture to UI tests and VoiceOver.
    var isCurrent = false {
        didSet {
            imageView.accessibilityIdentifier = isCurrent ? "picture-viewer" : nil
            imageView.accessibilityElementsHidden = !isCurrent
        }
    }

    /// What it shows and where, for tests.
    var shownImage: UIImage? { imageView.image }
    var shownFrame: CGRect { imageView.frame }

    /// Where it is among the conversation's pictures, as VoiceOver reads it.
    var position: String? {
        get { imageView.accessibilityValue }
        set { imageView.accessibilityValue = newValue }
    }

    init(source: ChatMediaSource, picture: Picture) {
        self.source = source
        self.picture = picture
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 4
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        addSubview(canvas)
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = picture.label
        canvas.addSubview(imageView)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.require(toFail: doubleTap)
        addGestureRecognizer(tap)
        load()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit { loading?.cancel() }

    override func removeFromSuperview() {
        super.removeFromSuperview()
        loading?.cancel()
    }

    private func load() {
        // Enough to zoom into: the long edge a sent photo is kept at.
        let pixels = 3072
        let source = source
        let key = picture.key
        // Whatever is kept, else the thumbhash, before the first frame.
        if let cached = source.cachedImage(key, pixels: 1) {
            show(cached, fade: false)
        } else if let placeholder = ThumbHashImages.image(picture.thumbhash) {
            showsPlaceholder = true
            show(placeholder, fade: false)
        }
        loading = Task { @MainActor [weak self] in
            guard let image = await source.image(key, pixels: pixels), !Task.isCancelled, let self else { return }
            let fade = showsPlaceholder
            showsPlaceholder = false
            show(image, fade: fade)
        }
    }

    /// The thumbhash stands in: it is drawn at the picture's size, not its own.
    private var showsPlaceholder = false

    private func show(_ image: UIImage, fade: Bool) {
        ImageFade.show(image, in: imageView, fade: fade)
        setNeedsLayout()
    }

    /// The size the picture is laid out at: the placeholder's is the
    /// picture's as stated, else as tall as the screen in the hash's shape.
    private var shownSize: CGSize {
        guard showsPlaceholder else { return imageView.image?.size ?? .zero }
        if let size = picture.size { return size }
        guard let ratio = ThumbHashImages.aspectRatio(picture.thumbhash), ratio > 0 else { return .zero }
        let side = max(bounds.width, bounds.height, 1) * 4
        return CGSize(width: side * ratio, height: side)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard zoomScale == 1 else { return }
        let layout = PictureViewerLayout(size: bounds.size, safeArea: safeArea, picture: shownSize)
        canvas.frame = CGRect(origin: .zero, size: bounds.size)
        contentSize = bounds.size
        imageView.frame = layout.picture
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { canvas }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        // Whole again, laid out for the size it has now.
        if scale == 1 { setNeedsLayout() }
    }

    @objc private func zoom(_ recognizer: UITapGestureRecognizer) {
        if zoomScale > 1 {
            setZoomScale(1, animated: true)
        } else {
            let point = recognizer.location(in: canvas)
            let size = CGSize(width: bounds.width / 2.5, height: bounds.height / 2.5)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }

    @objc private func tapped() { onTap?() }
}
#endif
