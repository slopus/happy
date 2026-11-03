#if canImport(UIKit)
import HappyLayout
import UIKit

/// A line of a chat row that carries the shimmer (`Shimmer`, `lift`), laid
/// out off the main thread three times: at its own colour, dimmed at rest,
/// and in the band's colour.
struct ChatShimmerText {
    var ink: ChatTextLayout
    var rest: ChatTextLayout
    var band: ChatTextLayout
}

/// A `.shimmer` item's live view: the text dimmed under a full-strength
/// band while the band can run, at its own colour when motion is reduced.
final class ChatShimmerView: UIView {
    private let base = ChatTextView()
    private let copy = ChatTextView()
    private lazy var band = ShimmerBand(copy: copy)
    private var text: ChatShimmerText?

    var sweepBegan: CFTimeInterval? { band.sweepBegan }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        base.isAccessibilityElement = false
        addSubview(base)
        addSubview(band)
        band.onClockChange = { [weak self] in self?.applyBase() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ text: ChatShimmerText) {
        self.text = text
        copy.layout = text.band
        band.shimmering = true
        applyBase()
        setNeedsLayout()
    }

    func stop() { band.shimmering = false }

    private func applyBase() {
        guard let text else { return }
        base.layout = ShimmerClock.shared.holdsStill ? text.ink : text.rest
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        base.frame = bounds
        band.frame = bounds
        band.run = CGRect(x: 0, y: 0, width: min(text?.ink.size.width ?? 0, bounds.width), height: bounds.height)
    }
}
#endif
