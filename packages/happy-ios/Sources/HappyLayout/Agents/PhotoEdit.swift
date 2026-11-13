import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// What the "+" menu's editor did to one photo (Telegram's
/// `TGMediaEditingContext` adjustments, cut down to crop and paint): a
/// window onto the picture, turned and flipped, and what was drawn on the
/// picture under it. Everything is in the picture's own pixels, upright,
/// so it applies the same to a thumbnail and to the whole photo.
public struct PhotoEdit: Equatable, Sendable {
    /// The picture's size in pixels, upright: what the numbers are in.
    public var canvas: CGSize
    public var crop: PhotoCrop
    /// In the order drawn; the eraser takes out what is under it.
    public var strokes: [PhotoStroke]

    public init(canvas: CGSize, crop: PhotoCrop? = nil, strokes: [PhotoStroke] = []) {
        self.canvas = canvas
        self.crop = crop ?? .whole(canvas)
        self.strokes = strokes
    }

    /// Nothing done: the picture as it was.
    public var isEmpty: Bool { crop.isWhole(canvas) && strokes.isEmpty }
}

/// One stroke of Telegram's drawing tools (`DrawingToolsComponent`).
public struct PhotoStroke: Equatable, Sendable {
    public enum Tool: String, CaseIterable, Sendable {
        case pen, arrow, marker, neon, blur, eraser
    }

    public var tool: Tool
    public var color: RGBA
    /// Across, in the picture's pixels.
    public var width: CGFloat
    /// Where the finger went, in the picture's pixels.
    public var points: [CGPoint]

    public init(tool: Tool, color: RGBA, width: CGFloat, points: [CGPoint]) {
        self.tool = tool
        self.color = color
        self.width = width
        self.points = points
    }
}

/// A fixed ratio for the crop (`TGPhotoCropController`'s aspect list),
/// width over height as the crop is shown.
public struct PhotoAspect: Equatable, Hashable, Sendable {
    public var width: CGFloat
    public var height: CGFloat

    public init(_ width: CGFloat, _ height: CGFloat) {
        self.width = width
        self.height = height
    }

    public var ratio: CGFloat { height > 0 ? width / height : 1 }
    /// The same ratio the other way round.
    public var flipped: PhotoAspect { PhotoAspect(height, width) }
    public static let square = PhotoAspect(1, 1)
}

/// The crop: a window `size` big onto the picture around `center`, turned
/// by `rotation` and flipped left to right after, the way the picture
/// comes out. The window never reaches past the picture.
public struct PhotoCrop: Equatable, Sendable {
    /// The window's middle, in the picture's pixels.
    public var center: CGPoint
    /// What comes out, in the picture's pixels, as it is shown (turned).
    public var size: CGSize
    /// The straightening wheel's angle, radians, within ±45°.
    public var angle: CGFloat
    /// Quarter turns to the left (`rotate`), 0...3.
    public var turns: Int
    public var mirrored: Bool
    /// The ratio the window keeps while its corners are dragged; nil is free.
    public var aspect: PhotoAspect?

    public static let maxAngle: CGFloat = .pi / 4

    public init(center: CGPoint, size: CGSize, angle: CGFloat = 0, turns: Int = 0, mirrored: Bool = false, aspect: PhotoAspect? = nil) {
        self.center = center
        self.size = size
        self.angle = angle
        self.turns = ((turns % 4) + 4) % 4
        self.mirrored = mirrored
        self.aspect = aspect
    }

    /// The whole picture, as it is.
    public static func whole(_ canvas: CGSize) -> PhotoCrop {
        PhotoCrop(center: CGPoint(x: canvas.width / 2, y: canvas.height / 2), size: canvas)
    }

    public func isWhole(_ canvas: CGSize) -> Bool {
        let whole = PhotoCrop.whole(canvas)
        return turns == 0 && !mirrored && abs(angle) < 0.0001
            && abs(center.x - whole.center.x) < 0.5 && abs(center.y - whole.center.y) < 0.5
            && abs(size.width - canvas.width) < 0.5 && abs(size.height - canvas.height) < 0.5
    }

