#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What one of the composer's model control panels lists, as desktop's
/// `ComposerModelControl` draws it: a service's heading over its models, a
/// line with its check before its name, a usage gauge at a line's end, the
/// hairline between blocks, and an account's windows under its list.
struct StemCellPickerContent: Equatable {
    struct Gauge: Equatable {
        var text: String
        var left: Int
        var tone: StemCellAccountUsage.Tone
    }

    /// One of an account's windows (its name, when it starts over, what is
    /// left), or a quiet line about how current they are.
    struct Window: Equatable {
        var label: String
        var resets: String?
        var gauge: Gauge?
        var primary = false
        var critical = false
    }

    enum Line: Equatable {
        case notice(String, warning: Bool)
        /// A service: its name, its account, its windows' gauges, and the
        /// service whose accounts it opens.
        case heading(service: String, account: String?, gauges: [Gauge], opens: String?, label: String)
        case option(key: String, label: String, checked: Bool, disabled: Bool, gauge: Gauge?)
        case separator
        case link(key: String, label: String)
        case windows([Window])
    }

    /// The panel's accessibility identifier and name.
    var id: String
    var label: String
    var lines: [Line]
    var footer: [Line] = []
    var minWidth: CGFloat
    var maxWidth: CGFloat

    /// The checked line, which the panel opens on.
    var selected: Int? {
        lines.firstIndex { line in
            if case .option(_, _, true, _, _) = line { true } else { false }
        }
    }
}

/// The panel's type, measured where the layout needs it.
@MainActor
enum StemCellPickerType {
    typealias M = StemCellPickerMetrics
    static let label = StemCellsFonts.ui(.regular, size: M.labelSize)
    static let service = StemCellsFonts.ui(.semiBold, size: M.headingSize)
    static let account = StemCellsFonts.ui(.regular, size: M.headingSize)
    static let link = StemCellsFonts.ui(.medium, size: M.linkSize)
    static let gauge = StemCellsFonts.tabular(StemCellsFonts.ui(.regular, size: M.gaugeSize))
    static let notice = StemCellsFonts.ui(.regular, size: M.linkSize)

    static func size(_ text: String, _ font: UIFont) -> CGSize {
        let size = (text as NSString).size(withAttributes: [.font: font])
        return CGSize(width: ceil(size.width), height: ceil(font.lineHeight))
    }

    static func gaugeSize(_ gauge: StemCellPickerContent.Gauge) -> CGSize {
        StemCellUsageGaugeLayout(text: size(gauge.text, Self.gauge)).size
    }

    /// The width a line asks of its panel.
    static func width(_ line: StemCellPickerContent.Line) -> CGFloat {
        // A name starts past the check's column, picked or not.
        let sides = 2 * M.inset + 2 * M.padding + M.checkColumn
        switch line {
        case .option(_, let label, _, _, let gauge):
            return sides + size(label, Self.label).width + (gauge.map { M.checkGap + gaugeSize($0).width } ?? 0)
        case .link(_, let label):
            return sides + size(label, link).width
        // A heading and the windows keep to the line's leading edge.
        case .heading(let service, let account, let gauges, let opens, _):
            var width = 2 * M.inset + 2 * M.padding + size(service, Self.service).width
            if let account { width += M.headingGap + min(M.accountMax, size(account, Self.account).width) }
            if !gauges.isEmpty || opens != nil { width += M.headingGap }
            width += gauges.map { gaugeSize($0).width }.reduce(0, +) + CGFloat(max(0, gauges.count - 1)) * M.usageGap
            if opens != nil { width += (gauges.isEmpty ? 0 : M.headingGap) + M.chevron }
            return width
        case .windows(let windows):
            return 2 * M.inset + 2 * M.padding + (windows.map(windowWidth).max() ?? 0)
        // A notice wraps.
        case .notice, .separator:
            return 0
        }
    }

