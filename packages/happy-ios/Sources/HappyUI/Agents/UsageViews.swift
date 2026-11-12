#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings › Usage's type, measured where the layouts need it.
@MainActor
enum UsageType {
    typealias M = UsageMetrics
    static let title = Fonts.ui(.semiBold, size: M.titleSize)
    static let subtitle = Fonts.ui(.regular, size: M.subtitleSize)
    static let name = Fonts.ui(.semiBold, size: M.nameSize)
    static let plan = Fonts.ui(.regular, size: M.planSize)
    static let line = Fonts.ui(.regular, size: M.lineSize)
    static let modelId = Fonts.mono(bold: false, size: M.modelIdSize)
    static let totals = Fonts.tabular(Fonts.ui(.regular, size: M.modelSize))
    static let month = Fonts.ui(.regular, size: M.monthSize)
    static let weekday = Fonts.ui(.regular, size: M.weekdaySize)
    static let calloutTitle = Fonts.ui(.semiBold, size: M.calloutSize)
    static let calloutText = Fonts.tabular(Fonts.ui(.regular, size: M.calloutSize))
    static let calloutId = Fonts.mono(bold: false, size: M.calloutIdSize)
    static let emptyTitle = Fonts.ui(.semiBold, size: 17)
    static let emptyBody = Fonts.ui(.regular, size: 15)

    static func size(_ text: String, _ font: UIFont) -> CGSize {
        let size = (text as NSString).size(withAttributes: [.font: font])
        return CGSize(width: ceil(size.width), height: ceil(font.lineHeight))
    }

    /// The weekday column: as wide as its widest name.
    static var weekdayWidth: CGFloat { Strings.Usage.weekdays.map { size($0, weekday).width }.max() ?? 0 }
}

