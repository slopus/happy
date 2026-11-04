#if canImport(UIKit)
import HappyLayout
import UIKit

/// Lucide's line icons that happy-app's fonts don't have, drawn as strokes
/// on Lucide's 24 grid: `zap` (a direct connection) and `monitor`.
enum LineIcon {
    case zap
    case monitor

    /// The outline on the 24 grid.
    var path: UIBezierPath {
        let path = UIBezierPath()
        func line(_ points: [(CGFloat, CGFloat)]) {
            path.move(to: CGPoint(x: points[0].0, y: points[0].1))
            for point in points.dropFirst() { path.addLine(to: CGPoint(x: point.0, y: point.1)) }
        }
        func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, radius: CGFloat) {
            path.append(UIBezierPath(roundedRect: CGRect(x: x, y: y, width: width, height: height), cornerRadius: radius))
        }
        switch self {
        case .zap:
            line([(13, 2), (3, 14), (12, 14), (11, 22), (21, 10), (12, 10)])
            path.close()
        case .monitor:
            rect(2, 3, 20, 14, radius: 2)
            line([(8, 21), (16, 21)])
            line([(12, 17), (12, 21)])
        }
        return path
    }
}

/// A `LineIcon` stroked in `tint`, scaled from the 24 grid to fill the
/// view's square. `weight` is the stroke on the 24 grid: 1.5 at 28 points
/// matches the weight of happy-app's outline glyphs beside it.
final class LineIconView: UIView {
    var icon: LineIcon {
        didSet { setNeedsLayout() }
    }

    var tint: ColorToken {
        didSet { applyColor() }
    }

    var weight: CGFloat = 1.5 {
        didSet { setNeedsLayout() }
    }

    private let shape = CAShapeLayer()

    init(_ icon: LineIcon, tint: ColorToken) {
        self.icon = icon
        self.tint = tint
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        shape.fillColor = nil
        shape.lineCap = .round
        shape.lineJoin = .round
        layer.addSublayer(shape)
        applyColor()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColor() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = min(bounds.width, bounds.height) / 24
        let path = icon.path
        path.apply(CGAffineTransform(scaleX: scale, y: scale))
        shape.frame = bounds
        shape.path = path.cgPath
        shape.lineWidth = weight * scale
    }

    private func applyColor() {
        shape.strokeColor = UIColor(tint).resolvedColor(with: traitCollection).cgColor
    }
}
#endif
