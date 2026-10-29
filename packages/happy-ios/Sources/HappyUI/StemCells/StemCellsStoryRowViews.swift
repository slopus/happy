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
        let inset = bounds.width * (S.ring - S.plate) / S.ring / 2
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

/// The chat's own braille animation while work runs, or the accent dot
/// while it needs an answer. At rest the corner is empty.
final class StemCellsCornerView: UIView {
    private let loader = StemCellBrailleView()
    private(set) var corner = StemCellsRow.Corner.none
    var animating: Bool { loader.animating }
    var onScreen = true { didSet { loader.running = onScreen && corner == .braille } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        addSubview(loader)
        isHidden = true
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ corner: StemCellsRow.Corner) {
        guard corner != self.corner else { return }
        self.corner = corner
        isHidden = corner == .none
        loader.isHidden = corner != .braille
        loader.running = onScreen && corner == .braille
        accessibilityIdentifier = "stem-corner:\(corner)"
        applyColors()
        setNeedsLayout()
    }

    private func applyColors() {
        switch corner {
        case .dot: backgroundColor = UIColor(Palette.stemCellsRowNewDot)
        case .braille, .none: backgroundColor = .clear
        }
        loader.tintColor = UIColor(Palette.stemCellsRowText)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = corner == .dot ? bounds.height / 2 : 0
        loader.frame = bounds
    }
}

/// What a story row writes beside its title, measured the same way by the
/// list's layout and drawn by the row.
enum StemCellsStoryRowText {
    static let timeFont = StemCellsFonts.ui(.regular, size: StemCellsStoryRowMetrics.timeSize)
    static func scale(_ row: StemCellsRow) -> CGFloat { row.depth > 0 ? StemCellsStoryRowMetrics.nestedScale : 1 }
    static func timeFont(_ row: StemCellsRow) -> UIFont { StemCellsFonts.ui(.regular, size: StemCellsStoryRowMetrics.timeSize * scale(row)) }

    /// When the agent last said where it is, as Telegram dates a chat.
    static func time(_ row: StemCellsRow, now: Date = Date()) -> String? {
        guard row.statusLine?.isEmpty == false, let ms = row.statusTime else { return nil }
        return StemCellsRowTime.text(ms, now: now)
    }

    static func timeWidth(_ row: StemCellsRow) -> CGFloat {
        guard let text = time(row) else { return 0 }
        return ceil((text as NSString).size(withAttributes: [.font: timeFont(row)]).width)
    }

    /// The status on its own 19-point lines.
    static func status(_ text: String, scale: CGFloat = 1) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = StemCellsStoryRowMetrics.subtitleLine * scale
        paragraph.maximumLineHeight = StemCellsStoryRowMetrics.subtitleLine * scale
        paragraph.lineBreakMode = .byTruncatingTail
        let font = StemCellsFonts.ui(.regular, size: StemCellsStoryRowMetrics.subtitleSize * scale)
        return NSAttributedString(string: text, attributes: [
            .font: font, .paragraphStyle: paragraph,
            .baselineOffset: (StemCellsStoryRowMetrics.subtitleLine * scale - font.lineHeight) / 4,
        ])
    }
}
#endif
