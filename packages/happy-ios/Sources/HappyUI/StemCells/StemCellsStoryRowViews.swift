#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A story row's ring (desktop's `StoryRing` at 58): one arc per story in
/// its agent's ring, the seen ones grey and thin, the new ones in the
/// stories' gradient, drawn outside the 50 disc, which is there with no ring
/// too, so a story arriving moves nothing. It never spins.
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

    /// The disc's frame in this view, where the row puts its mark.
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
        let inset = bounds.width * S.ringRoom / S.ring
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

/// The chat's own braille animation while work runs, or a neutral dot
/// while something is unread. At rest the corner is empty.
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
        case .dot: backgroundColor = UIColor(Palette.stemCellsUnreadDot)
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

/// A label whose lines start at its top, as a block of text does, however
/// few it has: a one-line status stays on the status's first line.
final class StemCellsTopLabel: UILabel {
    override func drawText(in rect: CGRect) {
        let fitted = textRect(forBounds: rect, limitedToNumberOfLines: numberOfLines)
        super.drawText(in: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: min(rect.height, fitted.height)))
    }
}

/// What a story row writes, in the faces and sizes the list measures it
/// with and the row draws it in: desktop's, times the text size.
enum StemCellsStoryRowText {
    typealias S = StemCellsStoryRowMetrics

    static func titleFont(_ scale: CGFloat) -> UIFont { StemCellsFonts.ui(.semiBold, size: S.titleSize * scale) }
    static func timeFont(_ scale: CGFloat) -> UIFont { StemCellsFonts.tabular(StemCellsFonts.ui(.regular, size: S.timeSize * scale)) }
    static func statusFont(_ scale: CGFloat) -> UIFont { StemCellsFonts.ui(.regular, size: S.statusSize * scale) }

    /// The text size's multiplier for these traits.
    static func scale(_ traits: UITraitCollection) -> CGFloat {
        TextScale(TextSizeCategory(traits.preferredContentSizeCategory)).multiplier
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var measured: [CGFloat: StemCellsSidebarLayout.StoryText] = [:]

    /// The faces' metrics at `scale`, measured once per size: where each
    /// line's baseline falls as a label draws it.
    static func text(_ scale: CGFloat) -> StemCellsSidebarLayout.StoryText {
        lock.lock()
        defer { lock.unlock() }
        if let known = measured[scale] { return known }
        func metrics(_ font: UIFont) -> StemCellsSidebarLayout.FontMetrics {
            .init(ascender: font.ascender, capHeight: font.capHeight, descender: -font.descender, lineHeight: font.lineHeight)
        }
        let status = statusFont(scale)
        let text = StemCellsSidebarLayout.StoryText(scale: scale, title: metrics(titleFont(scale)), time: metrics(timeFont(scale)), status: metrics(status), statusBaseline: statusBaseline(scale))
        measured[scale] = text
        return text
    }

    /// The first baseline of a status line, from its line's top, as TextKit
    /// sets a line held to `statusLine`.
    private static func statusBaseline(_ scale: CGFloat) -> CGFloat {
        let storage = NSTextStorage(attributedString: lines("Ag", font: statusFont(scale), scale: scale))
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 1000, height: 1000))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let fragment = manager.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
        return fragment.minY + manager.location(forGlyphAt: 0).y
    }

    /// `text` on the status's lines.
    private static func lines(_ text: String, font: UIFont, scale: CGFloat) -> NSMutableAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = S.statusLine * scale
        paragraph.maximumLineHeight = S.statusLine * scale
        return NSMutableAttributedString(string: text, attributes: [.font: font, .paragraphStyle: paragraph, .foregroundColor: UIColor(Palette.stemCellsRowText)])
    }

    /// How long since the conversation last did something.
    static func time(_ row: StemCellsRow, now: Date = Date()) -> String? {
        row.activityTime.map { StemCellsRowTime.text($0, now: now) }
    }

    static func timeWidth(_ row: StemCellsRow, scale: CGFloat, now: Date = Date()) -> CGFloat {
        guard let text = time(row, now: now) else { return 0 }
        return ceil((text as NSString).size(withAttributes: [.font: timeFont(scale)]).width)
    }

    /// What the row's last line holds: the draft, the empty mark when it
    /// has nothing at all to say, else the status's second line.
    static func lastLine(_ row: StemCellsRow) -> StemCellsSidebarLayout.LastLine {
        if row.draft != nil { return .draft }
        let counts = row.lineChanges.map { !$0.isEmpty } ?? false
        return !counts && (row.statusLine ?? "").isEmpty ? .empty : .status
    }

    /// The lines the work changed, then the status, which flows after them.
    static func status(_ row: StemCellsRow, scale: CGFloat) -> NSAttributedString {
        let font = statusFont(scale)
        let text = lines("", font: font, scale: scale)
        if let changes = row.lineChanges, !changes.isEmpty {
            let figures = StemCellsFonts.tabular(font)
            var marks: [(String, ColorToken)] = []
            if changes.added > 0 { marks.append(("+\(compactCount(changes.added))", Palette.stemCellsLinesAdded)) }
            if changes.deleted > 0 { marks.append(("\u{2212}\(compactCount(changes.deleted))", Palette.stemCellsLinesDeleted)) }
            for (mark, color) in marks {
                let run = lines(mark, font: figures, scale: scale)
                run.addAttribute(.foregroundColor, value: UIColor(color), range: NSRange(location: 0, length: run.length))
                // 4 after each mark: between the two, and before the status.
                run.addAttribute(.kern, value: S.countsGap, range: NSRange(location: run.length - 1, length: 1))
                text.append(run)
            }
        }
        text.append(lines(row.statusLine ?? "", font: font, scale: scale))
        return text
    }

    /// "Draft:" and the start of what the person typed, on one line.
    static func draft(_ text: String, scale: CGFloat) -> NSAttributedString {
        let line = lines("Draft: ", font: StemCellsFonts.ui(.medium, size: S.statusSize * scale), scale: scale)
        line.append(lines(text, font: statusFont(scale), scale: scale))
        return line
    }

    /// Desktop's `compactCount`: 842, 1.2k, 4k, 13k.
    static func compactCount(_ value: Int) -> String {
        let count = max(0, value)
        if count < 1_000 { return "\(count)" }
        if count < 5_000 {
            let tenths = (Double(count) / 100).rounded() / 10
            return tenths == tenths.rounded() ? "\(Int(tenths))k" : "\(tenths)k"
        }
        return "\(Int((Double(count) / 1_000).rounded()))k"
    }
}

