#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A covered artifact's picture over its post (`FeedListItems.coverKind`):
/// read through the computer's images (`Images`), kept on disk with its
/// other pictures and decoded at no more than it is drawn, then faded in
/// over the placeholder the row's bitmap already holds. Its frame is the
/// layout's, exactly the cover's shape, so nothing moves when it arrives;
/// the up to 2% a picture may be off its shape is filled, centred. The
/// artifacts list shows the same covers, from the same cache, in its
/// rows' slots (`ArtifactCoverSlot`).
@MainActor
final class FeedCoverView: UIView {
    private let picture = UIImageView()
    private let markPicture = MarkPicture()

    convenience init(post: FeedPost, frame: CGRect, radius: CGFloat, displayScale: CGFloat, images: Images?) {
        self.init(image: post.image, width: post.width, height: post.height, frame: frame, radius: radius, displayScale: displayScale, images: images)
    }

    /// The cover served at `image`, `width` by `height` pixels, filling `frame`.
    init(image: String, width: Double, height: Double, frame: CGRect, radius: CGFloat, displayScale: CGFloat, images: Images?) {
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
        markPicture.load(image, thumbhash: nil, pixels: pixels, images: images, into: picture)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The picture is in.
    var loaded: Bool { picture.image != nil }

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
