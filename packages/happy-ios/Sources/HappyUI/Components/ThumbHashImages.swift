#if canImport(UIKit)
import HappyCore
import UIKit

/// Every thumbhash placeholder the app draws, decoded where it is asked for
/// and kept (`ThumbHashCache`), so a view sets one while it is configured
/// and its first frame on screen already shows it. A decode is the hash's
/// 32 pixels on the long side, tens of microseconds; 256 of them (about a
/// megabyte) are kept.
enum ThumbHashImages {
    static let cache = ThumbHashCache<UIImage> { AccountPictureImages.placeholder($0)?.picture as? UIImage }

    /// The placeholder for `thumbhash`; nil for none, or one that is not a hash.
    static func image(_ thumbhash: String?) -> UIImage? {
        cache.picture(thumbhash)
    }

    /// The picture's width over height as the hash carries it.
    static func aspectRatio(_ thumbhash: String?) -> CGFloat? {
        thumbhash.flatMap(ThumbHash.aspectRatio(base64:)).map { CGFloat($0) }
    }
}

/// How a picture that arrived replaces what stood in for it: a 0.2 s
/// cross-dissolve, the same everywhere. A picture already in memory when
/// the view is configured is set without one, so a reused cell never
/// flickers; and nothing fades under Reduce Motion or off screen.
@MainActor
enum ImageFade {
    static let duration: TimeInterval = 0.2

    static func animates(_ view: UIView) -> Bool {
        view.window != nil && !UIAccessibility.isReduceMotionEnabled
    }

    /// Puts `image` in `view`, dissolving from what it showed when `fade`.
    static func show(_ image: UIImage?, in view: UIImageView, fade: Bool) {
        guard fade, animates(view), image !== view.image else {
            view.image = image
            return
        }
        UIView.transition(with: view, duration: duration, options: [.transitionCrossDissolve, .allowUserInteraction, .beginFromCurrentState]) {
            view.image = image
        }
    }

    /// Fades `view` in over what is under it (its placeholder), then calls
    /// `completion`; at once when it can't animate.
    static func fadeIn(_ view: UIView, completion: @escaping () -> Void = {}) {
        view.layer.removeAllAnimations()
        guard animates(view) else {
            view.alpha = 1
            completion()
            return
        }
        view.alpha = 0
        UIView.animate(withDuration: duration, delay: 0, options: [.allowUserInteraction, .curveEaseOut]) {
            view.alpha = 1
        } completion: { _ in
            completion()
        }
    }
}
#endif