    /// One window's line: its name, when it starts over, what is left.
    static func windowWidth(_ window: StemCellPickerContent.Window) -> CGFloat {
        let font = StemCellsFonts.ui(window.primary ? .semiBold : .regular, size: window.primary ? M.linkSize : M.headingSize)
        var width = size(window.label, font).width
        if let resets = window.resets { width = max(width, M.detailsLabelMin) + M.detailsGap + size(resets, Self.account).width }
        if let gauge = window.gauge { width += M.detailsGap + gaugeSize(gauge).width }
        return width
    }

    static func item(_ line: StemCellPickerContent.Line, width: CGFloat) -> StemCellPickerPanelLayout.Item {
        switch line {
        case .option: .row
        case .link: .block(M.row)
        case .heading: .heading
        case .separator: .separator
        case .notice(let text, _):
            .block(ceil((text as NSString).boundingRect(
                with: CGSize(width: max(1, width - 2 * M.inset - 2 * M.padding - M.checkColumn), height: .greatestFiniteMagnitude),
                options: .usesLineFragmentOrigin, attributes: [.font: notice], context: nil
            ).height) + 2 * M.detailsInsetY)
        case .windows(let windows):
            .block(StemCellPickerPanelLayout.detailsHeight(lines: windows.count, primary: windows.first?.primary == true))
        }
    }

    /// The panel's width: its widest line, between its least and most.
    static func panelWidth(_ content: StemCellPickerContent) -> CGFloat {
        let widest = (content.lines + content.footer).map(width).max() ?? 0
        return min(content.maxWidth, max(content.minWidth, widest))
    }
}

/// A usage gauge as desktop's: what is left, then a ring that drains as the
/// window is spent, yellow when little is left, red when almost nothing is.
final class StemCellUsageGaugeView: UIView {
    private let label = UILabel()
    private let track = CAShapeLayer()
    private let arc = CAShapeLayer()
    private var gauge: StemCellPickerContent.Gauge?
    private var strong = false
    private(set) var layout = StemCellUsageGaugeLayout(text: .zero)

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = StemCellPickerType.gauge
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

    /// `strong` draws the number in full ink (the week under the accounts).
    func configure(_ gauge: StemCellPickerContent.Gauge, strong: Bool = false) {
        self.gauge = gauge
        self.strong = strong
        label.text = gauge.text
        layout = StemCellUsageGaugeLayout(text: StemCellPickerType.size(gauge.text, StemCellPickerType.gauge))
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
        label.textColor = UIColor(gauge.tone == .critical ? Palette.stemCellsUsageCritical : strong ? Palette.stemCellsPanelText : Palette.stemCellsPanelSecondary)
        arc.strokeColor = UIColor(tone).resolvedColor(with: traitCollection).cgColor
        let trackColor = UIColor(gauge.tone == .critical ? Palette.stemCellsUsageCritical : Palette.stemCellsUsageTrack).resolvedColor(with: traitCollection)
        track.strokeColor = (gauge.tone == .critical ? trackColor.withAlphaComponent(0.4) : trackColor).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = layout.text
        let ring = layout.ring.insetBy(dx: 1, dy: 1)
        track.path = UIBezierPath(ovalIn: ring).cgPath
        let left = CGFloat(gauge?.left ?? 0) / 100
        arc.path = UIBezierPath(arcCenter: CGPoint(x: ring.midX, y: ring.midY), radius: ring.width / 2, startAngle: -.pi / 2, endAngle: -.pi / 2 + 2 * .pi * left, clockwise: true).cgPath
        arc.isHidden = left <= 0
    }
}

/// One line of a panel: a model, effort or account with its check in the
/// column before its name, a service's heading, the benchmarks link, a
/// notice, a hairline, or an account's windows. Names, the link and notices
/// start past the check's column, as a menu's titles; headings and windows
/// keep to its leading edge, as a menu's section titles.
final class StemCellPickerLineView: UIControl {
    typealias M = StemCellPickerMetrics
    let line: StemCellPickerContent.Line
    private let highlight = UIView()
    private let title = UILabel()
    private let detail = UILabel()
    private let check = UIImageView()
    private let chevron = UIImageView()
    private var gauges: [StemCellUsageGaugeView] = []
    private var rows: [(label: UILabel, resets: UILabel, gauge: StemCellUsageGaugeView?, window: StemCellPickerContent.Window)] = []

