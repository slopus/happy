#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings › Connection, for either kind of account: how it reaches its
/// server or computer and how that link stands (the headers' own state),
/// what went over it in the last ten minutes, Tailcat's tunnel for a
/// computer, and Copy Diagnostics.
///
/// It reads the account's recorder (`ConnectionMetrics`) once a second
/// while it is on screen, off the main thread, and redraws only when what
/// it shows changed; off screen it reads nothing. The recorder itself
/// counts whether or not this page is open.
final class ConnectionViewController: UIViewController {
    enum Source {
        case agent(id: String)
        case legacy(AccountSession)
    }

    private let context: AppContext
    private let source: Source
    private let metrics: ConnectionMetrics?
    private var state: LinkState = .connecting
    private var stateWatch: Watch?
    private var snapshot = ConnectionSnapshot()
    /// What the page shows now: for the tests, which read the page.
    private(set) var page: ConnectionPage?
    /// Snapshots read and applied, for tests.
    private(set) var refreshes = 0
    private var timer: Timer?
    private var visible = false
    /// The recorder read in flight, cancelled when this appearance ends.
    private(set) var refreshTask: Task<Void, Never>?
    private var copiedUntil: Date?

    private let scroll = UIScrollView()
    private var headers: [UILabel] = []
    private var cards: [ConnectionCardView] = []
    private var footers: [UILabel] = []
    private(set) var connectionLayout = ConnectionLayout(width: 0, cards: [])

    static let titleFont = Fonts.ui(.regular, size: 17)
    static let noteFont = Fonts.ui(.regular, size: 13)

    init(context: AppContext, source: Source) {
        self.context = context
        self.source = source
        switch source {
        case .agent(let id): metrics = context.account.agentConnections.metrics(for: id)
        case .legacy(let session): metrics = session.metrics
        }
        super.init(nibName: nil, bundle: nil)
        title = Strings.Connection.title
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "connection"
        navigationItem.largeTitleDisplayMode = .never
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        switch source {
        case .agent(let id):
            stateWatch = Session.session(for: id, context: context)?.watchHeader { [weak self] in self?.receive(state: $0) }
        case .legacy(let session):
            stateWatch = LegacyLink.link(for: session).watch { [weak self] in self?.receive(state: $0) }
        }
        rebuild()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        visible = true
        refresh()
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer.tolerance = 0.2
        // Common modes: the numbers keep moving while a finger scrolls.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        visible = false
        timer?.invalidate()
        timer = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    /// Whether the page is reading the recorder: only while it shows.
    var isTicking: Bool { timer != nil }

    private func receive(state: LinkState) {
        guard state != self.state else { return }
        self.state = state
        rebuild()
    }

    /// Reads the recorder off the main thread, then shows what it said.
    func refresh() {
        guard visible, refreshTask == nil, let metrics else { return }
        refreshTask = Task { @MainActor [weak self] in
            let snapshot = await Task.detached(priority: .utility) { await metrics.snapshot() }.value
            // The recorder's tunnel may finish even after cancellation. An
            // old appearance must not apply or clear a newer read's handle.
            guard !Task.isCancelled, let self, visible else { return }
            refreshTask = nil
            refreshes += 1
            self.snapshot = snapshot
            rebuild()
        }
    }

    private var inputs: ConnectionPage.Inputs {
        let kind: ConnectionPage.Kind = switch source {
        case .agent(let id): .agent(name: context.account.agentConnections.accounts.first { $0.id == id }?.name ?? Strings.agentConnection)
        case .legacy(let session): .legacy(serverURL: session.serverURL, socketURL: session.socketURL)
        }
        return ConnectionPage.Inputs(kind: kind, state: state, network: NetworkPath.shared.details, snapshot: snapshot,
                                     version: context.version, variant: "\(context.variant)")
    }

    private func rebuild() {
        guard isViewLoaded else { return }
        var next = ConnectionPage.make(inputs)
        if let until = copiedUntil, until > Date(), let card = next.cards.firstIndex(where: { $0.id == "copy" }) {
            next.cards[card].rows[0].value = Strings.Connection.copied
        }
        guard next != page else { return }
        page = next
        show(next)
    }

    // MARK: Views

    private func show(_ page: ConnectionPage) {
        func label(_ font: UIFont) -> UILabel {
            let label = UILabel()
            label.font = font
            label.textColor = UIColor(Palette.settingsSecondary)
            label.numberOfLines = 0
            scroll.addSubview(label)
            return label
        }
        while cards.count < page.cards.count {
            headers.append(label(Self.noteFont))
            let card = ConnectionCardView()
            card.tapped = { [weak self] id in self?.tapRow(id) }
            scroll.addSubview(card)
            cards.append(card)
            footers.append(label(Self.noteFont))
        }
        while cards.count > page.cards.count {
            headers.removeLast().removeFromSuperview()
            cards.removeLast().removeFromSuperview()
            footers.removeLast().removeFromSuperview()
        }
        for (index, card) in page.cards.enumerated() {
            headers[index].text = card.header?.uppercased()
            headers[index].isHidden = card.header == nil
            footers[index].text = card.footer
            footers[index].isHidden = card.footer == nil
            cards[index].set(card.rows)
        }
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let page else { return }
        scroll.frame = view.bounds
        let width = view.bounds.width
        let layout = ConnectionLayout(width: width, cards: page.cards.map { card in
            ConnectionLayout.CardSpec(
                header: card.header.map { Self.measured($0.uppercased(), Self.noteFont) },
                rows: card.rows.map { row in
                    let title = Self.line(row.title, Self.titleFont)
                    guard row.chart == nil else { return .chart(title: title, caption: row.value.map { Self.line($0, Self.noteFont) }) }
                    return .text(title: title, value: row.value.map { Self.line($0, Self.titleFont) })
                },
                footer: card.footer.map { Self.measured($0, Self.noteFont) }
            )
        })
        connectionLayout = layout
        for (index, card) in layout.cards.enumerated() where cards.indices.contains(index) {
            if let frame = card.header { headers[index].frame = frame }
            if let frame = card.footer { footers[index].frame = frame }
            cards[index].frame = card.frame
            cards[index].apply(card.rows)
        }
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    /// `text` on one line in `font`, its whole width; the layout cuts it.
    static func line(_ text: String, _ font: UIFont) -> Measurable {
        let size = (text as NSString).size(withAttributes: [.font: font])
        return .fixed(width: ceil(size.width), height: ceil(font.lineHeight))
    }

    /// `text` as a label in `font` draws it, wrapped at the width offered.
    static func measured(_ text: String, _ font: UIFont) -> Measurable {
        Measurable { width in
            let rect = (text as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil)
            return CGSize(width: min(width, ceil(rect.width)), height: ceil(rect.height))
        }
    }

    // MARK: Actions

    /// Runs the row `id`'s action, as a finger on it would.
    func tapRow(_ id: String) {
        guard id == "copy", let page else { return }
        UIPasteboard.general.string = page.diagnostics
        Haptics.play(.pick)
        copiedUntil = Date().addingTimeInterval(2)
        rebuild()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.05) { [weak self] in self?.rebuild() }
    }
}

/// One card: its rows' titles and values, hairlines between them, and a
/// sparkline in a chart row. A tap on an action row says its id.
final class ConnectionCardView: UIView {
    private final class RowView: UIControl {
        let title = UILabel()
        let value = UILabel()
        let separator = UIView()
        var sparkline: SparklineView?

