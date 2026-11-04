#if canImport(UIKit)
import HappyLayout
import UIKit

/// The current connection and the one after migration, drawn straight on
/// the screen's gradient in its text colour. Now the
/// phone reaches the computer through the Happy server (a cloud with a
/// database on it), which stores the chats, encrypted; after, through a
/// relay (a router), which passes them on, still encrypted.
/// `ConnectionDiagramLayout` places it; read out as two sentences.
final class ConnectionDiagramView: UIView {
    private typealias S = Strings.DesktopMigration
    private typealias M = ConnectionDiagramLayout.Metrics
    /// A row's heading: a group header's size, in its words' own case.
    private static let headingStyle = TextStyle(.semiBold, size: 13, lineHeight: 18, letterSpacing: -0.08)

    private let currentHeading = StyledLabel(style: ConnectionDiagramView.headingStyle, color: Palette.startText, lines: 1)
    private let afterHeading = StyledLabel(style: ConnectionDiagramView.headingStyle, color: Palette.startText, lines: 1)
    /// Phone, server, computer, its detail; phone, relay, computer, its detail.
    private let words: [StyledLabel]
    private let icons: [LineIconView]
    private let badge = LineIconView(.database, tint: Palette.startText)
    /// The cloud with the badge's hole cut out of it.
    private let badgeHole = CAShapeLayer()
    private let lines = CAShapeLayer()

    override init(frame: CGRect) {
        let texts = [S.phone, S.server, S.computer, S.serverDetail, S.phone, S.relay, S.computer, S.relayDetail]
        words = texts.map { text in
            let label = StyledLabel(style: TextStyles.groupFooter, color: Palette.startText, alignment: .center)
            label.string = text
            return label
        }
        icons = [LineIcon.smartphone, .cloud, .monitor, .smartphone, .router, .monitor].map { LineIconView($0, tint: Palette.startText) }
        super.init(frame: frame)
        currentHeading.string = S.current
        afterHeading.string = S.after
        lines.fillColor = nil
        lines.lineCap = .round
        lines.lineJoin = .round
        lines.lineWidth = 1.5
        layer.addSublayer(lines)
        badge.weight = 2.5
        badgeHole.fillRule = .evenOdd
        icons[1].layer.mask = badgeHole
        for view in [currentHeading, afterHeading] + words + icons + [badge] as [UIView] { addSubview(view) }
        isAccessibilityElement = true
        accessibilityLabel = S.diagramSpoken
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func layout(width: CGFloat) -> ConnectionDiagramLayout {
        ConnectionDiagramLayout(
            width: width,
            phone: words[0].measurable,
            computer: words[2].measurable,
            current: .init(heading: currentHeading.measurable, middle: words[1].measurable, detail: words[3].measurable),
            after: .init(heading: afterHeading.measurable, middle: words[5].measurable, detail: words[7].measurable)
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        currentHeading.setLayoutFrame(layout.current.heading)
        afterHeading.setLayoutFrame(layout.after.heading)
        let frames = layout.current.captions + [layout.current.detail] + layout.after.captions + [layout.after.detail]
        for (label, frame) in zip(words, frames) { label.setLayoutFrame(frame) }
        let iconFrames = [layout.current.phone, layout.current.middle, layout.current.computer, layout.after.phone, layout.after.middle, layout.after.computer]
        for (icon, frame) in zip(icons, iconFrames) { icon.setLayoutFrame(frame) }
        // The database rides on the cloud, in a hole cut out of it, so the
        // gradient shows between them.
        badge.setLayoutFrame(layout.current.badge ?? .zero)
        let hole = UIBezierPath(rect: CGRect(origin: .zero, size: layout.current.middle.size))
        if let frame = layout.current.badgeHole { hole.append(UIBezierPath(roundedRect: frame, cornerRadius: M.badgeHoleRadius)) }
        badgeHole.frame = CGRect(origin: .zero, size: layout.current.middle.size)
        badgeHole.path = hole.cgPath
        lines.frame = bounds
        lines.path = Self.polylines(layout.current.lines + layout.current.arrowheads + layout.after.lines + layout.after.arrowheads)
    }

    private static func polylines(_ lines: [[CGPoint]]) -> CGPath {
        let path = UIBezierPath()
        for line in lines {
            guard let start = line.first else { continue }
            path.move(to: start)
            for point in line.dropFirst() { path.addLine(to: point) }
        }
        return path.cgPath
    }

    private func applyColors() {
        lines.strokeColor = UIColor(Palette.startText).resolvedColor(with: traitCollection).cgColor
    }
}
#endif