    init(_ line: StemCellPickerContent.Line) {
        self.line = line
        super.init(frame: .zero)
        highlight.isUserInteractionEnabled = false
        highlight.layer.cornerRadius = M.highlightRadius
        highlight.layer.cornerCurve = .continuous
        addSubview(highlight)
        for label in [title, detail] {
            label.lineBreakMode = .byTruncatingTail
            addSubview(label)
        }
        check.image = StemCellsGlyphs.image("checkmark", size: M.check).withRenderingMode(.alwaysTemplate)
        check.contentMode = .center
        chevron.image = StemCellsGlyphs.image("chevron-right", size: M.chevron).withRenderingMode(.alwaysTemplate)
        chevron.contentMode = .center
        configure()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        applyColors()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func configure() {
        isAccessibilityElement = true
        switch line {
        case .option(let key, let label, let checked, let disabled, let gauge):
            title.font = StemCellPickerType.label
            title.text = label
            if checked { addSubview(check) }
            if let gauge { addGauge(gauge) }
            isEnabled = !disabled
            alpha = disabled ? 0.48 : 1
            accessibilityIdentifier = "stem-picker-row:\(key)"
            accessibilityLabel = [label, gauge.map { Strings.StemCells.percentLeft($0.left) }].compactMap { $0 }.joined(separator: ", ")
            accessibilityTraits = checked ? [.button, .selected] : .button
            if disabled { accessibilityTraits.insert(.notEnabled) }
        case .heading(let service, let account, let gauges, let opens, let label):
            title.font = StemCellPickerType.service
            title.text = service
            detail.font = StemCellPickerType.account
            detail.text = account
            gauges.forEach(addGauge)
            if opens != nil { addSubview(chevron) }
            isEnabled = opens != nil
            accessibilityIdentifier = "stem-picker-heading:\(opens ?? service)"
            accessibilityLabel = label
            accessibilityTraits = opens != nil ? .button : .header
        case .link(let key, let label):
            title.font = StemCellPickerType.link
            title.text = label
            accessibilityIdentifier = "stem-picker-row:\(key)"
            accessibilityLabel = label
            accessibilityTraits = .link
        case .notice(let text, _):
            title.font = StemCellPickerType.notice
            title.text = text
            title.numberOfLines = 0
            isEnabled = false
            accessibilityLabel = text
            accessibilityTraits = .staticText
        case .separator:
            isEnabled = false
            isAccessibilityElement = false
        case .windows(let windows):
            isEnabled = false
            title.isHidden = true
            detail.isHidden = true
            for window in windows {
                let label = UILabel()
                let resets = UILabel()
                for part in [label, resets] {
                    part.lineBreakMode = .byTruncatingTail
                    addSubview(part)
                }
                let primary = window.primary
                label.font = StemCellsFonts.ui(primary ? .semiBold : .regular, size: primary ? M.linkSize : M.headingSize)
                label.text = window.label
                resets.font = StemCellsFonts.ui(.regular, size: M.headingSize)
                resets.text = window.resets
                var gaugeView: StemCellUsageGaugeView?
                if let gauge = window.gauge {
                    let view = StemCellUsageGaugeView()
                    view.configure(gauge, strong: primary)
                    addSubview(view)
                    gaugeView = view
                }
                rows.append((label, resets, gaugeView, window))
            }
            accessibilityLabel = windows.map { [$0.label, $0.resets, $0.gauge.map { Strings.StemCells.percentLeft($0.left) }].compactMap { $0 }.joined(separator: " ") }.joined(separator: ", ")
            accessibilityTraits = .staticText
        }
    }

    private func addGauge(_ gauge: StemCellPickerContent.Gauge) {
        let view = StemCellUsageGaugeView()
        view.configure(gauge)
        view.isUserInteractionEnabled = false
        addSubview(view)
        gauges.append(view)
    }

    override var isHighlighted: Bool {
        didSet { applyColors() }
    }

    private func applyColors() {
        let text = UIColor(Palette.stemCellsPanelText)
        let secondary = UIColor(Palette.stemCellsPanelSecondary)
        check.tintColor = text
        switch line {
        case .option:
            title.textColor = text
            highlight.backgroundColor = isHighlighted ? UIColor(Palette.stemCellsPanelPressed) : nil
        case .heading:
            // Pressed, a heading reads in full ink.
            title.textColor = isHighlighted ? text : secondary
            detail.textColor = title.textColor
            chevron.tintColor = title.textColor
            highlight.backgroundColor = isHighlighted ? UIColor(Palette.stemCellsPanelPressed) : nil
        case .link:
            title.textColor = secondary
            highlight.backgroundColor = isHighlighted ? UIColor(Palette.stemCellsPanelPressed) : nil
        case .notice(_, let warning):
            title.textColor = warning ? UIColor(Palette.stemCellsUsageCritical) : secondary
        case .separator:
            backgroundColor = UIColor(Palette.stemCellsPanelDivider)
        case .windows:
            for row in rows {
                row.label.textColor = row.window.critical ? UIColor(Palette.stemCellsUsageCritical) : row.window.primary ? text : secondary
                row.resets.textColor = secondary
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let bounds = self.bounds
        // Past the check's column.
        let named = bounds.inset(by: UIEdgeInsets(top: 0, left: M.checkColumn, bottom: 0, right: 0))
        highlight.frame = bounds.insetBy(dx: 0, dy: M.highlightInset)
        typealias Piece = StemCellPickerLineLayout.Piece
        switch line {
        case .option(_, let label, let checked, _, let gauge):
            let line = StemCellPickerLineLayout(line: named, leading: [Piece(StemCellPickerType.size(label, StemCellPickerType.label), shrinks: true)], trailing: gauge.map { [Piece(StemCellPickerType.gaugeSize($0))] } ?? [])
            title.frame = line.leading[0]
            if checked { check.frame = CGRect(x: M.padding, y: bounds.midY - M.check / 2, width: M.check, height: M.check) }
            if let first = line.trailing.first { gauges.first?.frame = first }
        case .heading(let service, let account, let gaugeModels, let opens, _):
            // The account gives way first, then the service.
            var leading = [Piece(StemCellPickerType.size(service, StemCellPickerType.service), shrinks: true)]
            if let account { leading.append(Piece(StemCellPickerType.size(account, StemCellPickerType.account), maxWidth: M.accountMax, shrinks: true, gapBefore: M.headingGap)) }
            var trailing: [Piece] = []
            if opens != nil { trailing.append(Piece(CGSize(width: M.chevron, height: M.chevron))) }
            for (index, gauge) in gaugeModels.enumerated().reversed() {
                let gap = index == gaugeModels.count - 1 ? M.headingGap : M.usageGap
                trailing.append(Piece(StemCellPickerType.gaugeSize(gauge), gapBefore: gap))
            }
            let line = StemCellPickerLineLayout(line: bounds, leading: leading, trailing: trailing, trailingGap: M.headingGap)
            title.frame = line.leading[0]
            if account != nil { detail.frame = line.leading[1] }
            var placed = line.trailing[...]
            if opens != nil { chevron.frame = placed.removeFirst() }
            for (view, frame) in zip(gauges.reversed(), placed) { view.frame = frame }
        case .link(_, let label):
            title.frame = StemCellPickerLineLayout(line: named, leading: [Piece(StemCellPickerType.size(label, StemCellPickerType.link), shrinks: true)]).leading[0]
        case .notice:
            title.frame = named.insetBy(dx: M.padding, dy: M.detailsInsetY)
        case .separator:
            break
        case .windows:
            var y = M.detailsInsetY
            for row in rows {
                let height = row.window.primary ? M.detailsPrimaryLine : M.detailsLine
                let band = CGRect(x: 0, y: y, width: bounds.width, height: height)
                var trailing: [Piece] = []
                if let gauge = row.gauge { trailing.append(Piece(gauge.layout.size)) }
                var leading = [Piece(StemCellPickerType.size(row.window.label, row.label.font), shrinks: row.window.resets == nil)]
                if row.window.resets != nil {
                    leading[0].size.width = max(leading[0].size.width, M.detailsLabelMin)
                    leading.append(Piece(StemCellPickerType.size(row.window.resets ?? "", row.resets.font), shrinks: true, gapBefore: M.detailsGap))
                }
                let line = StemCellPickerLineLayout(line: band, leading: leading, trailing: trailing, trailingGap: M.detailsGap)
                row.label.frame = line.leading[0]
                if line.leading.count > 1 { row.resets.frame = line.leading[1] }
                if let gauge = row.gauge, let frame = line.trailing.first { gauge.frame = frame }
                y += height + M.gap
            }
        }
    }
}

/// A panel as iOS's menus: liquid glass with its soft shadow under it, its
/// lines scrolling in its viewport, and its footer under them.
final class StemCellPickerPanelView: UIView {
    typealias M = StemCellPickerMetrics
    let scrollView = LinesScrollView()
    /// The glass, its lines in its content; it comes and goes as the
    /// material does (`effect` to and from nil), never by its alpha.
    let glass = UIVisualEffectView(effect: nil)
    private let effect = UIGlassEffect(style: .regular)
    private(set) var content: StemCellPickerContent?
    private(set) var layout: StemCellPickerPanelLayout?
    var onTap: ((StemCellPickerContent.Line) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // Its label, "Select model", read as VoiceOver enters it.
        accessibilityContainerType = .semanticGroup
        layer.shadowOpacity = 1
        layer.shadowRadius = M.shadowRadius
        layer.shadowOffset = CGSize(width: 0, height: M.shadowY)
        glass.effect = effect
        glass.cornerConfiguration = .corners(radius: .fixed(M.radius))
        glass.clipsToBounds = true
        addSubview(glass)
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.alwaysBounceVertical = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.delaysContentTouches = false
        glass.contentView.addSubview(scrollView)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        applyColors()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        layer.shadowColor = UIColor(Palette.stemCellsPanelShadow).resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: M.radius).cgPath
    }

    /// The glass forms, the lines and the shadow come up with it; or all go.
    func materialize(_ shown: Bool) {
        glass.effect = shown ? effect : nil
        glass.contentView.alpha = shown ? 1 : 0
        let shadow = CABasicAnimation(keyPath: "shadowOpacity")
        shadow.fromValue = layer.presentation()?.shadowOpacity ?? layer.shadowOpacity
        layer.removeAnimation(forKey: "shadowOpacity")
        layer.shadowOpacity = shown ? 1 : 0
        shadow.toValue = layer.shadowOpacity
        shadow.duration = UIView.inheritedAnimationDuration
        if shadow.duration > 0 { layer.add(shadow, forKey: "shadowOpacity") }
    }

    /// Shows `content` where `layout` puts it. Opened, the lines stand at
    /// the layout's first offset; redrawn, they keep where they were.
    /// The same lines are moved, not made again: a finger down on one, or
    /// VoiceOver on it, stays through a redraw.
    func apply(_ content: StemCellPickerContent, layout: StemCellPickerPanelLayout, opening: Bool) {
        if !opening, content == self.content, layout == self.layout { return }
        let offset = scrollView.contentOffset.y
        let same = content == self.content
        self.content = content
        self.layout = layout
        accessibilityIdentifier = content.id
        accessibilityLabel = content.label
        setLayoutFrame(layout.frame)
        scrollView.frame = layout.viewport
        scrollView.contentSize = CGSize(width: layout.viewport.width, height: layout.contentHeight)
        if same {
            for (view, frame) in zip(lineViews(in: scrollView), layout.items) { place(view, frame) }
            for (view, frame) in zip(lineViews(in: glass.contentView), layout.footer) { place(view, frame) }
        } else {
            (lineViews(in: scrollView) + lineViews(in: glass.contentView)).forEach { $0.removeFromSuperview() }
            for (line, frame) in zip(content.lines, layout.items) { add(line, frame, to: scrollView) }
            for (line, frame) in zip(content.footer, layout.footer) { add(line, frame, to: glass.contentView) }
        }
        let scrolls = max(0, layout.contentHeight - layout.viewport.height)
        scrollView.contentOffset.y = opening ? layout.initialOffset : min(scrolls, offset)
        scrollView.isScrollEnabled = scrolls > 0
    }

    private func lineViews(in host: UIView) -> [StemCellPickerLineView] {
        host.subviews.compactMap { $0 as? StemCellPickerLineView }
    }

    private func place(_ view: StemCellPickerLineView, _ frame: CGRect) {
        // A hairline spans the text column, `padding` in from the line's sides.
        view.frame = view.line == .separator ? frame.insetBy(dx: M.padding, dy: 0) : frame
    }

    private func add(_ line: StemCellPickerContent.Line, _ frame: CGRect, to host: UIView) {
        let view = StemCellPickerLineView(line)
        place(view, frame)
        let line = view.line
        view.addAction(UIAction { [weak self] _ in self?.onTap?(line) }, for: .touchUpInside)
        host.addSubview(view)
    }
}

/// A drag that starts on a line scrolls the lines: a line is a control, and
/// a scroll view leaves a control its touch by default.
final class LinesScrollView: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

/// The panels over the screen: a touch outside the top one closes it (a
/// stacked one alone, the panel under it staying), as desktop's backdrop.
final class StemCellPickerOverlay: UIView, UIGestureRecognizerDelegate {
    private(set) var panels: [StemCellPickerPanelView] = []
    var onOutside: (() -> Void)?
    var onLayout: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "stem-picker-overlay"
        let tap = UITapGestureRecognizer(target: self, action: #selector(outside))
        tap.delegate = self
        addGestureRecognizer(tap)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Only a touch on the overlay itself: a panel's lines keep theirs.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        touch.view === self
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if let top = panels.last, top.frame.contains(point) { return super.hitTest(point, with: event) }
        return isUserInteractionEnabled ? self : nil
    }

    /// How long a panel takes to dissolve.
    static let popDuration: TimeInterval = 0.16

    @objc private func outside() { onOutside?() }

    override func accessibilityPerformEscape() -> Bool {
        onOutside?()
        return true
    }

    /// A panel on top, placed before it is first drawn.
    func push(_ panel: StemCellPickerPanelView) {
        panels.append(panel)
        addSubview(panel)
    }

    /// The panel grows in from its bottom trailing corner, where its chip
    /// is, its glass forming as it does.
    func grow(_ panel: StemCellPickerPanelView) {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        UIView.performWithoutAnimation { panel.materialize(false) }
        panel.transform = CGAffineTransform(scaleX: 0.9, y: 0.9).translatedBy(x: panel.bounds.width * 0.05, y: panel.bounds.height * 0.05)
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
            panel.materialize(true)
            panel.transform = .identity
        }
    }

    func pop(animated: Bool) {
        guard let panel = panels.popLast() else { return }
        // Gone for VoiceOver and for a lookup by its name as it fades.
        panel.accessibilityViewIsModal = false
        panel.accessibilityElementsHidden = true
        panel.accessibilityIdentifier = nil
        guard animated else { return panel.removeFromSuperview() }
        UIView.animate(withDuration: Self.popDuration, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
            panel.materialize(false)
            panel.transform = .identity
        } completion: { _ in panel.removeFromSuperview() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}
#endif
