#if canImport(UIKit)
import HappyLayout
import UIKit

/// A live path over the flattened ink, as Telegram's Pen/Neon tools keep
/// a temporary shape layer above their committed image. Rasterizing the
/// whole canvas belongs to commit, not every finger movement.
final class PhotoLiveStrokeView: UIView {
    private let glow = CAShapeLayer()
    private let body = CAShapeLayer()
    private let core = CAShapeLayer()
    private let arrow = CAShapeLayer()
    private let blurImage = UIImageView()
    private let blurMask = CAShapeLayer()
    private var blurCrop: PhotoCrop?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isHidden = true
        for shape in [glow, body, core, arrow, blurMask] {
            shape.fillColor = nil
            shape.lineCap = .round
            shape.lineJoin = .round
        }
        addSubview(blurImage)
        blurImage.layer.mask = blurMask
        for shape in [glow, body, core, arrow] { layer.addSublayer(shape) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ stroke: PhotoStroke, canvas: CGSize, crop: PhotoCrop, blurred: UIImage?) {
        let factor = bounds.width / max(crop.size.width, 1)
        var transform = PhotoEditRenderer.placement(crop, factor: CGSize(width: factor, height: factor))
        var points = stroke.points
        // A round cap on a tiny segment gives a tap the same dot as the
        // exported raster, including the blur mask.
        if points.count == 1, let first = points.first { points.append(CGPoint(x: first.x + 0.001, y: first.y)) }
        let path = PhotoEditRenderer.smoothed(points).copy(using: &transform)
        let width = stroke.width * factor
        let color = UIColor(stroke.color).withAlphaComponent(1)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        isHidden = false
        for shape in [glow, body, core, arrow] { shape.isHidden = true }
        blurImage.isHidden = stroke.tool != .blur
        if stroke.tool == .blur {
            if blurCrop != crop || blurImage.image == nil, let blurred {
                blurImage.image = PhotoEditRenderer.render(blurred, PhotoEdit(canvas: canvas, crop: crop))
                blurCrop = crop
            }
            blurImage.frame = bounds
            blurMask.path = path
            blurMask.strokeColor = UIColor.white.cgColor
            blurMask.lineWidth = width
            return
        }
        body.isHidden = false
        body.path = path
        body.strokeColor = color.cgColor
        body.lineWidth = width
        body.opacity = stroke.tool == .marker ? 0.6 : 1
        if stroke.tool == .neon {
            let black = stroke.color.red + stroke.color.green + stroke.color.blue < 0.03
            let white = black ? color : UIColor.white
            let tint = black ? UIColor(red: 0x44 / 255, green: 0x08 / 255, blue: 0x81 / 255, alpha: 1) : color
            body.strokeColor = UIColor(red: (black ? 0 : 0.75) + stroke.color.red * 0.25,
                                       green: (black ? 0 : 0.75) + stroke.color.green * 0.25,
                                       blue: (black ? 0 : 0.75) + stroke.color.blue * 0.25, alpha: 1).cgColor
            for shape in [glow, core] {
                shape.isHidden = false
                shape.path = path
                shape.strokeColor = white.cgColor
                shape.lineWidth = width * 0.5
            }
            glow.shadowColor = tint.cgColor
            glow.shadowOpacity = 1
            glow.shadowOffset = .zero
            glow.shadowRadius = min(canvas.width, canvas.height) * 0.02 * factor
            glow.shadowPath = path?.copy(strokingWithWidth: width * 0.5, lineCap: .round, lineJoin: .round, miterLimit: 0)
        } else if stroke.tool == .arrow, let head = PhotoEditRenderer.arrowHead(stroke.points, width: stroke.width, canvas: canvas) {
            arrow.isHidden = false
            arrow.path = head.path.copy(using: &transform)
            arrow.strokeColor = color.cgColor
            arrow.lineWidth = head.width * factor
        }
    }
}
#endif