        override init(frame: CGRect) {
            super.init(frame: frame)
            title.font = ConnectionViewController.titleFont
            title.lineBreakMode = .byTruncatingTail
            value.font = ConnectionViewController.titleFont
            value.textColor = UIColor(Palette.settingsSecondary)
            value.textAlignment = .right
            value.lineBreakMode = .byTruncatingMiddle
            separator.backgroundColor = UIColor(Palette.settingsSeparator)
            for view in [title, value, separator] { view.isUserInteractionEnabled = false; addSubview(view) }
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        override var isHighlighted: Bool {
            didSet { backgroundColor = isHighlighted ? UIColor(Palette.settingsSeparator).withAlphaComponent(0.4) : nil }
        }
    }

    private var rows: [ConnectionPage.Row] = []
    private var views: [RowView] = []
    var tapped: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsCard)
        layer.cornerRadius = ConnectionLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func set(_ rows: [ConnectionPage.Row]) {
        self.rows = rows
        while views.count < rows.count {
            let view = RowView()
            view.addTarget(self, action: #selector(rowTapped(_:)), for: .touchUpInside)
            addSubview(view)
            views.append(view)
        }
        while views.count > rows.count { views.removeLast().removeFromSuperview() }
        for (view, row) in zip(views, rows) {
            view.title.text = row.title
            view.title.textColor = UIColor(row.isAction ? Palette.settingsPrimary : Palette.settingsText)
            view.value.text = row.value
            view.value.font = row.chart == nil ? ConnectionViewController.titleFont : ConnectionViewController.noteFont
            view.isUserInteractionEnabled = row.isAction
            view.accessibilityIdentifier = "connection-\(row.id)"
            view.isAccessibilityElement = true
            view.accessibilityLabel = row.title
            view.accessibilityValue = row.value
            view.accessibilityTraits = row.isAction ? .button : .staticText
            if let chart = row.chart {
                if view.sparkline == nil {
                    let sparkline = SparklineView()
                    sparkline.isUserInteractionEnabled = false
                    view.addSubview(sparkline)
                    view.sparkline = sparkline
                }
                view.sparkline?.values = chart
            } else {
                view.sparkline?.removeFromSuperview()
                view.sparkline = nil
            }
        }
    }

    /// The layout's rows: each box in this card, its parts in the box.
    func apply(_ layout: [ConnectionLayout.Row]) {
        for (view, row) in zip(views, layout) {
            view.frame = row.box
            view.title.frame = row.title
            view.value.frame = row.value ?? .zero
            view.separator.isHidden = row.separator == nil
            view.separator.frame = row.separator ?? .zero
            view.sparkline?.frame = row.chart ?? .zero
        }
    }

    @objc private func rowTapped(_ sender: UIControl) {
        guard let index = views.firstIndex(where: { $0 === sender }), rows.indices.contains(index) else { return }
        tapped?(rows[index].id)
    }
}

/// Bytes per minute as bars (`SparklineLayout`), drawn with Core Graphics:
/// a minute with traffic in the tint, a quiet one as a grey stub.
final class SparklineView: UIView {
    var values: [Int64] = [] {
        didSet { if values != oldValue { setNeedsDisplay() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SparklineView, _) in view.setNeedsDisplay() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let bars = SparklineLayout.bars(values, in: bounds.size)
        let busy = UIColor(Palette.settingsPrimary).resolvedColor(with: traitCollection).cgColor
        let quiet = UIColor(Palette.settingsSeparator).resolvedColor(with: traitCollection).cgColor
        for (bar, value) in zip(bars, values) {
            context.setFillColor(value > 0 ? busy : quiet)
            context.addPath(UIBezierPath(roundedRect: bar, cornerRadius: min(2, bar.width / 2)).cgPath)
            context.fillPath()
        }
    }
}
#endif
