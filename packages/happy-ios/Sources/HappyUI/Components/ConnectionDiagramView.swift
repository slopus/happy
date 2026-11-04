#if canImport(UIKit)
import HappyLayout
import UIKit

/// The current connection and the one after migration, in a card. Now the
/// phone reaches the computer through the Happy server (a cloud with a
/// database on it), which stores the chats, encrypted; after, through a
/// relay (a router), which passes them on, still encrypted.
/// `ConnectionDiagramLayout` places it; read out as two sentences.
final class ConnectionDiagramView: UIView {
    private typealias S = Strings.DesktopMigration
    private typealias M = ConnectionDiagramLayout.Metrics
    /// A row's heading: a group header's size, in its words' own case.
    private static let headingStyle = TextStyle(.semiBold, size: 13, lineHeight: 18, letterSpacing: -0.08)

    private let currentHeading = StyledLabel(style: ConnectionDiagramView.headingStyle, color: Palette.textSecondary, lines: 1, alignment: .center)
    private let afterHeading = StyledLabel(style: ConnectionDiagramView.headingStyle, color: Palette.text, lines: 1, alignment: .center)
    /// Phone, server, computer, its detail; phone, relay, computer, its detail.
    private let words: [StyledLabel]
    private let icons: [LineIconView]
    private let badge = LineIconView(.database, tint: Palette.textSecondary)
    private let badgeGround = UIView()
    private let beforeLines = CAShapeLayer()
    private let nowLines = CAShapeLayer()

    override init(frame: CGRect) {
        let texts = [S.phone, S.server, S.computer, S.serverDetail, S.phone, S.relay, S.computer, S.relayDetail]
        words = texts.enumerated().map { index, text in
            let label = StyledLabel(style: TextStyles.groupFooter, color: index < 4 ? Palette.textSecondary : Palette.text, alignment: .center)
            label.string = text
            return label
        }
        icons = [
            LineIconView(.smartphone, tint: Palette.textSecondary), LineIconView(.cloud, tint: Palette.textSecondary), LineIconView(.monitor, tint: Palette.textSecondary),
            LineIconView(.smartphone, tint: Palette.text), LineIconView(.router, tint: Palette.text), LineIconView(.monitor, tint: Palette.text),
        ]
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.surface)
        layer.cornerRadius = ItemGroupLayout.Metrics.cardCornerRadius
        layer.cornerCurve = .continuous
        currentHeading.string = S.current
        afterHeading.string = S.after
        for shape in [beforeLines, nowLines] {
            shape.fillColor = nil
            shape.lineCap = .round
            shape.lineJoin = .round
            shape.lineWidth = 1.5
            layer.addSublayer(shape)
        }
        badge.weight = 2.5
        badgeGround.backgroundColor = UIColor(Palette.surface)
        badgeGround.layer.cornerRadius = M.badgeGroundRadius
        for view in [currentHeading, afterHeading] + words + icons + [badgeGround, badge] as [UIView] { addSubview(view) }
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
        // The database rides on the cloud, on a patch of the card.
        badgeGround.setLayoutFrame(layout.current.badgeGround ?? .zero)
        badge.setLayoutFrame(layout.current.badge ?? .zero)
        for shape in [beforeLines, nowLines] { shape.frame = bounds }
        beforeLines.path = Self.polylines(layout.current.lines + layout.current.arrowheads)
        nowLines.path = Self.polylines(layout.after.lines + layout.after.arrowheads)
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
        beforeLines.strokeColor = UIColor(Palette.textSecondary).resolvedColor(with: traitCollection).cgColor
        nowLines.strokeColor = UIColor(Palette.text).resolvedColor(with: traitCollection).cgColor
    }
}
#endif
