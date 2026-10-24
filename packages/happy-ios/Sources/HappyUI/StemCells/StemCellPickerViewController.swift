#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What one of the composer's pickers lists.
struct StemCellPickerContent: Equatable {
    struct Gauge: Equatable {
        var text: String
        /// What is left, 0–100.
        var left: Int
        var tone: StemCellAccountUsage.Tone
    }

    struct Row: Equatable {
        var id: String
        var title: String
        var subtitle: String?
        var checked = false
        var disabled = false
        var gauge: Gauge?
    }

    struct Section: Equatable {
        var header: String?
        var rows: [Row]
    }

    enum Notice: Equatable {
        case quiet(String)
        case warning(String)
    }

    var title: String
    var notice: Notice?
    var sections: [Section]
    /// A last row in a group of its own, such as the benchmarks link.
    var footer: Row?
}

/// One picker in a sheet: native, half height to start and full on a pull,
/// laid out by `StemCellPickerLayout`. A pick closes it.
final class StemCellPickerViewController: UIViewController {
    private var content: StemCellPickerContent
    private let onPick: (String) -> Void
    /// However it closes: a pick, a swipe down or a tap outside.
    var onClose: (() -> Void)?
    private let scrollView = UIScrollView()
    private let titleLabel = UILabel()
    private let noticeBox = UIView()
    private let noticeLabel = UILabel()
    private var headers: [UILabel] = []
    private var groups: [UIView] = []
    private var rows: [StemCellPickerRowView] = []

