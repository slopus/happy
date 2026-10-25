#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Telegram's one-time "Tap above to view stories from …" (`TooltipScreen`,
/// default style): a blurred dark bubble under the closed avatars, its
/// arrow pointing up at them, springing out of the arrow's tip. Laid over
/// the whole screen, the first touch anywhere puts it away, and goes on
/// through to what is under it unless it `takesTouch`.
final class StoriesTooltipView: UIView {
    var onDismiss: (() -> Void)?
    private let bubble = UIView()
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .regular))
    private let tint = UIView()
    private let label = UILabel()
    private let shape = CAShapeLayer()
    private var tip: CGPoint = .zero
    private var dismissed = false
    private let takesTouch: Bool

    init(text: String, takesTouch: Bool = false) {
        self.takesTouch = takesTouch
        super.init(frame: .zero)
        label.text = text
        label.font = .systemFont(ofSize: StoriesTooltipLayout.Metrics.fontSize)
        label.textColor = UIColor(Palette.storiesTooltipText)
        label.numberOfLines = 0
        label.accessibilityIdentifier = "stories-tooltip"
        tint.backgroundColor = UIColor(Palette.storiesTooltipGround)
        bubble.layer.mask = shape
        bubble.addSubview(blur)
        bubble.addSubview(tint)
        bubble.addSubview(label)
        addSubview(bubble)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Points at `tip`, in this view's space.
    func point(at tip: CGPoint) {
        guard tip != self.tip else { return }
        self.tip = tip
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = StoriesTooltipLayout(tip: tip, width: bounds.width) { [label] width in
            label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        }
        let frame = layout.bubble.union(layout.arrow)
        let transform = bubble.transform
        bubble.transform = .identity
        // It grows from and shrinks into the arrow's tip.
        if frame.width > 0 { bubble.layer.anchorPoint = CGPoint(x: (layout.arrow.midX - frame.minX) / frame.width, y: 0) }
        bubble.frame = frame
        bubble.transform = transform
        let local = CGRect(origin: .zero, size: frame.size)
        blur.frame = local
        tint.frame = local
        label.frame = layout.text.offsetBy(dx: -frame.minX, dy: -frame.minY)
        let path = UIBezierPath(roundedRect: layout.bubble.offsetBy(dx: -frame.minX, dy: -frame.minY), cornerRadius: StoriesTooltipLayout.Metrics.cornerRadius)
        path.append(Self.arrow(in: layout.arrow.offsetBy(dx: -frame.minX, dy: -frame.minY)))
        shape.path = path.cgPath
        shape.frame = local
    }

    /// Pointing up: a rounded tip, its sides curving out to a wide foot.
    private static func arrow(in box: CGRect) -> UIBezierPath {
        let path = UIBezierPath()
        let w = box.width, h = box.height
        let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: box.minX + x, y: box.minY + y) }
        path.move(to: point(0, h))
        path.addCurve(to: point(w / 2 - 2.6, 1.1), controlPoint1: point(w * 0.22, h), controlPoint2: point(w / 2 - 6, 3.6))
        path.addQuadCurve(to: point(w / 2 + 2.6, 1.1), controlPoint: point(w / 2, -0.9))
        path.addCurve(to: point(w, h), controlPoint1: point(w / 2 + 6, 3.6), controlPoint2: point(w * 0.78, h))
        path.close()
        return path
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !dismissed else { return nil }
        if event?.type == .touches { DispatchQueue.main.async { [weak self] in self?.dismiss() } }
        return takesTouch ? self : nil
    }

    /// Springs out of the arrow's tip, as Telegram's does.
    func show() {
        layoutIfNeeded()
        guard bubble.bounds.width > 0, bubble.bounds.height > 0 else { return }
        let grow = CASpringAnimation(keyPath: "transform.scale")
        grow.mass = 5
        grow.stiffness = 900
        grow.damping = 105
        grow.fromValue = 0.01
        grow.toValue = 1
        grow.duration = grow.settlingDuration
        grow.speed = Float(grow.settlingDuration / 0.4)
        bubble.layer.add(grow, forKey: "show")
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.2
        bubble.layer.add(fade, forKey: "fade")
    }

    /// Shrinks back into the arrow's tip and goes.
    func dismiss() {
        guard !dismissed else { return }
        dismissed = true
        onDismiss?()
        UIView.animate(withDuration: 0.2, delay: 0, options: [.allowUserInteraction]) {
            self.bubble.alpha = 0
            self.bubble.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        } completion: { _ in
            self.removeFromSuperview()
        }
    }
}
#endif
