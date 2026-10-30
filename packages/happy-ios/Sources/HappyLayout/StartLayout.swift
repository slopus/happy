import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The first screen, as Android's (ui/start/StartScreen.kt): the gradient
/// fills the window, the logotype is about the middle, Start is centred
/// across about the middle of the lower third, and ⋯ is at the top right.
/// The free height splits 3 : 2 : 1 above the logo, between the logo and
/// Start, and below Start, then 16 above the bottom inset. When it all
/// outgrows the window (large text) nothing is free and it scrolls.
public struct StartLayout: Equatable, Sendable {
    public enum Metrics {
        /// logotype-*.png is 1200 × 319.
        public static let logoWidth: CGFloat = 220
        public static let logoAspect: CGFloat = 1200.0 / 319.0
        public static let buttonMinWidth: CGFloat = 200
        public static let bottomPadding: CGFloat = 16
        public static let controlsPadding: CGFloat = 4
        public static let control: CGFloat = 48
    }

    public var logo: CGRect
    public var button: CGRect
    public var more: CGRect
    /// The scrolled content's height, the safe area's when it all fits.
    public var contentHeight: CGFloat

    /// `button` is Start's own size; it is widened to the minimum and kept
    /// inside the safe area.
    public init(size: CGSize, safeArea: LayoutInsets, button buttonSize: CGSize) {
        let left = safeArea.left, width = max(0, size.width - safeArea.left - safeArea.right)
        let viewport = max(0, size.height - safeArea.top - safeArea.bottom)
        let logoSize = CGSize(width: Metrics.logoWidth, height: Metrics.logoWidth / Metrics.logoAspect)
        let buttonWidth = min(width, max(Metrics.buttonMinWidth, buttonSize.width))
        let fixed = logoSize.height + buttonSize.height + Metrics.bottomPadding
        let free = max(0, viewport - fixed)
        let unit = free / 6
        let logoY = safeArea.top + unit * 3
        logo = CGRect(x: left + (width - logoSize.width) / 2, y: logoY, width: logoSize.width, height: logoSize.height)
        button = CGRect(x: left + (width - buttonWidth) / 2, y: logo.maxY + unit * 2, width: buttonWidth, height: buttonSize.height)
        more = CGRect(
            x: size.width - safeArea.right - Metrics.controlsPadding - Metrics.control,
            y: safeArea.top + Metrics.controlsPadding,
            width: Metrics.control, height: Metrics.control
        )
        contentHeight = max(viewport, fixed)
    }
}
