#if canImport(UIKit)
import HappyLayout
import UIKit

/// Stop's rounded square (`StopGlyphLayout`), filled with the tint, drawn
/// as a vector and centred in the bounds. Give it the container's frame,
/// as `IconView` takes it.
final class StopGlyphView: UIView {
    var glyphSize: CGFloat {
        didSet { if glyphSize != oldValue { setNeedsLayout() } }
    }

    private let shape = CAShapeLayer()

    init(glyphSize: CGFloat) {
        self.glyphSize = glyphSize
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(shape)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyFill()
        }
        applyFill()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The square the layout gives these bounds at this screen's scale.
    var square: StopGlyphLayout.Square {
        StopGlyphLayout.square(in: bounds, glyphSize: glyphSize, scale: layoutScale)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: glyphSize, height: glyphSize)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let square = square
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.frame = bounds
        shape.contentsScale = layoutScale
        shape.path = UIBezierPath(roundedRect: square.frame, cornerRadius: square.cornerRadius).cgPath
        CATransaction.commit()
    }

    override func tintColorDidChange() {
        super.tintColorDidChange()
        applyFill()
    }

    private func applyFill() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.fillColor = tintColor.resolvedColor(with: traitCollection).cgColor
        CATransaction.commit()
    }
}
#endif
