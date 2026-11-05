#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A covered artifact's picture over its post (`FeedListItems.coverKind`):
/// read through the computer's images (`Images`), kept on disk with its
/// other pictures and decoded at no more than it is drawn, then faded in
/// over the placeholder the row's bitmap already holds. Its frame is the
/// layout's, exactly the cover's shape, so nothing moves when it arrives;
/// the up to 2% a picture may be off its shape is filled, centred.
@MainActor
final class FeedCoverView: UIView {
    private let picture = UIImageView()
    private let markPicture = MarkPicture()

    init(post: FeedPost, frame: CGRect, radius: CGFloat, displayScale: CGFloat, images: Images?) {
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
        let pixels = Self.pixels(post, shown: frame.size, displayScale: displayScale)
        markPicture.load(post.image, thumbhash: nil, pixels: pixels, images: images, into: picture)
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
    nonisolated static func pixels(_ post: FeedPost, shown: CGSize, displayScale: CGFloat) -> Int {
        let scale = max(displayScale, 2)
        guard post.width > 0, post.height > 0 else { return Int((max(shown.width, shown.height) * scale).rounded(.up)) }
        let aspect = CGFloat(post.width / post.height)
        let width = max(shown.width, shown.height * aspect)
        let longest = max(width, width / aspect)
        return min(Int(max(post.width, post.height)), Int((longest * scale).rounded(.up)))
    }
}
#endif
