#if canImport(UIKit)
import HappyLayout
import UIKit

/// The small spinner before a link's status ("Connecting…"), in home's
/// title and a chat's subtitle: the system's activity indicator, drawn
/// `side` points square in the quiet grey.
final class LinkSpinnerView: UIView {
    private let indicator = UIActivityIndicatorView(style: .medium)
    let side: CGFloat

    init(side: CGFloat = AccountSwitcherLayout.Metrics.spinner) {
        self.side = side
        super.init(frame: CGRect(x: 0, y: 0, width: side, height: side))
        isUserInteractionEnabled = false
        indicator.color = UIColor(Palette.textSecondary)
        indicator.hidesWhenStopped = false
        let natural = indicator.sizeThatFits(.zero)
        let scale = natural.width > 0 ? side / natural.width : 1
        indicator.transform = CGAffineTransform(scaleX: scale, y: scale)
        addSubview(indicator)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: side, height: side) }
    override var intrinsicContentSize: CGSize { CGSize(width: side, height: side) }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Scaled about its centre: placed by its centre, not its frame.
        indicator.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// Turning while it is shown; still while it is not, so it costs nothing.
    var spins = false {
        didSet {
            guard spins != oldValue else { return }
            if spins { indicator.startAnimating() } else { indicator.stopAnimating() }
        }
    }

    /// Whether it is turning (tests).
    var isTurning: Bool { indicator.isAnimating }
}
#endif
