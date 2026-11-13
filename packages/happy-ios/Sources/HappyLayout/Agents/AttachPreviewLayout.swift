import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The "+" menu's picture opened whole, as Telegram's media picker gallery
/// (`TGMediaPickerGalleryInterfaceView`, `TGModernGalleryZoomableItemView`):
///
///     ‹                     (2)    back at the top left, the number circle
///                                  at the top right, both in the safe area
///     ┌───────────────────────┐
///     │                       │    the picture fitted to the screen on
///     │          (▶)          │    black, a video's play button centred;
///     │                       │    pages 20 apart, swiped between
///     └───────────────────────┘
public struct AttachPreviewLayout: Equatable, Sendable {
    public enum Metrics {
        /// Telegram's gallery check (`TGCheckButtonStyleGallery`) is a 39
        /// box 44 from the right and 5 down; ours is the grid's 29 circle
        /// centred where that box is.
        public static let galleryCheckBox: CGFloat = 39
        public static let galleryCheckRight: CGFloat = 44
        public static let galleryCheckTop: CGFloat = 5
        public static let check: CGFloat = LibraryPickerLayout.Metrics.check
        /// What a finger can hit around the check and the back chevron.
        public static let button: CGFloat = 44
        public static let backIcon: CGFloat = 28
        /// A top inset counts only past the status bar's 20, as Telegram's.
        public static let statusBar: CGFloat = 20
        /// A video's play button (`TGMediaPickerGalleryVideoItemView`).
        public static let play: CGFloat = 60
        public static let playIcon: CGFloat = 28
        /// Zoom reaches the screen filled, and at least three times fitted.
        public static let zoomFactor: CGFloat = 3
    }

    public var pager: PicturePagerLayout
    public var check: CGRect
    /// The check's touch area, centred on it.
    public var checkButton: CGRect
    /// The back chevron's touch area, mirroring the check's across the screen.
    public var back: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, count: Int) {
        typealias M = Metrics
        pager = PicturePagerLayout(size: size, count: count)
        let top = safeArea.top > M.statusBar ? safeArea.top : 0
        let right = size.width - safeArea.right
        let center = CGPoint(x: right - M.galleryCheckRight + M.galleryCheckBox / 2, y: top + M.galleryCheckTop + M.galleryCheckBox / 2)
        check = CGRect(x: center.x - M.check / 2, y: center.y - M.check / 2, width: M.check, height: M.check)
        checkButton = CGRect(x: center.x - M.button / 2, y: center.y - M.button / 2, width: M.button, height: M.button)
        let backCenter = safeArea.left + (right - center.x)
        back = CGRect(x: backCenter - M.button / 2, y: checkButton.minY, width: M.button, height: M.button)
    }

    // MARK: A page's picture

    /// `natural` fitted inside `bounds` and centred, enlarged as Telegram's
    /// are; the whole page before the picture's shape is known.
    public static func fit(_ natural: CGSize, in bounds: CGSize) -> CGRect {
        guard natural.width > 0, natural.height > 0, bounds.width > 0, bounds.height > 0 else { return CGRect(origin: .zero, size: bounds) }
        let size = scaled(natural, to: bounds, fill: false)
        return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }

    /// How far past fitted a picture zooms: to fill the page, and at least
    /// `zoomFactor` (`adjustZoom`).
    public static func maximumZoom(_ natural: CGSize, in bounds: CGSize) -> CGFloat {
        guard natural.width > 0, natural.height > 0, bounds.width > 0, bounds.height > 0 else { return 1 }
        let fit = min(bounds.width / natural.width, bounds.height / natural.height)
        let fill = max(bounds.width / natural.width, bounds.height / natural.height)
        return max(fill / fit, Metrics.zoomFactor)
    }

    /// Where a zoomed picture of `content` sits in a page of `bounds`:
    /// centred along a side it doesn't fill, from the edge along one it does.
    public static func zoomed(_ content: CGSize, in bounds: CGSize) -> CGRect {
        CGRect(x: max(0, (bounds.width - content.width) / 2), y: max(0, (bounds.height - content.height) / 2), width: content.width, height: content.height)
    }

    /// What a double tap at `point` (in the fitted picture) zooms to at `scale`.
    public static func zoomRect(at point: CGPoint, bounds: CGSize, scale: CGFloat) -> CGRect {
        let size = CGSize(width: bounds.width / max(scale, 0.0001), height: bounds.height / max(scale, 0.0001))
        return CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height)
    }

    /// A video's play button, centred on its picture.
    public static func play(in picture: CGRect) -> CGRect {
        CGRect(x: picture.midX - Metrics.play / 2, y: picture.midY - Metrics.play / 2, width: Metrics.play, height: Metrics.play)
    }

    // MARK: The zoom from and to the grid

    /// A picture of `natural` filling a box of `size` cut to it, as the
    /// grid's cells show theirs: the zooming picture inside its clip.
    public static func fill(_ natural: CGSize, in size: CGSize) -> CGRect {
        guard natural.width > 0, natural.height > 0 else { return CGRect(origin: .zero, size: size) }
        let filled = scaled(natural, to: size, fill: true)
        return CGRect(x: (size.width - filled.width) / 2, y: (size.height - filled.height) / 2, width: filled.width, height: filled.height)
    }

    /// `natural` scaled to fit or fill `box`, the side it meets exactly.
    private static func scaled(_ natural: CGSize, to box: CGSize, fill: Bool) -> CGSize {
        let across = box.width / natural.width <= box.height / natural.height
        return across != fill
            ? CGSize(width: box.width, height: natural.height * box.width / natural.width)
            : CGSize(width: natural.width * box.height / natural.height, height: box.height)
    }

    /// The clip that carries a picture between its cell and its page: it
    /// starts as the cell (the picture cut square, as the grid shows it) and
    /// ends as the fitted picture, or the reverse going back.
    public struct Zoom: Equatable, Sendable {
        /// The clip as the cell, and the picture in it cut as the cell cuts it.
        public var cell: CGRect
        public var cellPicture: CGRect
        /// The clip where the page shows the picture, and the picture in it.
        public var page: CGRect
        public var pagePicture: CGRect

        /// `cell` in the preview's coordinates; `page` is where the page
        /// shows the picture now (fitted, dragged or zoomed).
        public init(cell: CGRect, page: CGRect, natural: CGSize) {
            self.cell = cell
            self.page = page
            cellPicture = AttachPreviewLayout.fill(natural, in: cell.size)
            pagePicture = AttachPreviewLayout.fill(natural, in: page.size)
        }
    }
}

