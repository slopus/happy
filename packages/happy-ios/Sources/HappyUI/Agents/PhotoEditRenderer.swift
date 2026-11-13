#if canImport(UIKit)
import CoreImage
import HappyLayout
import UIKit

/// Draws a `PhotoEdit` the way Telegram's editor does (`PenTool`,
/// `MarkerTool`, `NeonTool`, the blur and eraser pens): the picture under
/// its crop, the strokes over it in one layer the eraser cuts into.
/// Everything is drawn in the picture's own pixels and placed by the crop,
/// so a thumbnail and the whole photo come out the same.
enum PhotoEditRenderer {
    /// Telegram's widths for a brush's 0...1 size on a picture
    /// `canvas` big (`PenTool`, `NeonTool`: 0.2% to 7% of its longer side;
    /// `MarkerTool`: 1% to 9%).
    static func width(_ size: CGFloat, tool: PhotoStroke.Tool, canvas: CGSize) -> CGFloat {
        let longer = max(canvas.width, canvas.height)
        let (low, high) = tool == .marker
            ? (max(10, longer * 0.01), max(20, longer * 0.09))
            : (max(1, longer * 0.002), max(10, longer * 0.07))
        return low + (high - low) * min(max(size, 0), 1)
    }

    /// `image` (any size, the picture `edit.canvas` big) edited, at most
    /// `maxPixels` on its longer side.
    static func render(_ image: UIImage, _ edit: PhotoEdit, maxPixels: CGFloat = .greatestFiniteMagnitude, blurred: UIImage? = nil) -> UIImage {
        guard !edit.isEmpty, edit.canvas.width > 0 else { return image }
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        var factor = pixels.width / edit.canvas.width
        let out = edit.crop.size
        factor = min(factor, maxPixels / max(out.width, out.height, 1))
        let size = CGSize(width: max(1, (out.width * factor).rounded()), height: max(1, (out.height * factor).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            UIColor.black.setFill()
            cg.fill(CGRect(origin: .zero, size: size))
            cg.concatenate(placement(edit.crop, factor: CGSize(width: size.width / out.width, height: size.height / out.height)))
            image.draw(in: CGRect(origin: .zero, size: edit.canvas))
            guard !edit.strokes.isEmpty else { return }
            let layer = drawing(edit.strokes, canvas: edit.canvas, crop: edit.crop, size: size, picture: image, blurred: blurred)
            cg.concatenate(placement(edit.crop, factor: CGSize(width: size.width / out.width, height: size.height / out.height)).inverted())
            layer.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// The picture's pixels into an output `factor` times the crop's size.
    static func placement(_ crop: PhotoCrop, factor: CGSize) -> CGAffineTransform {
        crop.transform.concatenating(CGAffineTransform(scaleX: factor.width, y: factor.height))
    }

    /// The strokes alone, on clear, `size` big over the crop: what the
    /// eraser cuts into, the blur pen drawing the picture blurred. `base`,
    /// strokes already drawn this size, goes under them.
    static func drawing(_ strokes: [PhotoStroke], canvas: CGSize, crop: PhotoCrop, size: CGSize, picture: UIImage?, blurred: UIImage?, active: PhotoStroke? = nil, base: UIImage? = nil) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let factor = CGSize(width: size.width / max(crop.size.width, 1), height: size.height / max(crop.size.height, 1))
        let all = strokes + (active.map { [$0] } ?? [])
        let needsBlur = all.contains { $0.tool == .blur }
        let blur = needsBlur ? (blurred ?? picture.flatMap { Self.blurred($0) }) : nil
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            base?.draw(in: CGRect(origin: .zero, size: size))
            cg.concatenate(placement(crop, factor: factor))
            for stroke in all { draw(stroke, in: cg, canvas: canvas, blurred: blur) }
        }
    }

    /// One stroke into `cg`, already in the picture's pixels.
    static func draw(_ stroke: PhotoStroke, in cg: CGContext, canvas: CGSize, blurred: UIImage?) {
        guard let first = stroke.points.first else { return }
        let path = smoothed(stroke.points)
        let color = UIColor(red: stroke.color.red, green: stroke.color.green, blue: stroke.color.blue, alpha: stroke.color.alpha)
        cg.saveGState()
        defer { cg.restoreGState() }
        cg.setLineCap(.round)
        cg.setLineJoin(.round)
        let width = stroke.width
        switch stroke.tool {
        case .pen, .arrow:
            cg.setStrokeColor(color.withAlphaComponent(1).cgColor)
            cg.setFillColor(color.withAlphaComponent(1).cgColor)
            dot(or: path, first, width, in: cg, points: stroke.points.count)
            if stroke.tool == .arrow, let head = arrowHead(stroke.points, width: width, canvas: canvas) {
                cg.setLineWidth(head.width)
                cg.addPath(head.path)
                cg.strokePath()
            }
        case .marker:
            // Telegram's felt marker: a soft, see-through stroke.
            cg.setAlpha(0.6)
            cg.beginTransparencyLayer(auxiliaryInfo: nil)
            cg.setStrokeColor(color.withAlphaComponent(1).cgColor)
            cg.setFillColor(color.withAlphaComponent(1).cgColor)
            dot(or: path, first, width, in: cg, points: stroke.points.count)
            cg.endTransparencyLayer()
        case .neon:
            // `NeonTool`: a white core half the width in a glow of the colour,
            // edged in white mixed a quarter with it.
            var glow = color.withAlphaComponent(1)
            var core = UIColor.white
            if stroke.color.red + stroke.color.green + stroke.color.blue < 0.03 {
                core = glow
                glow = UIColor(red: 0x44 / 255, green: 0x08 / 255, blue: 0x81 / 255, alpha: 1)
            }
            let radius = min(canvas.width, canvas.height) * 0.02
            cg.saveGState()
            cg.setShadow(offset: .zero, blur: radius * 2, color: glow.cgColor)
            cg.setStrokeColor(core.cgColor)
            cg.setFillColor(core.cgColor)
            dot(or: path, first, width * 0.5, in: cg, points: stroke.points.count)
            cg.restoreGState()
            cg.setStrokeColor(mix(core, glow, 0.25).cgColor)
            cg.setFillColor(mix(core, glow, 0.25).cgColor)
            dot(or: path, first, width, in: cg, points: stroke.points.count)
            cg.setStrokeColor(core.cgColor)
            cg.setFillColor(core.cgColor)
            dot(or: path, first, width * 0.5, in: cg, points: stroke.points.count)
        case .blur:
            guard let blurred else { return }
            cg.addPath(path.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 0))
            if stroke.points.count == 1 { cg.addEllipse(in: CGRect(x: first.x - width / 2, y: first.y - width / 2, width: width, height: width)) }
            cg.clip()
            blurred.draw(in: CGRect(origin: .zero, size: canvas))
        case .eraser:
            cg.setBlendMode(.clear)
            cg.setStrokeColor(UIColor.black.cgColor)
            cg.setFillColor(UIColor.black.cgColor)
            dot(or: path, first, width, in: cg, points: stroke.points.count)
        }
    }