    /// The picture's turn as it comes out: the wheel's, less the quarter
    /// turns to the left.
    public var rotation: CGFloat { angle - CGFloat(turns) * .pi / 2 }

    /// The picture's pixels into what comes out (its top left at 0, 0).
    public var transform: CGAffineTransform {
        CGAffineTransform(translationX: -center.x, y: -center.y)
            .concatenating(CGAffineTransform(rotationAngle: rotation))
            .concatenating(CGAffineTransform(scaleX: mirrored ? -1 : 1, y: 1))
            .concatenating(CGAffineTransform(translationX: size.width / 2, y: size.height / 2))
    }

    /// Half the window's extent across the picture's own axes.
    public var halfExtent: CGSize {
        let c = abs(cos(rotation)), s = abs(sin(rotation))
        return CGSize(width: (size.width * c + size.height * s) / 2, height: (size.width * s + size.height * c) / 2)
    }

    /// The window's corners on the picture.
    public var corners: [CGPoint] {
        let inverse = transform.inverted()
        return [CGPoint(x: 0, y: 0), CGPoint(x: size.width, y: 0), CGPoint(x: size.width, y: size.height), CGPoint(x: 0, y: size.height)]
            .map { $0.applying(inverse) }
    }

    /// The window lies on the picture, within half a pixel.
    public func fits(_ canvas: CGSize) -> Bool {
        let half = halfExtent
        return center.x - half.width >= -0.5 && center.x + half.width <= canvas.width + 0.5
            && center.y - half.height >= -0.5 && center.y + half.height <= canvas.height + 0.5
    }

    /// The window made to lie on the picture: no bigger than it can be at
    /// its turn (the picture zooming in, as Telegram's does while the wheel
    /// turns), then moved as little as it takes.
    public func fitted(_ canvas: CGSize) -> PhotoCrop {
        var crop = self
        let half = crop.halfExtent
        let scale = min(1, half.width > 0 ? canvas.width / 2 / half.width : 1, half.height > 0 ? canvas.height / 2 / half.height : 1)
        crop.size = CGSize(width: size.width * scale, height: size.height * scale)
        return crop.clamped(canvas)
    }

    /// Moved as little as it takes to lie on the picture; its size as is.
    public func clamped(_ canvas: CGSize) -> PhotoCrop {
        var crop = self
        let half = crop.halfExtent
        crop.center.x = half.width * 2 >= canvas.width ? canvas.width / 2 : min(max(center.x, half.width), canvas.width - half.width)
        crop.center.y = half.height * 2 >= canvas.height ? canvas.height / 2 : min(max(center.y, half.height), canvas.height - half.height)
        return crop
    }

    /// As far from `self` toward `target` as the picture allows (center and
    /// size together), `self` lying on it already.
    public func toward(_ target: PhotoCrop, in canvas: CGSize) -> PhotoCrop {
        if target.fits(canvas) { return target }
        var low: CGFloat = 0, high: CGFloat = 1
        for _ in 0..<24 {
            let mid = (low + high) / 2
            if interpolated(target, mid).fits(canvas) { low = mid } else { high = mid }
        }
        return interpolated(target, low)
    }

    func interpolated(_ target: PhotoCrop, _ t: CGFloat) -> PhotoCrop {
        var crop = target
        crop.center = CGPoint(x: center.x + (target.center.x - center.x) * t, y: center.y + (target.center.y - center.y) * t)
        crop.size = CGSize(width: size.width + (target.size.width - size.width) * t, height: size.height + (target.size.height - size.height) * t)
        return crop
    }

    /// Turned a quarter to the left: the same window, its sides swapped.
    public func rotatedLeft() -> PhotoCrop {
        var crop = self
        crop.turns = (turns + 1) % 4
        crop.size = CGSize(width: size.height, height: size.width)
        crop.aspect = aspect?.flipped
        return crop
    }