/// A picture dragged up or down to close, as Telegram's gallery does it
/// (`TGModernGalleryView`): it follows the finger; the black is gone within
/// a quarter of 150 and the buttons hide at once; let go past 128 or faster
/// than 700 it closes, else it goes back.
public struct AttachPreviewDismissal: Equatable, Sendable {
    public enum Metrics {
        /// Distance to a whole `progress`.
        public static let distance: CGFloat = 150
        /// The black fades four times as fast as `progress`.
        public static let fade: CGFloat = 4
        public static let closingDistance: CGFloat = 128
        public static let closingSpeed: CGFloat = 700
        /// A close goes at least this fast.
        public static let minimumSpeed: CGFloat = 600
        /// The drag starts once the finger has gone 12 up or down, and is
        /// never one after 10 to the side
        /// (`TGModernGalleryZoomableScrollViewSwipeGestureRecognizer`).
        public static let startSlop: CGFloat = 12
        public static let sideSlop: CGFloat = 10
    }

    /// 0 resting, 1 at `distance` and past.
    public var progress: CGFloat
    public var groundAlpha: CGFloat
    /// The back button and check hide as soon as it moves.
    public var chromeHidden: Bool
    public var closes: Bool
    /// The speed it goes with, when it closes: the finger's, never under
    /// `minimumSpeed`, the way it was going.
    public var velocity: CGFloat

    /// `distance` and `velocity` are the finger's, down positive.
    public init(distance: CGFloat, velocity: CGFloat) {
        typealias M = Metrics
        progress = max(0, min(1, abs(distance) / M.distance))
        groundAlpha = 1 - max(0, min(1, progress * M.fade))
        chromeHidden = progress > 0
        closes = abs(velocity) >= M.closingSpeed || abs(distance) >= M.closingDistance
        let sign: CGFloat = velocity < 0 ? -1 : 1
        self.velocity = abs(velocity) < M.minimumSpeed ? sign * M.minimumSpeed : velocity
    }

    /// With no cell to go back to: the offset it leaves to, a screen's
    /// height the way it goes (down without a velocity), and how long that
    /// takes: the zoom's time, or less for a finger faster than that.
    public static func leave(velocity: CGFloat, height: CGFloat) -> (offset: CGFloat, duration: TimeInterval) {
        let offset = velocity < 0 ? -height : height
        let fling = velocity == 0 ? AttachPreviewMotion.duration : TimeInterval(height / abs(velocity))
        return (offset, min(AttachPreviewMotion.duration, fling))
    }
}

