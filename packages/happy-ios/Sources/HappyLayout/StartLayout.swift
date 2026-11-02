import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The first screen, as Android's (ui/start/StartScreen.kt): the gradient
/// fills the window; ⋯ is at the top right and the logotype, small, is
/// centred on the same row; Start is centred across, as wide as its label
/// (at least 200), 48 above the bottom inset; the slides and their dots
/// are centred in the space between.
///
/// The slides are happy-desktop's welcome deck (WelcomeDeck.tsx): the art
/// in a fixed square, then the title and its line. Every slide's words get
/// the room of the tallest, so neither the titles nor the dots move as the
/// slides change. When it all outgrows the window (large text, a phone on
/// its side) nothing is free and it scrolls.
public struct StartLayout: Equatable, Sendable {
    public enum Metrics {
        /// logotype-*.png is 1200 × 319.
        public static let logoWidth: CGFloat = 88
        public static let logoAspect: CGFloat = 1200.0 / 319.0
        public static let buttonMinWidth: CGFloat = 200
        public static let bottomPadding: CGFloat = 48
        public static let controlsPadding: CGFloat = 4
        public static let control: CGFloat = 48

        /// The art's square: a phone's, a tablet's, and a short window's.
        public static let art: CGFloat = 96
        public static let artRegular: CGFloat = 128
        public static let artCompact: CGFloat = 56
        /// The Happy mark fills this much of the square.
        public static let artFill: CGFloat = 0.8
        public static let artGap: CGFloat = 24
        public static let artGapCompact: CGFloat = 16
        public static let titleGap: CGFloat = 8
        public static let dotsGap: CGFloat = 24
        public static let dotsGapCompact: CGFloat = 12
        /// Kept clear above and below the slides when it scrolls.
        public static let galleryMargin: CGFloat = 16
        /// The words' column: 24 in from the safe area, at most 440.
        public static let sidePadding: CGFloat = 24
        public static let columnMaxWidth: CGFloat = 440
        /// Below this much height (a phone on its side) the art shrinks.
        public static let compactHeight: CGFloat = 600
        /// From this width and height (a tablet) the art grows.
        public static let regularWidth: CGFloat = 600
        public static let regularHeight: CGFloat = 700
    }

    /// One slide's words, measured at the column's width.
    public struct Slide {
        public var title: Measurable
        public var body: Measurable

        public init(title: Measurable, body: Measurable) {
            self.title = title
            self.body = body
        }
    }

    public var logo: CGRect
    public var button: CGRect
    public var more: CGRect
    /// The slides and their dots, in the scrolled content.
    public var gallery: CGRect
    /// In `gallery`: the pages, side by side in a pager this big.
    public var pager: CGRect
    /// In `gallery`: the dots, centred under the pager.
    public var dots: CGRect
    /// In a page: the art's square (a scene fills it) and the Happy mark
    /// in it.
    public var art: CGRect
    public var mark: CGRect
    /// In a page: each slide's title and line.
    public var titles: [CGRect]
    public var bodies: [CGRect]
    /// The scrolled content's height, the safe area's when it all fits.
    public var contentHeight: CGFloat

    /// `button` is Start's own size, as wide as its label; it is widened
    /// to the minimum and kept inside the safe area. `dots` is the page
    /// control's own size for the slides.
    public init(size: CGSize, safeArea: LayoutInsets, button buttonSize: CGSize, slides: [Slide] = [], dots dotsSize: CGSize = .zero) {
        typealias M = Metrics
        let left = safeArea.left, width = max(0, size.width - safeArea.left - safeArea.right)
        let viewport = max(0, size.height - safeArea.top - safeArea.bottom)
        let compact = viewport < M.compactHeight
        let regular = !compact && width >= M.regularWidth && viewport >= M.regularHeight
        let side = regular ? M.artRegular : compact ? M.artCompact : M.art
        let artGap = compact ? M.artGapCompact : M.artGap
        let dotsGap = compact ? M.dotsGapCompact : M.dotsGap

        // The words: every slide's title with its line under it, as tall
        // as the tallest slide's.
        let column = min(M.columnMaxWidth, max(0, width - M.sidePadding * 2))
        let measured = slides.map { (title: $0.title.height(fitting: column), body: $0.body.height(fitting: column)) }
        let words = measured.map { $0.title + M.titleGap + $0.body }.max() ?? 0
        let pagerHeight = side + artGap + words
        let dotsWidth = min(width, dotsSize.width)
        let galleryHeight = pagerHeight + dotsGap + dotsSize.height

        // Under ⋯'s row, over Start.
        let top = M.controlsPadding + M.control
        let buttonWidth = min(width, max(M.buttonMinWidth, buttonSize.width))
        let fixed = top + M.galleryMargin * 2 + galleryHeight + buttonSize.height + M.bottomPadding
        let height = max(viewport, fixed)
        let buttonY = safeArea.top + height - M.bottomPadding - buttonSize.height
        button = CGRect(x: left + (width - buttonWidth) / 2, y: buttonY, width: buttonWidth, height: buttonSize.height)
        let free = max(0, buttonY - safeArea.top - top - galleryHeight)
        gallery = CGRect(x: left, y: safeArea.top + top + free / 2, width: width, height: galleryHeight)
        pager = CGRect(x: 0, y: 0, width: width, height: pagerHeight)
        dots = CGRect(x: (width - dotsWidth) / 2, y: pagerHeight + dotsGap, width: dotsWidth, height: dotsSize.height)

        art = CGRect(x: (width - side) / 2, y: 0, width: side, height: side)
        let markSide = side * M.artFill
        mark = CGRect(x: art.midX - markSide / 2, y: art.midY - markSide / 2, width: markSide, height: markSide)
        let columnX = (width - column) / 2
        let titleY = side + artGap
        titles = measured.map { CGRect(x: columnX, y: titleY, width: column, height: $0.title) }
        bodies = measured.map { CGRect(x: columnX, y: titleY + $0.title + M.titleGap, width: column, height: $0.body) }

        let logoSize = CGSize(width: M.logoWidth, height: M.logoWidth / M.logoAspect)
        logo = CGRect(
            x: left + (width - logoSize.width) / 2,
            y: safeArea.top + M.controlsPadding + (M.control - logoSize.height) / 2,
            width: logoSize.width, height: logoSize.height
        )
        more = CGRect(
            x: size.width - safeArea.right - M.controlsPadding - M.control,
            y: safeArea.top + M.controlsPadding,
            width: M.control, height: M.control
        )
        contentHeight = height
    }

    /// Page `index`'s frame in the pager's content.
    public func page(_ index: Int) -> CGRect {
        CGRect(x: CGFloat(index) * pager.width, y: 0, width: pager.width, height: pager.height)
    }

    /// The pager's content for `count` pages.
    public func pagerContent(count: Int) -> CGSize {
        CGSize(width: CGFloat(count) * pager.width, height: pager.height)
    }

    /// Which of `count` pages is showing when the pager is scrolled to
    /// `offset`: the one covering most of it.
    public func pageShowing(offset: CGFloat, count: Int) -> Int {
        guard count > 0, pager.width > 0 else { return 0 }
        return min(count - 1, max(0, Int((offset / pager.width).rounded())))
    }
}
