#if canImport(UIKit)
import HappyLayout
import UIKit

/// Lucide's line icons that happy-app's fonts don't have, drawn as strokes
/// on Lucide's 24 grid: `zap` (a direct connection), `monitor`,
/// `smartphone`, `cloud`, `database` and `router`.
enum LineIcon {
    case zap
    case monitor
    case smartphone
    case cloud
    case database
    case router

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
        case .smartphone:
            rect(5, 2, 14, 20, radius: 2)
            line([(12, 18), (12.01, 18)])
        case .cloud:
            path.move(to: CGPoint(x: 17.5, y: 19))
            path.addLine(to: CGPoint(x: 9, y: 19))
            path.addArc(withCenter: CGPoint(x: 9, y: 12), radius: 7, startAngle: .pi / 2, endAngle: -16.6 * .pi / 180, clockwise: true)
            path.addLine(to: CGPoint(x: 17.5, y: 10))
            path.addArc(withCenter: CGPoint(x: 17.5, y: 14.5), radius: 4.5, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: true)
            path.close()
        case .database:
            // Three stacked ellipses, 9 by 3, joined at the sides.
            func lowerHalf(_ y: CGFloat) -> UIBezierPath {
                let half = CGMutablePath()
                half.addArc(center: .zero, radius: 1, startAngle: 0, endAngle: .pi, clockwise: false, transform: CGAffineTransform(translationX: 12, y: y).scaledBy(x: 9, y: 3))
                return UIBezierPath(cgPath: half)
            }
            path.append(UIBezierPath(ovalIn: CGRect(x: 3, y: 2, width: 18, height: 6)))
            line([(3, 5), (3, 19)])
            line([(21, 5), (21, 19)])
            path.append(lowerHalf(12))
            path.append(lowerHalf(19))
        case .router:
            rect(2, 14, 20, 8, radius: 2)
            line([(6.01, 18), (6, 18)])
            line([(10.01, 18), (10, 18)])
            line([(15, 10), (15, 14)])
            // Two waves about (15, 10), as Lucide's arcs draw them.
            for radius in [4, 8] as [CGFloat] {
                let wave = UIBezierPath(arcCenter: CGPoint(x: 15, y: 10), radius: radius, startAngle: -.pi / 4, endAngle: -3 * .pi / 4, clockwise: false)
                path.append(wave)
            }
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
