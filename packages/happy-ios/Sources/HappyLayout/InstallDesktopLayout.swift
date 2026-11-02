import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The screen after the first one's Start (InstallDesktopViewController,
/// Android's InstallDesktopScreen). Scan QR code is where Start was:
/// centred, as wide as its label (at least 200), 48 above the bottom inset.
/// The rest is centred in the space between the bar and it:
///
///     laptop scene 96                the slides' art square
///     24
///     Install Happy on your computer
///     8
///     what to choose there
///     4
///     (globe) happy.engineering      the site, a 40 tall target
///
/// Taller than the window, nothing is free: 16 is kept above and below the
/// words and it scrolls.
public struct InstallDesktopLayout: Equatable, Sendable {
    public enum Metrics {
        public static let art: CGFloat = StartLayout.Metrics.art
        public static let artGap: CGFloat = StartLayout.Metrics.artGap
        public static let titleGap: CGFloat = NoSessionsLayout.Metrics.titleMarginBottom
        public static let linkGap: CGFloat = 4
        public static let margin: CGFloat = StartLayout.Metrics.galleryMargin
        public static let bottomPadding: CGFloat = StartLayout.Metrics.bottomPadding
        public static let paddingHorizontal: CGFloat = NoSessionsLayout.Metrics.paddingHorizontal
        public static let descriptionMaxWidth: CGFloat = NoSessionsLayout.Metrics.descriptionMaxWidth
        /// The site's target, as a text action's (`TextActionLayout`).
        public static let linkMinHeight: CGFloat = TextActionLayout.Metrics.minHeight
        public static let linkPadding: CGFloat = TextActionLayout.Metrics.paddingHorizontal
        public static let linkIcon: CGFloat = 16
        public static let linkIconGap: CGFloat = 6
    }

    public var art: CGRect
    public var title: CGRect
    /// The site's target, and in it its globe and its label.
    public var link: CGRect
    public var linkIcon: CGRect
    public var linkLabel: CGRect
    public var description: CGRect
    public var button: CGRect
    /// The scrolled content's height: the window's while it fits.
    public var contentHeight: CGFloat

    /// `button` is Scan QR code's own size, as wide as its label.
    public init(size: CGSize, safeArea: LayoutInsets, title: Measurable, link: Measurable, description: Measurable, button buttonSize: CGSize) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let viewport = max(0, size.height - safeArea.vertical)
        let textWidth = max(0, width - M.paddingHorizontal * 2)
        let titleSize = title.size(fitting: textWidth)
        let labelSize = link.size(fitting: max(0, textWidth - M.linkPadding * 2 - M.linkIcon - M.linkIconGap))
        let linkSize = CGSize(
            width: M.linkPadding * 2 + M.linkIcon + M.linkIconGap + labelSize.width,
            height: max(M.linkMinHeight, labelSize.height)
        )
        let descriptionSize = description.size(fitting: max(0, min(M.descriptionMaxWidth, width) - M.paddingHorizontal * 2))
        let buttonWidth = min(textWidth, max(StartLayout.Metrics.buttonMinWidth, buttonSize.width))

        let words = M.art + M.artGap + titleSize.height + M.titleGap + descriptionSize.height + M.linkGap + linkSize.height
        let height = max(viewport, M.margin * 2 + words + buttonSize.height + M.bottomPadding)
        let buttonY = safeArea.top + height - M.bottomPadding - buttonSize.height
        func centred(_ size: CGSize, _ y: CGFloat) -> CGRect {
            CGRect(x: safeArea.left + (width - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        button = centred(CGSize(width: buttonWidth, height: buttonSize.height), buttonY)
        var y = safeArea.top + max(0, buttonY - safeArea.top - words) / 2
        art = centred(CGSize(width: M.art, height: M.art), y)
        y = art.maxY + M.artGap
        self.title = centred(titleSize, y)
        y = self.title.maxY + M.titleGap
        self.description = centred(descriptionSize, y)
        y = self.description.maxY + M.linkGap
        self.link = centred(linkSize, y)
        linkIcon = CGRect(x: M.linkPadding, y: (linkSize.height - M.linkIcon) / 2, width: M.linkIcon, height: M.linkIcon)
        linkLabel = CGRect(x: linkIcon.maxX + M.linkIconGap, y: (linkSize.height - labelSize.height) / 2, width: labelSize.width, height: labelSize.height)
        contentHeight = safeArea.top + height + safeArea.bottom
    }
}
