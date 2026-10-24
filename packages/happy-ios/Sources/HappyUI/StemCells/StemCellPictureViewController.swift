#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// Desktop's Lightbox on the phone: one picture whole on black, pinched or
/// double-tapped to zoom, closed by its button or a tap.
final class StemCellPictureViewController: UIViewController, UIScrollViewDelegate {
    private let source: ChatMediaSource
    private let key: String
    private let thumbhash: String?
    private let scrollView = UIScrollView()
    private let canvas = UIView()
    private let imageView = UIImageView()
    private let closeButton = UIButton(type: .system)
    private var loading: Task<Void, Never>?

    init(source: ChatMediaSource, key: String, thumbhash: String?, label: String) {
        self.source = source
        self.key = key
        self.thumbhash = thumbhash
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
        imageView.accessibilityLabel = label
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.stemCellsViewerGround)
        scrollView.delegate = self
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 4
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(scrollView)
        scrollView.addSubview(canvas)
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityIdentifier = "stem-picture-viewer"
        canvas.addSubview(imageView)
        closeButton.setImage(.icon(.ionicons("close"), size: 26), for: .normal)
        closeButton.tintColor = UIColor(Palette.stemCellsViewerControl)
        closeButton.accessibilityLabel = Strings.StemCells.close
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        view.addSubview(closeButton)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: self, action: #selector(close))
        tap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(tap)

        // Enough to zoom into: the long edge a sent photo is kept at.
        let pixels = 3072
        let source = source
        let key = key
        let thumbhash = thumbhash
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

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        loading?.cancel()
    }

    private func show(_ image: UIImage) {
        imageView.image = image
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let natural = imageView.image?.size ?? .zero
        let layout = StemCellPictureViewerLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), picture: natural)
        closeButton.setLayoutFrame(layout.close)
        guard scrollView.zoomScale == 1 else { return }
        scrollView.frame = view.bounds
        canvas.frame = CGRect(origin: .zero, size: view.bounds.size)
        scrollView.contentSize = view.bounds.size
        imageView.frame = layout.picture
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { canvas }

    @objc private func zoom(_ recognizer: UITapGestureRecognizer) {
        if scrollView.zoomScale > 1 {
            scrollView.setZoomScale(1, animated: true)
        } else {
            let point = recognizer.location(in: canvas)
            let size = CGSize(width: scrollView.bounds.width / 2.5, height: scrollView.bounds.height / 2.5)
            scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }

    @objc private func close() {
        dismiss(animated: true)
    }
}
#endif
