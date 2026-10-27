#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// One picture of a conversation's, as the viewer pages them.
struct StemCellPicture: Equatable {
    let key: String
    let thumbhash: String?
    let label: String

    /// Every picture `items` show, in the conversation's order: the ones
    /// the person sent and the ones agents presented. Recordings play in
    /// the system's player, and files open in Quick Look.
    static func all(in items: [StemCellChatItem]) -> [StemCellPicture] {
        var pictures: [StemCellPicture] = []
        for item in items {
            for piece in item.pieces {
                switch piece {
                case .picture(let id, _, _):
                    pictures.append(StemCellPicture(key: StemCellMediaLoader.sentKey(id), thumbhash: nil, label: Strings.StemCells.picture))
                case .gallery(let media, _), .tree(let media, _):
                    for one in media where one.isVisual && !one.isVideo {
                        pictures.append(StemCellPicture(key: one.key, thumbhash: one.item.thumbhash, label: one.item.name))
                    }
                case .text, .file, .artifact, .story, .sidebarProposal:
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
final class StemCellPictureViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let source: ChatMediaSource
    private let pictures: [StemCellPicture]
    private(set) var index: Int
    private let pager = UIScrollView()
    /// The page in view and the ones either side of it.
    private var pages: [Int: StemCellPicturePage] = [:]
    private let closeButton = UIButton(type: .system)
    private let drag = UIPanGestureRecognizer()
    /// Set while the pager is placed for a new size, so its offset moving
    /// doesn't turn the page.
    private var placing = false

    init(source: ChatMediaSource, pictures: [StemCellPicture], index: Int) {
        self.source = source
        self.pictures = pictures
        self.index = min(max(0, index), max(0, pictures.count - 1))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    private var ground: UIColor { UIColor(Palette.stemCellsViewerGround) }

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
        closeButton.tintColor = UIColor(Palette.stemCellsViewerControl)
        closeButton.accessibilityLabel = Strings.StemCells.close
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        view.addSubview(closeButton)
        drag.addTarget(self, action: #selector(dragged(_:)))
        drag.delegate = self
        view.addGestureRecognizer(drag)
        // A swipe to the side turns the page only once it's no drag to close.
        pager.panGestureRecognizer.require(toFail: drag)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = StemCellPictureViewerLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), picture: .zero)
        closeButton.setLayoutFrame(layout.close)
        let pagerLayout = StemCellPicturePagerLayout(size: view.bounds.size, count: pictures.count)
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
        let layout = StemCellPicturePagerLayout(size: view.bounds.size, count: pictures.count)
        let wanted = Set(max(0, index - 1)...min(pictures.count - 1, index + 1))
        for (number, page) in pages where !wanted.contains(number) {
            page.removeFromSuperview()
            pages[number] = nil
        }
        for number in wanted where pages[number] == nil {
            let page = StemCellPicturePage(source: source, picture: pictures[number])
            page.frame = layout.page(number)
            page.safeArea = LayoutInsets(view.safeAreaInsets)
            page.onTap = { [weak self] in self?.close() }
            page.panGestureRecognizer.require(toFail: drag)
            pager.addSubview(page)
            pages[number] = page
        }
        for (number, page) in pages {
            page.isCurrent = number == index
            page.position = Strings.StemCells.pictureNumber(number + 1, of: pictures.count)
        }
    }

    // MARK: Paging

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard !placing, view.bounds.width > 0 else { return }
        let layout = StemCellPicturePagerLayout(size: view.bounds.size, count: pictures.count)
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

    private var current: StemCellPicturePage? { pages[index] }

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
        let dismissal = StemCellPictureDismissal(translation: translation.y, velocity: velocity.y, height: view.bounds.height)
        switch recognizer.state {
        case .changed:
            follow(page, translation: translation, dismissal: dismissal)
        case .ended, .cancelled, .failed:
            if recognizer.state == .ended, dismissal.closes {
                leave(page, translation: translation, velocity: velocity)
            } else {
                UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                    self.follow(page, translation: .zero, dismissal: StemCellPictureDismissal(translation: 0, velocity: 0, height: self.view.bounds.height))
                }
            }
        default:
            break
        }
    }

    private func follow(_ page: UIView, translation: CGPoint, dismissal: StemCellPictureDismissal) {
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
        let scale = StemCellPictureDismissal.minScale
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
}

/// One picture, fitted inside the safe area and never enlarged past its
/// own size, read from the conversation's media as it comes near.
final class StemCellPicturePage: UIScrollView, UIScrollViewDelegate {
    private let source: ChatMediaSource
    private let picture: StemCellPicture
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
            imageView.accessibilityIdentifier = isCurrent ? "stem-picture-viewer" : nil
            imageView.accessibilityElementsHidden = !isCurrent
        }
    }

    /// Where it is among the conversation's pictures, as VoiceOver reads it.
    var position: String? {
        get { imageView.accessibilityValue }
        set { imageView.accessibilityValue = newValue }
    }

    init(source: ChatMediaSource, picture: StemCellPicture) {
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
        let thumbhash = picture.thumbhash
        loading = Task { @MainActor [weak self] in
            if let cached = source.cachedImage(key, pixels: 1) {
                self?.show(cached)
            } else if let thumbhash, let placeholder = await source.placeholder(thumbhash) {
                self?.show(placeholder)
            }
            guard let image = await source.image(key, pixels: pixels), !Task.isCancelled else { return }
            self?.show(image)
        }
    }

    private func show(_ image: UIImage) {
        imageView.image = image
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard zoomScale == 1 else { return }
        let layout = StemCellPictureViewerLayout(size: bounds.size, safeArea: safeArea, picture: imageView.image?.size ?? .zero)
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
