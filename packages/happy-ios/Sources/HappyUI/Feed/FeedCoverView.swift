#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A covered artifact's picture over its post (`FeedListItems.coverKind`):
/// read through the computer's images (`Images`), kept on disk with its
/// other pictures and decoded at no more than it is drawn, then faded in
/// over the placeholder the row's bitmap already holds. Its frame is the
/// layout's, exactly the cover's shape, so nothing moves when it arrives;
/// the up to 2% a picture may be off its shape is filled, centred. Its
/// ThumbHash stands in until it arrives, else the row's fill does. A post's
/// WebP or GIF cover of more than one frame then plays
/// (`CoverAnimation`). The artifacts list shows the daemon's stills of the
/// same covers and pictures, from the same cache, in its rows' slots
/// (`ArtifactCoverSlot`), never moving.
@MainActor
final class FeedCoverView: UIView {
    private let picture = UIImageView()
    private let markPicture = MarkPicture()
    private(set) var loaded = false
    private(set) var animation: CoverAnimation?
    private var reading: Task<Void, Never>?

    /// A post's cover, which plays when it moves.
    convenience init(cover: FeedPost.Cover, frame: CGRect, radius: CGFloat, displayScale: CGFloat, images: Images?) {
        self.init(image: cover.image, width: cover.width, height: cover.height, thumbhash: cover.thumbhash, animates: cover.mayMove,
                  frame: frame, radius: radius, displayScale: displayScale, images: images)
    }

    /// The picture served at `image`, `width` by `height` pixels, filling
    /// `frame`, over `thumbhash` until it is read; playing, with
    /// `animates`, when it has more than one frame.
    init(image: String, width: Double, height: Double, thumbhash: String? = nil, animates: Bool = false, frame: CGRect, radius: CGFloat, displayScale: CGFloat, images: Images?) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        accessibilityIgnoresInvertColors = true
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.frame = bounds
        addSubview(picture)
        let pixels = Self.pixels(width: width, height: height, shown: frame.size, displayScale: displayScale)
        markPicture.load(image, thumbhash: thumbhash, pixels: pixels, images: images, into: picture, shown: { [weak self] in
            guard let self else { return }
            loaded = true
            if animates, let images { play(image, thumbhash: thumbhash, pixels: pixels, images: images) }
        })
    }

    deinit { reading?.cancel() }

    /// Its ThumbHash shows, the picture not yet in.
    var placeholder: Bool { !loaded && picture.image != nil }

    /// The file's bytes, read from where the still was kept; a picture of
    /// one frame stays still.
    private func play(_ path: String, thumbhash: String?, pixels: Int, images: Images) {
        reading = Task { [weak self] in
            guard let data = await images.bytes(path, thumbhash: thumbhash), !Task.isCancelled,
                  await Task.detached(priority: .utility, operation: { CoverAnimation.moves(data) }).value,
                  let self else { return }
            animation = CoverAnimation(data: data, pixels: pixels, view: picture)
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        animation?.update()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
    }

    /// The longer side, in pixels, a decode needs for the picture to fill
    /// `shown` at `displayScale`: its width or its height covers the frame,
    /// whichever the crop keeps whole.
    nonisolated static func pixels(width: Double, height: Double, shown: CGSize, displayScale: CGFloat) -> Int {
        let scale = max(displayScale, 2)
        guard width > 0, height > 0 else { return Int((max(shown.width, shown.height) * scale).rounded(.up)) }
        let aspect = CGFloat(width / height)
        let needed = max(shown.width, shown.height * aspect)
        let longest = max(needed, needed / aspect)
        return min(Int(max(width, height)), Int((longest * scale).rounded(.up)))
    }
}
#endif