/// The cells of a grid, each shaded by its level, the tapped one outlined;
/// the months' names over their columns.
final class UsagePlotView: UIView {
    private(set) var layout = UsageGridLayout(count: 0, firstWeekday: 0, variant: .year)
    private(set) var levels: [Int] = []
    private var months: [UILabel] = []
    var selected: Int? {
        didSet { if selected != oldValue { setNeedsDisplay() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsDisplay() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ layout: UsageGridLayout, levels: [Int], months names: [String]) {
        self.layout = layout
        self.levels = levels
        while months.count < layout.months.count {
            let label = UILabel()
            label.font = UsageType.month
            label.textColor = UIColor(Palette.settingsSecondary)
            addSubview(label)
            months.append(label)
        }
        while months.count > layout.months.count { months.removeLast().removeFromSuperview() }
        for (label, month) in zip(months, layout.months) {
            label.text = names.indices.contains(month.index) ? names[month.index] : nil
            label.setLayoutFrame(month.frame)
        }
        setNeedsDisplay()
    }

    /// The months' names shown, left to right: for the tests.
    var monthNames: [String] { months.compactMap(\.text) }

    override func draw(_ rect: CGRect) {
        let accent = UIColor(Palette.usageActivity).resolvedColor(with: traitCollection)
        let none = UIColor(Palette.usageActivityNone).resolvedColor(with: traitCollection)
        for (index, cell) in layout.cells.enumerated() where cell.intersects(rect) {
            let level = levels.indices.contains(index) ? levels[index] : 0
            (level == 0 ? none : accent.withAlphaComponent(UsageMetrics.levelAlpha[min(4, level)])).setFill()
            UIBezierPath(roundedRect: cell, cornerRadius: UsageMetrics.cellRadius).fill()
        }
        if let selected, layout.cells.indices.contains(selected) {
            UIColor(Palette.usageActivitySelected).resolvedColor(with: traitCollection).setStroke()
            let outline = UIBezierPath(roundedRect: layout.cells[selected].insetBy(dx: 0.5, dy: 0.5), cornerRadius: UsageMetrics.cellRadius)
            outline.lineWidth = 1
            outline.stroke()
        }
    }
}

/// Desktop's `UsageActivityGrid`: the year (week columns, the weekday
/// column beside them) or an account's 30-day strip. Too wide for its box,
/// the weeks scroll sideways and open on today.
final class UsageGridView: UIView, UIScrollViewDelegate {
    let variant: UsageGridLayout.Variant
    let viewport = UIScrollView()
    let plot = UsagePlotView()
    private var weekdays: [UILabel] = []
    private(set) var days: [UsageActivityDay] = []
    private(set) var layout: UsageGridLayout
    /// Set until the weeks have been shown at today since they or the
    /// box's width last changed.
    private var opensOnToday = true
    private var openedWidth: CGFloat = -1
    /// A finger started scrolling the weeks.
    var onScroll: (() -> Void)?

    init(variant: UsageGridLayout.Variant) {
        self.variant = variant
        layout = UsageGridLayout(count: 0, firstWeekday: 0, variant: variant)
        super.init(frame: .zero)
        viewport.showsHorizontalScrollIndicator = false
        viewport.showsVerticalScrollIndicator = false
        viewport.alwaysBounceVertical = false
        viewport.scrollsToTop = false
        viewport.delegate = self
        viewport.addSubview(plot)
        addSubview(viewport)
        if variant == .year {
            for name in Strings.Usage.weekdays {
                let label = UILabel()
                label.font = UsageType.weekday
                label.textColor = UIColor(Palette.settingsSecondary)
                label.text = name
                addSubview(label)
                weekdays.append(label)
            }
        }
        isAccessibilityElement = true
        accessibilityTraits = .image
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ days: [UsageActivityDay], label: String) {
        accessibilityLabel = label
        guard days != self.days else { return }
        if days.first?.date != self.days.first?.date || days.count != self.days.count { opensOnToday = true }
        self.days = days
        let starts = variant == .year ? days.indices.filter { $0 == 0 || days[$0].date.hasSuffix("-01") } : []
        let names = starts.map { Strings.Usage.month(days[$0].date) }
        layout = UsageGridLayout(
            count: days.count, firstWeekday: days.first.map { UsageDates.weekday($0.date) } ?? 0, variant: variant,
            monthStarts: starts, monthWidths: names.map { UsageType.size($0, UsageType.month).width }, weekdayWidth: UsageType.weekdayWidth
        )
        plot.selected = nil
        plot.show(layout, levels: UsageActivityDay.levels(days), months: names)
        setNeedsLayout()
    }

    var height: CGFloat { layout.plot.height }

    override func layoutSubviews() {
        super.layoutSubviews()
        let frame = UsageGridFrame(grid: layout, width: bounds.width, weekdayWidth: UsageType.weekdayWidth)
        for (label, row) in zip(weekdays, layout.weekdays) {
            label.setLayoutFrame(row.offsetBy(dx: frame.weekdays.minX, dy: frame.weekdays.minY))
        }
        viewport.setLayoutFrame(frame.viewport)
        viewport.contentSize = layout.plot
        plot.setLayoutFrame(CGRect(origin: .zero, size: layout.plot))
        if opensOnToday || openedWidth != frame.viewport.width {
            opensOnToday = false
            openedWidth = frame.viewport.width
            viewport.contentOffset = CGPoint(x: frame.offset, y: 0)
        }
    }

    /// The day under `point`, in this view's space.
    func day(at point: CGPoint) -> Int? {
        guard viewport.frame.contains(point) else { return nil }
        return layout.day(at: convert(point, to: plot))
    }

    /// Day `index`'s cell in `view`'s space.
    func cell(_ index: Int, in view: UIView) -> CGRect {
        plot.convert(layout.cells[index], to: view)
    }

    var selected: Int? {
        get { plot.selected }
        set { plot.selected = newValue }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { onScroll?() }
}

/// The day's callout: its date, its total, the models that spent most.
final class UsageCalloutView: UIView {
    private let title = UILabel()
    private let total = UILabel()
    private var models: [(id: UILabel, value: UILabel)] = []
    private(set) var day: UsageActivityDay?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        accessibilityIdentifier = "usage-callout"
        layer.cornerRadius = UsageMetrics.calloutRadius
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.shadowOffset = CGSize(width: 0, height: 2)
        layer.shadowRadius = 8
        layer.shadowOpacity = 1
        title.font = UsageType.calloutTitle
        total.font = UsageType.calloutText
        for label in [title, total] { addSubview(label) }
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        backgroundColor = UIColor(Palette.usageCallout)
        layer.borderColor = UIColor(Palette.usageCalloutBorder).resolvedColor(with: traitCollection).cgColor
        layer.shadowColor = UIColor(Palette.usageCalloutShadow).resolvedColor(with: traitCollection).cgColor
        title.textColor = UIColor(Palette.settingsText)
        total.textColor = UIColor(Palette.settingsText)
        for model in models {
            model.id.textColor = UIColor(Palette.settingsSecondary)
            model.value.textColor = UIColor(Palette.settingsSecondary)
        }
    }

    func show(_ day: UsageActivityDay) {
        self.day = day
        title.text = Strings.Usage.callout(day.date)
        total.text = day.tokens > 0 ? Strings.Usage.tokens(day.tokens) : Strings.Usage.noUsage
        let shown = Array(day.models.prefix(3))
        while models.count < shown.count {
            let id = UILabel()
            id.font = UsageType.calloutId
            id.lineBreakMode = .byTruncatingTail
            let value = UILabel()
            value.font = UsageType.calloutText
            addSubview(id)
            addSubview(value)
            models.append((id, value))
        }
        while models.count > shown.count {
            let model = models.removeLast()
            model.id.removeFromSuperview()
            model.value.removeFromSuperview()
        }
        for (labels, model) in zip(models, shown) {
            labels.id.text = model.id
            labels.value.text = UsageOverview.compact(model.tokens)
        }
        applyColors()
        accessibilityLabel = ([title.text, total.text] + shown.map { "\($0.id) \(UsageOverview.compact($0.tokens))" }).compactMap { $0 }.joined(separator: ", ")
    }

    /// Over `cell`, inside `bounds`, both in the superview's space.
    func place(over cell: CGRect, in bounds: CGRect) {
        let layout = UsageCalloutLayout(
            cell: cell, bounds: bounds, title: UsageType.size(title.text ?? "", UsageType.calloutTitle), total: UsageType.size(total.text ?? "", UsageType.calloutText),
            models: models.map { (UsageType.size($0.id.text ?? "", UsageType.calloutId), UsageType.size($0.value.text ?? "", UsageType.calloutText)) }
        )
        setLayoutFrame(layout.frame)
        title.setLayoutFrame(layout.title)
        total.setLayoutFrame(layout.total)
        for (labels, line) in zip(models, layout.models) {
            labels.id.setLayoutFrame(line.id)
            labels.value.setLayoutFrame(line.value)
        }
        layer.shadowPath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: layout.frame.size), cornerRadius: UsageMetrics.calloutRadius).cgPath
    }

