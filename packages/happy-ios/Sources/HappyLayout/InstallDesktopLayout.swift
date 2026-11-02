import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The screen after the first one's Start (InstallDesktopViewController,
/// Android's InstallDesktopScreen), laid out as the first screen is so the
/// two read as one: the art in the slides' square at the slides' place,
/// Scan QR code where Start was (centred, as wide as its label, at least
/// 200, 48 above the bottom inset), and the words where the slides' words
/// and dots were, in a slide's type:
///
///     TV scene                       the slides' art square and place
///     24 (16 in a short window)
///     Open Happy on your computer
///     8
///     what to choose there, and where
///     4
///     Download from happy.engineering   the site, a 40 tall target
///
/// It is the first screen's `StartLayout` with these words in place of the
/// slides'; when they need more room than the slides and dots had, the
/// whole is centred again as the first screen centres its slides, and
/// taller than the window it scrolls with 16 kept above and below.
public struct InstallDesktopLayout: Equatable, Sendable {
    public enum Metrics {
        public static let titleGap: CGFloat = StartLayout.Metrics.titleGap
        public static let linkGap: CGFloat = 4
        public static let margin: CGFloat = StartLayout.Metrics.galleryMargin
        public static let bottomPadding: CGFloat = StartLayout.Metrics.bottomPadding
        /// The site's target, as a text action's (`TextActionLayout`).
        public static let linkMinHeight: CGFloat = TextActionLayout.Metrics.minHeight
        public static let linkPadding: CGFloat = TextActionLayout.Metrics.paddingHorizontal
    }

    public var art: CGRect
    public var title: CGRect
    /// The site's target, and in it its label.
    public var link: CGRect
    public var linkLabel: CGRect
    public var description: CGRect
    public var button: CGRect
    /// The scrolled content's height: the window's while it fits.
    public var contentHeight: CGFloat

    /// `start` is the first screen's layout for this window, with its safe
    /// area (`safeArea`, without this screen's bar: the bar sits over the
    /// first screen's top row). `button` is Scan QR code's own size.
    public init(size: CGSize, safeArea: LayoutInsets, start: StartLayout, title: Measurable, link: Measurable, description: Measurable, button buttonSize: CGSize) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let viewport = max(0, size.height - safeArea.vertical)
        // The slides' column.
        let textWidth = min(StartLayout.Metrics.columnMaxWidth, max(0, width - StartLayout.Metrics.sidePadding * 2))
        let titleSize = title.size(fitting: textWidth)
        let labelSize = link.size(fitting: max(0, textWidth - M.linkPadding * 2))
        let linkSize = CGSize(width: M.linkPadding * 2 + labelSize.width, height: max(M.linkMinHeight, labelSize.height))
        let descriptionSize = description.size(fitting: textWidth)
        let buttonWidth = min(textWidth, max(StartLayout.Metrics.buttonMinWidth, buttonSize.width))

        // The first screen's slides and dots, or these words if they need more.
        let side = start.art.height
        let words = titleSize.height + M.titleGap + descriptionSize.height + M.linkGap + linkSize.height
        let stage = max(start.gallery.height, side + start.artGap + words)
        let top = StartLayout.Metrics.controlsPadding + StartLayout.Metrics.control
        let height = max(viewport, top + M.margin * 2 + stage + buttonSize.height + M.bottomPadding)
        let buttonY = safeArea.top + height - M.bottomPadding - buttonSize.height
        func centred(_ size: CGSize, _ y: CGFloat) -> CGRect {
            CGRect(x: safeArea.left + (width - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        button = centred(CGSize(width: buttonWidth, height: buttonSize.height), buttonY)
        let free = max(0, buttonY - safeArea.top - top - stage)
        art = centred(CGSize(width: side, height: side), safeArea.top + top + free / 2)
        var y = art.maxY + start.artGap
        self.title = centred(titleSize, y)
        y = self.title.maxY + M.titleGap
        self.description = centred(descriptionSize, y)
        y = self.description.maxY + M.linkGap
        self.link = centred(linkSize, y)
        linkLabel = CGRect(x: M.linkPadding, y: (linkSize.height - labelSize.height) / 2, width: labelSize.width, height: labelSize.height)
        contentHeight = safeArea.top + height + safeArea.bottom
    }
}
