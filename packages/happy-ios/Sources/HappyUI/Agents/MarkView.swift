#if canImport(UIKit)
import HappyLayout
import UIKit

/// The seedling drawn for one ID: its membrane and core as two filled
/// shapes, the same shape desktop draws for the same ID.
final class MarkView: UIView {
    private let membrane = CAShapeLayer()
    private let core = CAShapeLayer()
    private var drawn: (seed: String, size: CGFloat)?

    var seed: String? {
        didSet { if seed != oldValue { setNeedsLayout() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(membrane)
        layer.addSublayer(core)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        membrane.fillColor = UIColor(Palette.membrane).resolvedColor(with: traitCollection).cgColor
        core.fillColor = UIColor(Palette.core).resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = min(bounds.width, bounds.height)
        guard let seed, size > 0 else { membrane.path = nil; core.path = nil; return }
        membrane.frame = bounds; core.frame = bounds
        if let drawn, drawn.seed == seed, drawn.size == size { return }
        drawn = (seed, size)
        let shape = Geometry.shape(seed)
        membrane.path = Self.path(shape.membrane, size: size)
        core.path = Self.path(shape.core, size: size)
    }

    static func path(_ points: [Geometry.Point], size: CGFloat) -> CGPath {
        let (start, segments) = Geometry.smooth(points, size: Double(size))
        let path = CGMutablePath()
        path.move(to: CGPoint(x: start.x, y: start.y))
        for segment in segments {
            path.addCurve(
                to: CGPoint(x: segment.end.x, y: segment.end.y),
                control1: CGPoint(x: segment.control1.x, y: segment.control1.y),
                control2: CGPoint(x: segment.control2.x, y: segment.control2.y)
            )
        }
        path.closeSubpath()
        return path
    }
}
#endif
