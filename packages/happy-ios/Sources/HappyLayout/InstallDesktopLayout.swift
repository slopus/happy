import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The screen after the first one's Start (InstallDesktopViewController,
/// Android's InstallDesktopScreen), centred in the safe area as home's
/// empty states are (`NoSessionsLayout`'s numbers):
///
///     desktop glyph 56
///     20
///     Install Happy on your computer
///     8
///     what to choose there
///     4
///     (globe) happy.engineering      the site, a 40 tall target
///     20
///     [ Scan QR code ]               as wide as its label, at least 200
///
/// The site comes before Scan: getting Happy is the first thing to do.
/// Taller than the safe area, it starts at the top and scrolls.
public struct InstallDesktopLayout: Equatable, Sendable {
    public enum Metrics {
        public static let iconSize: CGFloat = NoSessionsLayout.Metrics.iconSize
        public static let iconGap: CGFloat = NoSessionsLayout.Metrics.iconMarginBottom
        public static let titleGap: CGFloat = NoSessionsLayout.Metrics.titleMarginBottom
        public static let linkGap: CGFloat = 4
        public static let buttonGap: CGFloat = 20
        public static let paddingHorizontal: CGFloat = NoSessionsLayout.Metrics.paddingHorizontal
        public static let descriptionMaxWidth: CGFloat = NoSessionsLayout.Metrics.descriptionMaxWidth
        public static let marginBottom: CGFloat = NoSessionsLayout.Metrics.marginBottom
        /// The site's target, as a text action's (`TextActionLayout`).
        public static let linkMinHeight: CGFloat = TextActionLayout.Metrics.minHeight
        public static let linkPadding: CGFloat = TextActionLayout.Metrics.paddingHorizontal
        public static let linkIcon: CGFloat = 16
        public static let linkIconGap: CGFloat = 6
    }

    public var icon: CGRect
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
        let textWidth = max(0, width - M.paddingHorizontal * 2)
        let titleSize = title.size(fitting: textWidth)
        let labelSize = link.size(fitting: max(0, textWidth - M.linkPadding * 2 - M.linkIcon - M.linkIconGap))
        let linkSize = CGSize(
            width: M.linkPadding * 2 + M.linkIcon + M.linkIconGap + labelSize.width,
            height: max(M.linkMinHeight, labelSize.height)
        )
        let descriptionSize = description.size(fitting: max(0, min(M.descriptionMaxWidth, width) - M.paddingHorizontal * 2))
        let buttonWidth = min(textWidth, max(StartLayout.Metrics.buttonMinWidth, buttonSize.width))

        let height = M.iconSize + M.iconGap + titleSize.height + M.titleGap + descriptionSize.height + M.linkGap
            + linkSize.height + M.buttonGap + buttonSize.height
        let available = max(0, size.height - safeArea.vertical - M.marginBottom)
        var y = safeArea.top + max(0, available - height) / 2
        func centred(_ size: CGSize, _ y: CGFloat) -> CGRect {
            CGRect(x: safeArea.left + (width - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        icon = centred(CGSize(width: M.iconSize, height: M.iconSize), y)
        y = icon.maxY + M.iconGap
        self.title = centred(titleSize, y)
        y = self.title.maxY + M.titleGap
        self.description = centred(descriptionSize, y)
        y = self.description.maxY + M.linkGap
        self.link = centred(linkSize, y)
        linkIcon = CGRect(x: M.linkPadding, y: (linkSize.height - M.linkIcon) / 2, width: M.linkIcon, height: M.linkIcon)
        linkLabel = CGRect(x: linkIcon.maxX + M.linkIconGap, y: (linkSize.height - labelSize.height) / 2, width: labelSize.width, height: labelSize.height)
        y = self.link.maxY + M.buttonGap
        button = centred(CGSize(width: buttonWidth, height: buttonSize.height), y)
        contentHeight = max(size.height, button.maxY + M.marginBottom + safeArea.bottom)
    }
}
