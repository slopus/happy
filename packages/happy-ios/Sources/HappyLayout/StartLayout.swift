import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The first screen, as Android's (ui/start/StartScreen.kt): the gradient
/// fills the window, Start is centred across, as wide as its label (at
/// least 200), 48 above the bottom inset; the logotype is centred in the
/// space above Start; ⋯ is at the top right. When it all outgrows the
/// window (large text) nothing is free and it scrolls.
public struct StartLayout: Equatable, Sendable {
    public enum Metrics {
        /// logotype-*.png is 1200 × 319.
        public static let logoWidth: CGFloat = 220
        public static let logoAspect: CGFloat = 1200.0 / 319.0
        public static let buttonMinWidth: CGFloat = 200
        public static let bottomPadding: CGFloat = 48
        public static let controlsPadding: CGFloat = 4
        public static let control: CGFloat = 48
    }

    public var logo: CGRect
    public var button: CGRect
    public var more: CGRect
    /// The scrolled content's height, the safe area's when it all fits.
    public var contentHeight: CGFloat

    /// `button` is Start's own size, as wide as its label; it is widened
    /// to the minimum and kept inside the safe area.
    public init(size: CGSize, safeArea: LayoutInsets, button buttonSize: CGSize) {
        let left = safeArea.left, width = max(0, size.width - safeArea.left - safeArea.right)
        let viewport = max(0, size.height - safeArea.top - safeArea.bottom)
        let logoSize = CGSize(width: Metrics.logoWidth, height: Metrics.logoWidth / Metrics.logoAspect)
        let buttonWidth = min(width, max(Metrics.buttonMinWidth, buttonSize.width))
        let fixed = logoSize.height + buttonSize.height + Metrics.bottomPadding
        let height = max(viewport, fixed)
        let buttonY = safeArea.top + height - Metrics.bottomPadding - buttonSize.height
        button = CGRect(x: left + (width - buttonWidth) / 2, y: buttonY, width: buttonWidth, height: buttonSize.height)
        // The space above Start, split evenly over and under the logo.
        let free = max(0, buttonY - safeArea.top - logoSize.height)
        logo = CGRect(x: left + (width - logoSize.width) / 2, y: safeArea.top + free / 2, width: logoSize.width, height: logoSize.height)
        more = CGRect(
            x: size.width - safeArea.right - Metrics.controlsPadding - Metrics.control,
            y: safeArea.top + Metrics.controlsPadding,
            width: Metrics.control, height: Metrics.control
        )
        contentHeight = height
    }
}