    /// The largest window of `aspect` on the picture at this turn, about
    /// the same middle; nil frees it, keeping the window.
    public func with(aspect: PhotoAspect?, in canvas: CGSize) -> PhotoCrop {
        var crop = self
        crop.aspect = aspect
        guard let aspect else { return crop }
        let big = max(canvas.width, canvas.height) * 4
        crop.size = aspect.ratio >= 1 ? CGSize(width: big, height: big / aspect.ratio) : CGSize(width: big * aspect.ratio, height: big)
        return crop.fitted(canvas)
    }

    /// The wheel at `angle`, the window zoomed in as far as it must to stay
    /// on the picture.
    public func straightened(_ angle: CGFloat, in canvas: CGSize) -> PhotoCrop {
        var crop = self
        crop.angle = min(max(angle, -Self.maxAngle), Self.maxAngle)
        return crop.fitted(canvas)
    }

    /// The window's on-screen frame `frame` moved to `moved` (a corner or
    /// side dragged, the screen showing `scale` points to a pixel), as far
    /// as the picture allows and no smaller than `minimum` pixels a side.
    public func resized(from frame: CGRect, to moved: CGRect, scale: CGFloat, minimum: CGFloat, in canvas: CGSize) -> PhotoCrop {
        guard scale > 0, frame.width > 0, frame.height > 0 else { return self }
        var target = self
        target.size = CGSize(width: max(minimum, moved.width / scale), height: max(minimum, moved.height / scale))
        // The middle moves with the frame's, in the picture's turned axes.
        let shift = CGPoint(x: (moved.midX - frame.midX) / scale * (mirrored ? -1 : 1), y: (moved.midY - frame.midY) / scale)
        let back = CGAffineTransform(rotationAngle: -rotation)
        let delta = shift.applying(back)
        target.center = CGPoint(x: center.x + delta.x, y: center.y + delta.y)
        return toward(target, in: canvas)
    }

    /// The picture moved `by` on the screen (`scale` points to a pixel):
    /// the window goes the other way over it, as far as it can.
    public func panned(by translation: CGPoint, scale: CGFloat, in canvas: CGSize) -> PhotoCrop {
        guard scale > 0 else { return self }
        let shift = CGPoint(x: -translation.x / scale * (mirrored ? -1 : 1), y: -translation.y / scale)
        let delta = shift.applying(CGAffineTransform(rotationAngle: -rotation))
        var target = self
        target.center = CGPoint(x: center.x + delta.x, y: center.y + delta.y)
        return target.clamped(canvas)
    }

    /// Pinched by `factor` (over 1 zooms in): the window shrinks or grows,
    /// no smaller than `minimum` pixels a side and no bigger than fits.
    public func zoomed(by factor: CGFloat, minimum: CGFloat, in canvas: CGSize) -> PhotoCrop {
        guard factor > 0 else { return self }
        var target = self
        var scale = 1 / factor
        let shortest = min(size.width, size.height)
        if shortest * scale < minimum { scale = minimum / max(shortest, 0.0001) }
        target.size = CGSize(width: size.width * scale, height: size.height * scale)
        return target.fitted(canvas)
    }
}

/// The aspect choices, in Telegram's order (`TGPhotoCropController`'s
/// sheet: Original, Square, then the ratios), each turned to the crop's
/// own way round: wider than tall when it is.
public enum PhotoAspects {
    public static let ratios: [PhotoAspect] = [
        PhotoAspect(3, 2), PhotoAspect(5, 3), PhotoAspect(4, 3), PhotoAspect(5, 4), PhotoAspect(7, 5), PhotoAspect(16, 9),
    ]

    /// `ratio` the way round `size` is.
    public static func oriented(_ ratio: PhotoAspect, like size: CGSize) -> PhotoAspect {
        (size.width >= size.height) == (ratio.width >= ratio.height) ? ratio : ratio.flipped
    }
}