    /// What it says, top to bottom: for the tests.
    var texts: [String] { ([title, total] + models.flatMap { [$0.id, $0.value] }).compactMap(\.text) }
}

/// One account in its service's card: its name and plan, its last 30
/// days, its plan's windows with how current they are, and its models.
final class UsageAccountView: UIView {
    let id: String
    private let name = UILabel()
    private let plan = UILabel()
    let strip = UsageGridView(variant: .strip)
    private var limits: [(label: UILabel, resets: UILabel, gauge: UsageGaugeView)] = []
    private var notes: [UILabel] = []
    private var models: [(id: UILabel, totals: UILabel)] = []
    private var details: [PickerContent.Window] = []
    private(set) var account: UsageOverview.Account?

    init(id: String) {
        self.id = id
        super.init(frame: .zero)
        accessibilityIdentifier = "usage-account:\(id)"
        name.font = UsageType.name
        name.lineBreakMode = .byTruncatingTail
        plan.font = UsageType.plan
        plan.lineBreakMode = .byTruncatingTail
        strip.accessibilityIdentifier = "usage-strip:\(id)"
        for view in [name, plan, strip] as [UIView] { addSubview(view) }
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        let text = UIColor(Palette.settingsText)
        let secondary = UIColor(Palette.settingsSecondary)
        name.textColor = text
        plan.textColor = secondary
        for row in limits {
            row.label.textColor = text
            row.resets.textColor = text
        }
        for (label, line) in zip(notes, details.filter { $0.gauge == nil }) {
            label.textColor = line.critical ? UIColor(Palette.usageCritical) : text
        }
        for model in models {
            model.id.textColor = secondary
            model.totals.textColor = secondary
        }
    }