    init(content: StemCellPickerContent, onPick: @escaping (String) -> Void) {
        self.content = content
        self.onPick = onPick
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.accessibilityIdentifier = "stem-picker"
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)
        titleLabel.font = StemCellsFonts.ui(.semiBold, size: 17)
        titleLabel.textColor = UIColor(Palette.text)
        titleLabel.accessibilityTraits = .header
        scrollView.addSubview(titleLabel)
        noticeBox.layer.cornerRadius = StemCellPickerLayout.Metrics.noticeRadius
        noticeBox.layer.cornerCurve = .continuous
        noticeLabel.numberOfLines = 0
        noticeLabel.font = StemCellsFonts.ui(.regular, size: 13)
        scrollView.addSubview(noticeBox)
        scrollView.addSubview(noticeLabel)
        apply(content)
    }

    func update(_ content: StemCellPickerContent) {
        guard content != self.content else { return }
        apply(content)
    }

    private func apply(_ content: StemCellPickerContent) {
        self.content = content
        titleLabel.text = content.title
        switch content.notice {
        case .quiet(let text):
            noticeLabel.text = text
            noticeLabel.textColor = UIColor(Palette.textSecondary)
            noticeBox.backgroundColor = UIColor(Palette.surface)
        case .warning(let text):
            noticeLabel.text = text
            noticeLabel.textColor = UIColor(Palette.statusError)
            noticeBox.backgroundColor = UIColor(Palette.boxErrorBackground)
        case nil:
            noticeLabel.text = nil
        }
        noticeBox.isHidden = content.notice == nil
        noticeLabel.isHidden = content.notice == nil

        let all = content.sections.flatMap(\.rows) + (content.footer.map { [$0] } ?? [])
        while rows.count < all.count {
            let row = StemCellPickerRowView()
            row.addTarget(self, action: #selector(picked(_:)), for: .touchUpInside)
            rows.append(row)
        }
        let groupCount = content.sections.count + (content.footer == nil ? 0 : 1)
        while groups.count < groupCount {
            let group = UIView()
            group.backgroundColor = UIColor(Palette.surface)
            group.layer.cornerRadius = StemCellPickerLayout.Metrics.groupRadius
            group.layer.cornerCurve = .continuous
            group.clipsToBounds = true
            scrollView.addSubview(group)
            groups.append(group)
        }
        while headers.count < content.sections.count {
            let header = UILabel()
            header.font = StemCellsFonts.ui(.semiBold, size: 13)
            header.textColor = UIColor(Palette.textSecondary)
            scrollView.addSubview(header)
            headers.append(header)
        }
        var index = 0
        for (sectionIndex, section) in content.sections.enumerated() {
            headers[sectionIndex].text = section.header
            headers[sectionIndex].isHidden = section.header == nil
            groups[sectionIndex].isHidden = false
            for row in section.rows {
                rows[index].configure(row)
                groups[sectionIndex].addSubview(rows[index])
                index += 1
            }
        }
        for header in headers[content.sections.count...] { header.isHidden = true }
        if let footer = content.footer {
            rows[index].configure(footer)
            groups[content.sections.count].isHidden = false
            groups[content.sections.count].addSubview(rows[index])
            index += 1
        }
        for group in groups[groupCount...] { group.isHidden = true }
        for row in rows[index...] { row.removeFromSuperview() }
        view.setNeedsLayout()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed {
            onClose?()
            onClose = nil
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        let width = view.bounds.width
        let hairline = 1 / max(1, traitCollection.displayScale)
        var rowIndex = 0
        func row(_ row: StemCellPickerContent.Row) -> StemCellPickerLayout.Row {
            defer { rowIndex += 1 }
            let view = rows[rowIndex]
            return .init(title: view.titleLabel.measurable, subtitle: row.subtitle == nil ? nil : view.subtitleLabel.measurable, trailing: view.trailing.size)
        }
        let sections = content.sections.enumerated().map { index, section in
            StemCellPickerLayout.Section(header: section.header == nil ? nil : headers[index].measurable, rows: section.rows.map(row))
        }
        let footer = content.footer.map(row)
        let layout = StemCellPickerLayout(
            width: width, safeBottom: view.safeAreaInsets.bottom, hairline: hairline,
            title: titleLabel.measurable, notice: content.notice == nil ? nil : noticeLabel.measurable,
            sections: sections, footer: footer
        )
        titleLabel.frame = layout.title
        if let box = layout.notice, let text = layout.noticeText {
            noticeBox.frame = box
            noticeLabel.frame = text
        }
        var index = 0
        func place(_ placed: StemCellPickerLayout.PlacedSection, group: UIView) {
            group.frame = placed.group
            for frame in placed.rows {
                rows[index].place(frame, in: placed.group)
                index += 1
            }
        }
        for (sectionIndex, placed) in layout.sections.enumerated() {
            if let header = placed.header { headers[sectionIndex].frame = header }
            place(placed, group: groups[sectionIndex])
        }
        if let footer = layout.footer { place(footer, group: groups[layout.sections.count]) }
        scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    @objc private func picked(_ row: StemCellPickerRowView) {
        guard let id = row.id else { return }
        StemCellsHaptics.play(.pick)
        let onPick = onPick
        dismiss(animated: true) { onPick(id) }
    }
}

/// One row of a picker: its title, its subtitle and its end, in its group.
final class StemCellPickerRowView: UIControl {
    let titleLabel = UILabel()
    let subtitleLabel = UILabel()
    private let gaugeView = StemCellUsageGaugeView()
    private let checkView = IconView(size: StemCellPickerTrailingLayout.check, tint: Palette.radioActive)
    private let separator = UIView()
    private(set) var id: String?
    private(set) var trailing = StemCellPickerTrailingLayout(gauge: nil, checked: false)

    override init(frame: CGRect) {
        super.init(frame: frame)
        titleLabel.font = StemCellsFonts.ui(.medium, size: 16)
        titleLabel.textColor = UIColor(Palette.text)
        titleLabel.numberOfLines = 0
        subtitleLabel.font = StemCellsFonts.ui(.regular, size: 13)
        subtitleLabel.textColor = UIColor(Palette.textSecondary)
        subtitleLabel.numberOfLines = 0
        checkView.icon = .ionicons("checkmark")
        separator.backgroundColor = UIColor(Palette.stemCellsDivider)
        for view in [titleLabel, subtitleLabel, gaugeView, checkView, separator] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        isAccessibilityElement = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(_ row: StemCellPickerContent.Row) {
        id = row.id
        titleLabel.text = row.title
        subtitleLabel.text = row.subtitle
        subtitleLabel.isHidden = row.subtitle == nil
        if let gauge = row.gauge { gaugeView.configure(gauge) }
        gaugeView.isHidden = row.gauge == nil
        checkView.isHidden = !row.checked
        trailing = StemCellPickerTrailingLayout(gauge: row.gauge == nil ? nil : gaugeView.layout.size, checked: row.checked)
        isEnabled = !row.disabled
        alpha = row.disabled ? 0.4 : 1
        accessibilityIdentifier = "stem-pick:\(row.id.replacingOccurrences(of: "\n", with: ":"))"
        accessibilityLabel = [row.title, row.gauge.map { Strings.StemCells.percentLeft($0.left) }, row.subtitle].compactMap { $0 }.joined(separator: ", ")
        accessibilityTraits = row.checked ? [.button, .selected] : row.disabled ? [.button, .notEnabled] : .button
    }

    /// `frame` is in the sheet; the row sits in its group.
    func place(_ placed: StemCellPickerLayout.PlacedRow, in group: CGRect) {
        let origin = placed.frame.origin
        frame = placed.frame.offsetBy(dx: -group.minX, dy: -group.minY)
        titleLabel.frame = placed.title.offsetBy(dx: -origin.x, dy: -origin.y)
        if let subtitle = placed.subtitle { subtitleLabel.frame = subtitle.offsetBy(dx: -origin.x, dy: -origin.y) }
        if let end = placed.trailing {
            let end = end.offsetBy(dx: -origin.x, dy: -origin.y)
            if let gauge = trailing.gauge { gaugeView.frame = gauge.offsetBy(dx: end.minX, dy: end.minY) }
            if let check = trailing.check { checkView.frame = check.offsetBy(dx: end.minX, dy: end.minY) }
        }
        separator.isHidden = placed.separator == nil
        if let line = placed.separator { separator.frame = line.offsetBy(dx: -origin.x, dy: -origin.y) }
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.stemCellsRowPressed) : .clear }
    }
}

/// Desktop's UsageGauge: what is left, then a ring that drains as the
/// window is spent, yellow when little is left, red when almost nothing is.
final class StemCellUsageGaugeView: UIView {
    private let label = UILabel()
    private let track = CAShapeLayer()
    private let arc = CAShapeLayer()
    private var gauge: StemCellPickerContent.Gauge?
    private(set) var layout = StemCellUsageGaugeLayout(text: .zero)

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = StemCellsFonts.ui(.medium, size: 12)
        addSubview(label)
        for shape in [track, arc] {
            shape.fillColor = nil
            shape.lineWidth = 2
            layer.addSublayer(shape)
        }
        arc.lineCap = .round
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(_ gauge: StemCellPickerContent.Gauge) {
        self.gauge = gauge
        label.text = gauge.text
        layout = StemCellUsageGaugeLayout(text: label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)))
        applyColors()
        setNeedsLayout()
    }

    private func applyColors() {
        guard let gauge else { return }
        let tone: ColorToken = switch gauge.tone {
        case .ample: Palette.stemCellsUsageArc
        case .low: Palette.stemCellsUsageLow
        case .critical: Palette.stemCellsUsageCritical
        }
        label.textColor = UIColor(gauge.tone == .critical ? Palette.stemCellsUsageCritical : Palette.text)
        arc.strokeColor = UIColor(tone).resolvedColor(with: traitCollection).cgColor
        let trackColor = UIColor(gauge.tone == .critical ? Palette.stemCellsUsageCritical : Palette.stemCellsUsageTrack).resolvedColor(with: traitCollection)
        track.strokeColor = (gauge.tone == .critical ? trackColor.withAlphaComponent(0.4) : trackColor).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = layout.text
        let ring = layout.ring.insetBy(dx: 1, dy: 1)
        let center = CGPoint(x: ring.midX, y: ring.midY)
        let radius = ring.width / 2
        track.path = UIBezierPath(ovalIn: ring).cgPath
        let left = CGFloat(gauge?.left ?? 0) / 100
        arc.path = UIBezierPath(arcCenter: center, radius: radius, startAngle: -.pi / 2, endAngle: -.pi / 2 + 2 * .pi * left, clockwise: true).cgPath
        arc.isHidden = left <= 0
    }
}
#endif