    /// A tap leaves a dot; anything longer, the line.
    private static func dot(or path: CGPath, _ first: CGPoint, _ width: CGFloat, in cg: CGContext, points: Int) {
        if points == 1 {
            cg.fillEllipse(in: CGRect(x: first.x - width / 2, y: first.y - width / 2, width: width, height: width))
            return
        }
        cg.setLineWidth(width)
        cg.addPath(path)
        cg.strokePath()
    }

    private static func mix(_ a: UIColor, _ b: UIColor, _ t: CGFloat) -> UIColor {
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t, alpha: a1 + (a2 - a1) * t)
    }

    /// The finger's points as one smooth line: through the midpoints, each
    /// point the curve's control (`DrawingUtils`' smoothing).
    static func smoothed(_ points: [CGPoint]) -> CGPath {
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        path.move(to: first)
        guard points.count > 2 else {
            if points.count == 2 { path.addLine(to: points[1]) }
            return path
        }
        for index in 1..<(points.count - 1) {
            let point = points[index], next = points[index + 1]
            path.addQuadCurve(to: CGPoint(x: (point.x + next.x) / 2, y: (point.y + next.y) / 2), control: point)
        }
        path.addLine(to: points[points.count - 1])
        return path
    }

    /// `PenTool`'s arrow: two lines back from the end, 0.45 either side of
    /// the way it came, `max(2% of the longer side, 3 widths)` long and
    /// `max(1.8 × the thinnest, 0.75 widths)` wide.
    static func arrowHead(_ points: [CGPoint], width: CGFloat, canvas: CGSize) -> (path: CGPath, width: CGFloat)? {
        guard let tip = points.last, points.count > 1 else { return nil }
        let longer = max(canvas.width, canvas.height)
        let length = max(max(10, longer * 0.02), width * 3)
        // The way it came: from far enough back that a wobble at the end doesn't turn it.
        var from = points[0]
        for point in points.reversed().dropFirst() where hypot(tip.x - point.x, tip.y - point.y) >= length * 0.5 {
            from = point
            break
        }
        guard hypot(tip.x - from.x, tip.y - from.y) > 0.5 else { return nil }
        let back = atan2(from.y - tip.y, from.x - tip.x)
        let path = CGMutablePath()
        for side in [-0.45, 0.45] as [CGFloat] {
            path.move(to: tip)
            path.addLine(to: CGPoint(x: tip.x + cos(back + side) * length, y: tip.y + sin(back + side) * length))
        }
        let thinnest = max(1, longer * 0.002)
        return (path, max(thinnest * 1.8, width * 0.75))
    }

    /// Telegram's blur pen's picture: the photo shrunk to 256 on its longer
    /// side and blurred hard, then drawn back up.
    static func blurred(_ image: UIImage) -> UIImage? {
        let small = AttachPreviewLayout.fit(image.size, in: CGSize(width: 256, height: 256)).size
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let shrunk = UIGraphicsImageRenderer(size: CGSize(width: max(1, small.width.rounded()), height: max(1, small.height.rounded())), format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: CGSize(width: max(1, small.width.rounded()), height: max(1, small.height.rounded()))))
        }
        guard let input = CIImage(image: shrunk) else { return nil }
        let blurred = input.clampedToExtent().applyingGaussianBlur(sigma: 8).cropped(to: input.extent)
        guard let cg = CIContext(options: [.useSoftwareRenderer: false]).createCGImage(blurred, from: input.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
#endif