    func show(_ account: UsageOverview.Account, now: Date) {
        self.account = account
        name.text = account.name
        plan.text = account.plan
        plan.isHidden = account.plan == nil
        strip.isHidden = account.strip == nil
        if let days = account.strip { strip.show(days, label: Strings.Usage.stripLabel(account.name)) }
        details = account.usage.map { ModelPickers.details($0, now: now) } ?? []
        let windows = details.filter { $0.gauge != nil }
        let lines = details.filter { $0.gauge == nil }
        while limits.count < windows.count {
            let label = UILabel()
            let resets = UILabel()
            for part in [label, resets] {
                part.font = UsageType.line
                part.lineBreakMode = .byTruncatingTail
                addSubview(part)
            }
            let gauge = UsageGaugeView()
            addSubview(gauge)
            limits.append((label, resets, gauge))
        }
        while limits.count > windows.count {
            let row = limits.removeLast()
            [row.label, row.resets, row.gauge].forEach { $0.removeFromSuperview() }
        }
        for (row, window) in zip(limits, windows) {
            row.label.text = window.label
            row.resets.text = window.resets
            row.resets.isHidden = window.resets == nil
            if let gauge = window.gauge {
                row.gauge.configure(PickerContent.Gauge(text: Strings.percentLeft(gauge.left), left: gauge.left, tone: gauge.tone), strong: true)
            }
        }
        while notes.count < lines.count {
            let label = UILabel()
            label.font = UsageType.line
            label.lineBreakMode = .byTruncatingTail
            addSubview(label)
            notes.append(label)
        }
        while notes.count > lines.count { notes.removeLast().removeFromSuperview() }
        for (label, line) in zip(notes, lines) { label.text = line.label }
        while models.count < account.models.count {
            let id = UILabel()
            id.font = UsageType.modelId
            id.lineBreakMode = .byTruncatingTail
            let totals = UILabel()
            totals.font = UsageType.totals
            totals.textAlignment = .right
            addSubview(id)
            addSubview(totals)
            models.append((id, totals))
        }
        while models.count > account.models.count {
            let model = models.removeLast()
            model.id.removeFromSuperview()
            model.totals.removeFromSuperview()
        }
        for (labels, model) in zip(models, account.models) {
            labels.id.text = model.id
            labels.totals.text = Strings.Usage.modelTotals(model)
            labels.totals.accessibilityLabel = "\(model.id): \(Strings.Usage.modelTotals(model))"
        }
        applyColors()
        setNeedsLayout()
    }

    func layout(width: CGFloat) -> UsageAccountLayout {
        UsageAccountLayout(
            width: width, name: UsageType.size(name.text ?? "", UsageType.name),
            plan: plan.isHidden ? nil : UsageType.size(plan.text ?? "", UsageType.plan),
            stripHeight: strip.isHidden ? nil : strip.height,
            limits: limits.map { row in
                UsageAccountLayout.LimitSpec(
                    label: UsageType.size(row.label.text ?? "", UsageType.line),
                    resets: row.resets.isHidden ? nil : UsageType.size(row.resets.text ?? "", UsageType.line),
                    gauge: row.gauge.layout.size
                )
            },
            notes: notes.count,
            models: models.map { (UsageType.size($0.id.text ?? "", UsageType.modelId), UsageType.size($0.totals.text ?? "", UsageType.totals)) }
        )
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        name.setLayoutFrame(layout.name)
        if let frame = layout.plan { plan.setLayoutFrame(frame) }
        if let frame = layout.strip { strip.setLayoutFrame(frame) }
        for (row, frame) in zip(limits, layout.limits) {
            row.label.setLayoutFrame(frame.label)
            if let resets = frame.resets { row.resets.setLayoutFrame(resets) }
            row.gauge.setLayoutFrame(frame.gauge)
        }
        for (label, frame) in zip(notes, layout.notes) { label.setLayoutFrame(frame) }
        for (labels, frame) in zip(models, layout.models) {
            labels.id.setLayoutFrame(frame.id)
            labels.totals.setLayoutFrame(frame.totals)
        }
    }

    /// What it says: for the tests.
    var texts: [String] {
        ([name, plan] + limits.flatMap { [$0.label, $0.resets] } + notes + models.flatMap { [$0.id, $0.totals] })
            .filter { !$0.isHidden }.compactMap(\.text)
    }
}
#endif