/// How the preview comes and goes. Telegram's gallery springs
/// (`TGModernGalleryController.animateView`, stretched 1.8 and 2 times)
/// take most of a second to settle, which reads as slow; here the zoom out
/// of the cell, the zoom back into it, a let-go drag's close or return and
/// the slide with no cell all take 0.22 s on one tight ease out (Android's
/// the same). The page shows within 0.07 of the zoom in; the buttons, and
/// the black on a zoom back, go in 0.15.
public enum AttachPreviewMotion {
    public static let duration: TimeInterval = 0.22
    /// The ease out: most of the way in the first half, no overshoot.
    public static let curve: (x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat) = (0.25, 1, 0.5, 1)
    public static let pageFadeIn: TimeInterval = 0.07
    public static let fadeOut: TimeInterval = 0.15
    public static let chrome: TimeInterval = 0.2
}

/// Telegram's gallery foot: a separate Back at the left of the glass
/// tool group, the caption 10 above its 49-point row. Typing hides that
/// row. Happy fits the whole picture above the caption, as requested,
/// rather than allowing a tall image to extend underneath the controls.
public struct AttachPreviewFootLayout: Equatable, Sendable {
    public enum Metrics {
        public static let bar: CGFloat = 49
        public static let tool: CGFloat = 44
        public static let toolGap: CGFloat = 10
        /// The caption over the bar, and over the keyboard.
        public static let overBar: CGFloat = 10
        public static let overKeyboard: CGFloat = 8
        /// The caption grows to a third of what the keyboard leaves at most.
        public static let shortest: CGFloat = 44
        public static let side: CGFloat = 26
        public static let pictureInset: CGFloat = 12
    }

    /// The row through the screen's foot (transparent, on viewer black).
    public var bar: CGRect
    /// The tools side by side, centred in the bar.
    public var tools: [CGRect]
    public var card: CGRect
    public var back: CGRect
    public var group: CGRect
    /// The whole photo fits here, clear of the caption and top check.
    public var pictures: CGRect
    /// The keyboard is up for the caption: no tools, the pictures dimmed.
    public var typing: Bool

    /// The caption's width, for the height it asks at.
    public static func cardWidth(size: CGSize, safeArea: LayoutInsets, inset: CGFloat) -> CGFloat {
        max(0, size.width - safeArea.left - safeArea.right - 2 * inset)
    }

    /// `keyboard` is how much of the screen's foot it covers; `cardHeight`
    /// what the caption asks at `cardWidth`.
    public init(size: CGSize, safeArea: LayoutInsets, keyboard: CGFloat, inset: CGFloat, cardHeight: CGFloat, tools count: Int) {
        typing = keyboard > 0
        let barTop = size.height - safeArea.bottom - Metrics.bar
        bar = CGRect(x: 0, y: barTop, width: size.width, height: size.height - barTop)
        let width = CGFloat(count) * Metrics.tool + CGFloat(max(0, count - 1)) * Metrics.toolGap
        let left = (size.width - width) / 2
        let top = barTop + (Metrics.bar - Metrics.tool) / 2
        back = CGRect(x: safeArea.left + Metrics.side, y: top, width: Metrics.tool, height: Metrics.tool)
        group = CGRect(x: left, y: top, width: width, height: Metrics.tool)
        tools = (0..<count).map { CGRect(x: left + CGFloat($0) * (Metrics.tool + Metrics.toolGap), y: top, width: Metrics.tool, height: Metrics.tool) }
        let height = min(cardHeight, max(Metrics.shortest, (size.height - keyboard) / 3))
        let bottom = typing ? size.height - keyboard - Metrics.overKeyboard : barTop - Metrics.overBar
        card = CGRect(x: safeArea.left + inset, y: bottom - height, width: Self.cardWidth(size: size, safeArea: safeArea, inset: inset), height: height)
        let pictureTop = safeArea.top + Metrics.tool + Metrics.pictureInset
        pictures = CGRect(x: safeArea.left + Metrics.pictureInset, y: pictureTop,
                          width: max(0, size.width - safeArea.left - safeArea.right - 2 * Metrics.pictureInset),
                          height: max(0, card.minY - Metrics.pictureInset - pictureTop))
    }
}
