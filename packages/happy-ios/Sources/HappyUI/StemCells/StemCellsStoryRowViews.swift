#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A story row's ring (design "Sidebar v2: agent story rings"): one arc
/// per story in its agent's ring, the seen ones grey and thin, the new ones
/// in the stories' gradient, with the mark's round plate inside. No story,
/// no ring; the plate stays, so rows never change size. It never spins.
final class StemCellsStoryRingView: UIView {
    private let plate = UIView()
    private let seen = CAShapeLayer()
    private let unseen = CAShapeLayer()
    private let gradient = CAGradientLayer()
    private(set) var state = StemCellsRow.StoryRowState()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        plate.isUserInteractionEnabled = false
        addSubview(plate)
        for ring in [seen, unseen] {
            ring.fillColor = nil
            ring.lineCap = .round
        }
        seen.lineWidth = StemCellsStoryRowMetrics.seenWidth
        unseen.lineWidth = StemCellsStoryRowMetrics.unseenWidth
        unseen.strokeColor = UIColor.white.cgColor
        // Desktop's gradient runs from the bottom-left to the top-right.
        gradient.startPoint = CGPoint(x: 0, y: 1)
        gradient.endPoint = CGPoint(x: 1, y: 0)
        gradient.mask = unseen
        layer.addSublayer(seen)
        layer.addSublayer(gradient)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The plate's frame in this view, where the row puts its mark.
    var plateFrame: CGRect { plate.frame }

    func apply(_ state: StemCellsRow.StoryRowState) {
        guard state != self.state else { return }
        // Watched since: the colour gives way to grey, in sight.
        if state.unseen < self.state.unseen, window != nil {
            let fade = CATransition()
            fade.type = .fade
            fade.duration = 0.35
            for ring in [seen, gradient] { ring.add(fade, forKey: "seen") }
        }
        self.state = state
        setNeedsLayout()
    }

    private func applyColors() {
        let traits = traitCollection
        seen.strokeColor = UIColor(Palette.storiesSeen).resolvedColor(with: traits).cgColor
        gradient.colors = [UIColor(Palette.storiesUnseenTop), UIColor(Palette.storiesUnseenBottom)].map { $0.resolvedColor(with: traits).cgColor }
        plate.backgroundColor = UIColor(Palette.stemCellsRowTextActive).withAlphaComponent(StemCellsStoryRowMetrics.plateInk)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        typealias S = StemCellsStoryRowMetrics
        let inset = (bounds.width - S.plate) / 2
        plate.frame = bounds.insetBy(dx: inset, dy: inset)
        plate.layer.cornerRadius = plate.bounds.width / 2
        // Round, for the viewer that grows out of it.
        layer.cornerRadius = bounds.width / 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        seen.frame = bounds
        gradient.frame = bounds
        unseen.frame = bounds
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let radius = S.ringRadius * bounds.width / S.ring
        let seenPath = CGMutablePath()
        let unseenPath = CGMutablePath()
        // Seen first, then the new ones: the ring fills in clockwise.
        let arcs = StoryRingLayout.arcs(segments: state.segments, seen: state.segments - state.unseen, radius: radius, gap: S.segmentGap)
        for arc in arcs {
            let path = arc.seen ? seenPath : unseenPath
            path.move(to: CGPoint(x: center.x + radius * cos(arc.start), y: center.y + radius * sin(arc.start)))
            path.addArc(center: center, radius: radius, startAngle: arc.start, endAngle: arc.end, clockwise: false)
        }
        seen.path = seenPath
        unseen.path = unseenPath
        CATransaction.commit()
    }
}

/// A story row's one corner signal: the accent dot while the agent waits
/// on the person, or a quiet loading bar while it works (a track with a
/// 40% fill sliding across, no shimmer). Nothing otherwise.
final class StemCellsCornerView: UIView {
    private let fill = UIView()
    private(set) var corner = StemCellsRow.Corner.none

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        fill.isUserInteractionEnabled = false
        addSubview(fill)
        isHidden = true
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        NotificationCenter.default.addObserver(self, selector: #selector(restart), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(restart), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ corner: StemCellsRow.Corner) {
        guard corner != self.corner else { return }
        self.corner = corner
        isHidden = corner == .none
        fill.isHidden = corner != .bar
        accessibilityIdentifier = "stem-corner:\(corner)"
        applyColors()
        setNeedsLayout()
        restart()
    }

    private func applyColors() {
        switch corner {
        case .dot: backgroundColor = UIColor(Palette.stemCellsRowNewDot)
        case .bar: backgroundColor = UIColor(Palette.stemCellsRowTextActive).withAlphaComponent(0.14)
        case .none: backgroundColor = .clear
        }
        fill.backgroundColor = UIColor(Palette.stemCellsRowText)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        let width = bounds.width * StemCellsStoryRowMetrics.barFill
        let place = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        if fill.bounds.size != place.size {
            fill.bounds = place
            fill.layer.cornerRadius = bounds.height / 2
            restart()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        restart()
    }

    /// The fill slides from just off the left to past the right, over and
    /// over; still with less motion, and off screen.
    @objc private func restart() {
        fill.layer.removeAnimation(forKey: "slide")
        let width = fill.bounds.width
        fill.center = CGPoint(x: bounds.width * 0.3, y: bounds.midY)
        guard corner == .bar, window != nil, width > 0, !UIAccessibility.isReduceMotionEnabled else { return }
        let slide = CABasicAnimation(keyPath: "position.x")
        slide.fromValue = -width / 2
        slide.toValue = bounds.width + width / 2
        slide.duration = StemCellsStoryRowMetrics.barDuration
        slide.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        slide.repeatCount = .infinity
        fill.layer.add(slide, forKey: "slide")
    }
}
#endif