/// What a story row shows on its last line while its agent has said
/// nothing yet (desktop's `StoryEmptyMark`): a small dinosaur on a stretch of
/// ground between two cacti, sampled nearest-cell into whole device pixels
/// so it stays crisp at every scale, in the status's ink at 55%.
final class StemCellsEmptyMarkView: UIImageView {
    /// 49 × 22 cells, the ground on the last row.
    static let scene = [
        "..........########...............................",
        ".........##.#######..............................",
        ".........##########..............................",
        ".........##########..............................",
        ".........##########..............................",
        ".........#####...................................",
        ".........########................................",
        "#.......#####....................................",
        "#......######....................................",
        "##....########...................................",
        "###..##########.............................##...",
        "#############.##..............##............##...",
        "#############..#..............##..........#.##.#.",
        ".############.................##.#........#.##.#.",
        "..##########...............#..##.#........#####..",
        "...########................#..##.#..........##...",
        "....######.................#..####..........##...",
        ".....##.##.................#####............##...",
        ".....#...#....................##............##...",
        ".....#...#....................##............##...",
        ".....##..##...................##............##...",
        "#################################################",
    ].map { Array($0) }

    private var drawn: (size: CGSize, scale: CGFloat)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        contentMode = .topLeft
        layer.magnificationFilter = .nearest
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        tintColor = UIColor(Palette.stemCellsRowText).withAlphaComponent(StemCellsStoryRowMetrics.emptyInk)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = window?.screen.scale ?? traitCollection.displayScale
        guard scale > 0, bounds.width > 0, drawn?.size != bounds.size || drawn?.scale != scale else { return }
        drawn = (bounds.size, scale)
        image = Self.image(size: bounds.size, scale: scale)
    }

    /// The scene in whole pixels: each pixel takes the cell under its centre.
    static func image(size: CGSize, scale: CGFloat) -> UIImage {
        let width = Int((size.width * scale).rounded())
        let height = Int((size.height * scale).rounded())
        let rows = scene.count
        let columns = scene[0].count
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.black.setFill()
            for y in 0..<height {
                let row = scene[min(rows - 1, Int((Double(y) + 0.5) * Double(rows) / Double(height)))]
                var start = -1
                for x in 0...width {
                    let filled = x < width && row[min(columns - 1, Int((Double(x) + 0.5) * Double(columns) / Double(width)))] == "#"
                    if filled, start < 0 { start = x }
                    if !filled, start >= 0 {
                        context.fill(CGRect(x: CGFloat(start) / scale, y: CGFloat(y) / scale, width: CGFloat(x - start) / scale, height: 1 / scale))
                        start = -1
                    }
                }
            }
        }.withRenderingMode(.alwaysTemplate)
    }
}
#endif
