import Foundation

/// Where a story's frame is drawn: the 1080 × 1920 canvas fitted to the
/// space, and everything on it placed by fractions of the canvas
/// (happy-agent `API.md` "Frames" and "Overlays"). The same numbers draw
/// the viewer, the editor and the inline story, at any size.
public enum StoryCanvasLayout {
    public static let aspect: CGFloat = 1080.0 / 1920.0

    /// The largest 9:16 rectangle in `bounds`, centred across, at its top
    /// when it is held by the width (a phone: Telegram's story under the
    /// status bar, its bar below), centred down when held by the height.
    public static func fit(in bounds: CGRect) -> CGRect {
        guard bounds.width > 0, bounds.height > 0 else { return .zero }
        let byWidth = CGSize(width: bounds.width, height: bounds.width / aspect)
        if byWidth.height <= bounds.height {
            return CGRect(x: bounds.minX, y: bounds.minY, width: byWidth.width, height: byWidth.height).integralSize
        }
        let width = bounds.height * aspect
        return CGRect(x: bounds.minX + (bounds.width - width) / 2, y: bounds.minY, width: width, height: bounds.height).integralSize
    }

    /// A transform's centre on a canvas of `size`.
    public static func center(_ x: Double, _ y: Double, canvas size: CGSize) -> CGPoint {
        CGPoint(x: CGFloat(x) * size.width, y: CGFloat(y) * size.height)
    }

    /// The media's unrotated box on the canvas: fitted whole at scale 1 and
    /// centred at `x`, `y`; `scale` grows it (and the canvas crops it).
    /// `pixels` nil (a video not measured yet) fills the canvas's width as a
    /// 16:9 picture would.
    public static func media(pixels: CGSize?, x: Double, y: Double, scale: Double, canvas size: CGSize) -> CGRect {
        let source = pixels.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil } ?? CGSize(width: 16, height: 9)
        let fit = min(size.width / source.width, size.height / source.height)
        let width = source.width * fit * CGFloat(scale)
        let height = source.height * fit * CGFloat(scale)
        let center = center(x, y, canvas: size)
        return CGRect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
    }

    /// Text's base font size at scale 1: 1/16 of the canvas's width.
    public static func textFontSize(canvas size: CGSize) -> CGFloat { size.width / 16 }

    /// The width text wraps at before scaling.
    public static func textWrap(_ fraction: Double, canvas size: CGSize) -> CGFloat {
        CGFloat(min(1, max(0.1, fraction))) * size.width
    }

    /// A link pill's height at scale 1: 1/12 of the canvas's width.
    public static func linkHeight(canvas size: CGSize) -> CGFloat { size.width / 12 }

    /// A sticker's or emoji's box: its longer side `scale` of the canvas's
    /// width, its shape the sticker's.
    public static func sticker(pixels: CGSize, scale: Double, canvas size: CGSize) -> CGSize {
        let longer = CGFloat(scale) * size.width
        guard pixels.width > 0, pixels.height > 0 else { return CGSize(width: longer, height: longer) }
        return pixels.width >= pixels.height
            ? CGSize(width: longer, height: longer * pixels.height / pixels.width)
            : CGSize(width: longer * pixels.width / pixels.height, height: longer)
    }

    /// A reaction bubble: `scale` of the canvas's width across, round.
    public static func reaction(scale: Double, canvas size: CGSize) -> CGSize {
        let side = CGFloat(scale) * size.width
        return CGSize(width: side, height: side)
    }

    /// The caption at the bottom of the canvas, folded to a few lines under
    /// its fade, and opened in full over the darkened frame (Telegram's
    /// story caption): the open text keeps its last line where the folded
    /// one ended and grows up to `topInset`; longer, it starts there and
    /// scrolls.
    public struct Caption: Equatable, Sendable {
        public var fade: CGRect
        /// The folded text.
        public var text: CGRect
        /// The box the caption scrolls in, its bottom just under the text.
        public var scroll: CGRect
        /// The open text, in the scroll box's content.
        public var openText: CGRect
        /// The shade an open caption rises with: from 64 above its text (or
        /// the top) to the foot, as the fold's fade.
        public var shade: CGRect
        public var content: CGSize
        /// The open text is taller than the room it has.
        public var scrolls: Bool
    }

    /// 16 in from the sides and from `bottomInset`, under a fade that
    /// begins 64 above it; the scroll box reaches 8 below the text.
    public static func caption(textHeight: CGFloat, fullHeight: CGFloat? = nil, canvas size: CGSize, bottomInset: CGFloat = 16, topInset: CGFloat = 72) -> Caption {
        let inset: CGFloat = 16
        let pad: CGFloat = 8
        let width = max(0, size.width - 2 * inset)
        let foot = size.height - bottomInset
        let text = CGRect(x: inset, y: foot - ceil(textHeight), width: width, height: ceil(textHeight))
        let fadeTop = max(0, text.minY - 64)
        let scroll = CGRect(x: 0, y: 0, width: size.width, height: min(size.height, foot + pad))
        let full = ceil(fullHeight ?? textHeight)
        let room = max(0, foot - topInset)
        let scrolls = full > room
        let openText = CGRect(x: inset, y: scrolls ? topInset : foot - full, width: width, height: full)
        let content = CGSize(width: size.width, height: scrolls ? openText.maxY + pad : scroll.height)
        return Caption(
            fade: CGRect(x: 0, y: fadeTop, width: size.width, height: size.height - fadeTop), text: text,
            scroll: scroll, openText: openText,
            shade: CGRect(x: 0, y: max(0, openText.minY - 64), width: size.width, height: size.height - max(0, openText.minY - 64)),
            content: content, scrolls: scrolls
        )
    }
}

extension CGRect {
    /// Whole points for its size, keeping its origin.
    var integralSize: CGRect {
        CGRect(x: minX, y: minY, width: width.rounded(.down), height: height.rounded(.down))
    }
}
