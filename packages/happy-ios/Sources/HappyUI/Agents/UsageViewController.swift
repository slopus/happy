#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Settings › Usage, as desktop's: a year of daily token totals over
/// everything ("Activity"), then each service's accounts, the most used
/// first, each with its last 30 days, its plan's windows and its models.
/// Tapping a day tells its date, its total and the models that spent most.
///
/// Only what can be shown is shown, and no failure is put into words: a
/// reading that fails keeps what was shown, and a server with no daily
/// history has no grid at all and is not asked again. Read when it shows,
/// again on usage and configuration events, and every minute while it does.
final class UsageViewController: UIViewController, UIGestureRecognizerDelegate {
    private let reader: any UsageReader
    private let daily: any DailyUsageSource
    private let store: Store?
    private let now: @MainActor () -> Date
    private let timeZone: TimeZone

    let scroll = UIScrollView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let emptyTitle = UILabel()
    private let emptyBody = UILabel()
    private let callout = UsageCalloutView()

    private let activityTitle = UILabel()
    private let activitySubtitle = UILabel()
    private let activityCard = UsageViewController.card()
    let activityGrid = UsageGridView(variant: .year)
    private typealias VendorSection = (name: String, title: UILabel, card: UIView, separators: [UIView])
    private var vendorViews: [VendorSection] = []
    private var accountViews: [String: UsageAccountView] = [:]

    /// What was last read; each kept when a later read fails.
    private var catalog: ModelCatalog?
    private var usage: JSONValue?
    private var history: DailyUsage?
    /// The server keeps no daily history: it isn't asked again.
    private var historyUnsupported = false
    private(set) var overview: UsageOverview?
    private var reading: Task<Void, Never>?
    private var readAgain = false
    private var following: Task<Void, Never>?
    private var polling: Task<Void, Never>?
    private var refreshed = false
    /// Something was read: until then, nothing is said, not even that
    /// there is nothing.
    private var readAnything = false
    /// The grid whose day the callout tells, and the day.
    private var selection: (grid: UsageGridView, index: Int)?

    init(reader: any UsageReader, daily: any DailyUsageSource, store: Store? = nil, timeZone: TimeZone = .current, now: @escaping @MainActor () -> Date = { Date() }) {
        self.reader = reader
        self.daily = daily
        self.store = store
        self.timeZone = timeZone
        self.now = now
        super.init(nibName: nil, bundle: nil)
        title = Strings.Usage.title
    }

    convenience init(session: Session) {
        self.init(reader: LiveUsageReader(client: session.client), daily: LiveDailyUsage(client: session.client), store: session.store)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        reading?.cancel()
        following?.cancel()
        polling?.cancel()
    }

    private static func card() -> UIView {
        let card = UIView()
        card.backgroundColor = UIColor(Palette.settingsCard)
        card.layer.cornerRadius = UsageMetrics.radius
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        return card
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "usage"
        view.backgroundColor = UIColor(Palette.settingsGround)
        navigationItem.largeTitleDisplayMode = .never
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        activityTitle.font = UsageType.title
        activityTitle.text = Strings.Usage.activity
        activityTitle.accessibilityTraits = .header
        activitySubtitle.font = UsageType.subtitle
        activityGrid.accessibilityIdentifier = "usage-activity"
        activityCard.addSubview(activityGrid)
        for subview in [activityTitle, activitySubtitle, activityCard] { scroll.addSubview(subview) }
        emptyTitle.font = UsageType.emptyTitle
        emptyBody.font = UsageType.emptyBody
        emptyBody.numberOfLines = 0
        for label in [emptyTitle, emptyBody] {
            label.textAlignment = .center
            view.addSubview(label)
        }
        view.addSubview(spinner)
        callout.isHidden = true
        scroll.addSubview(callout)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        scroll.addGestureRecognizer(tap)
        activityGrid.onScroll = { [weak self] in self?.select(nil) }
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
        show()
    }

    private func applyColors() {
        let text = UIColor(Palette.settingsText)
        let secondary = UIColor(Palette.settingsSecondary)
        activityTitle.textColor = text
        activitySubtitle.textColor = secondary
        emptyTitle.textColor = text
        emptyBody.textColor = secondary
        for vendor in vendorViews {
            vendor.title.textColor = text
            vendor.separators.forEach { $0.backgroundColor = UIColor(Palette.settingsSeparator) }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        read()
        follow()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        following?.cancel(); following = nil
        polling?.cancel(); polling = nil
        select(nil)
    }

    // MARK: Reading

    /// Reads everything, one read at a time; one asked for meanwhile runs
    /// once that one lands.
    func read() {
        guard reading == nil else { readAgain = true; return }
        let reader = reader
        let daily = daily
        let zone = timeZone.identifier
        let asksHistory = !historyUnsupported
        reading = Task { [weak self] in
            async let catalog = try? reader.catalog()
            async let usage = try? reader.usage()
            async let history: DailyUsageAnswer? = asksHistory ? daily.dailyUsage(days: UsageOverview.historyDays, timeZone: zone) : nil
            let (readCatalog, readUsage, readHistory) = await (catalog, usage, history)
            guard let self, !Task.isCancelled else { return }
            if let readCatalog { self.catalog = readCatalog }
            if let readUsage { self.usage = readUsage }
            switch readHistory {
            case .history(let read): self.history = read
            case .unsupported:
                historyUnsupported = true
                self.history = nil
            case .failed, nil: break
            }
            if readCatalog != nil || readUsage != nil || (readHistory != nil && readHistory != .failed) { readAnything = true }
            await build()
            if !refreshed, let ids = self.catalog?.providers.filter({ $0.enabled }).map(\.id), !ids.isEmpty {
                refreshed = true
                Task { await reader.refresh(ids) }
            }
            reading = nil
            if readAgain {
                readAgain = false
                read()
            }
        }
    }

    /// The overview, derived off the main thread, then shown if it changed.
    private func build() async {
        let catalog = catalog, usage = usage, history = history
        let today = UsageDates.day(now(), in: timeZone)
        overview = await Task.detached { UsageOverview.build(catalog: catalog, usage: usage, history: history, today: today) }.value
        // Shown even when nothing changed: "Updated 3 min ago" moves on
        // its own.
        show()
    }

    /// Reads again on usage and configuration events, and every minute.
    private func follow() {
        if following == nil, let store {
            following = Task { [weak self] in
                let events = await store.events(matching: ["provider.usage.", "config.updated"])
                for await _ in events {
                    guard !Task.isCancelled else { return }
                    self?.read()
                }
            }
        }
        if polling == nil {
            polling = Task { [weak self] in
                while (try? await Task.sleep(for: .seconds(60))) != nil {
                    self?.read()
                }
            }
        }
    }

    // MARK: Showing

    private func show() {
        guard isViewLoaded else { return }
        let overview = overview
        let loading = overview == nil
        let empty = readAnything && overview.map { $0.activity == nil && $0.vendors.isEmpty } ?? false
        if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
        emptyTitle.text = empty ? Strings.Usage.emptyTitle : nil
        emptyBody.text = empty ? Strings.Usage.emptyBody : nil
        emptyTitle.isHidden = !empty
        emptyBody.isHidden = !empty

        let activity = overview?.activity
        for subview in [activityTitle, activitySubtitle, activityCard] { subview.isHidden = activity == nil }
        if let activity {
            activitySubtitle.text = Strings.Usage.activity(activity.tokens, since: activity.since)
            activityGrid.show(activity.days, label: "\(Strings.Usage.gridLabel), \(activitySubtitle.text ?? "")")
        }

        let vendors = overview?.vendors ?? []
        let date = now()
        var kept: [String: UsageAccountView] = [:]
        var sections: [VendorSection] = []
        for vendor in vendors {
            let name = vendor.name ?? Strings.Usage.otherAccounts
            var section = vendorViews.first { $0.name == name } ?? { () -> VendorSection in
                let title = UILabel()
                title.font = UsageType.title
                title.accessibilityTraits = .header
                let card = Self.card()
                card.accessibilityIdentifier = "usage-section:\(name)"
                scroll.addSubview(title)
                scroll.addSubview(card)
                return (name, title, card, [])
            }()
            section.title.text = name
            for account in vendor.accounts {
                let view = accountViews[account.id] ?? {
                    let view = UsageAccountView(id: account.id)
                    view.strip.onScroll = { [weak self] in self?.select(nil) }
                    return view
                }()
                if view.superview !== section.card { section.card.addSubview(view) }
                view.show(account, now: date)
                kept[account.id] = view
            }
            let separators = max(0, vendor.accounts.count - 1)
            while section.separators.count < separators {
                let line = UIView()
                section.card.addSubview(line)
                section.separators.append(line)
            }
            while section.separators.count > separators { section.separators.removeLast().removeFromSuperview() }
            sections.append(section)
        }
        for (id, view) in accountViews where kept[id] == nil { view.removeFromSuperview() }
        for old in vendorViews where !sections.contains(where: { $0.name == old.name }) {
            old.title.removeFromSuperview()
            old.card.removeFromSuperview()
        }
        accountViews = kept
        vendorViews = sections
        applyColors()
        // The day told may be gone, or its numbers changed.
        if let selection, !selection.grid.isDescendant(of: scroll) || !selection.grid.days.indices.contains(selection.index) { select(nil) }
        else if let selection { select(selection) }
        scroll.bringSubviewToFront(callout)
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scroll.frame = view.bounds
        let width = scroll.readableColumn(width: view.bounds.width)
        let inner = UsagePageLayout.innerWidth(width)
        var specs: [UsagePageLayout.SectionSpec] = []
        let titleHeight = ceil(UsageType.title.lineHeight)
        if !activityCard.isHidden {
            specs.append(.init(title: titleHeight, subtitle: ceil(UsageType.subtitle.lineHeight), blocks: [activityGrid.height + 2 * UsageMetrics.padding]))
        }
        let accounts = vendorViews.map { section in
            (overview?.vendors.first { ($0.name ?? Strings.Usage.otherAccounts) == section.name }?.accounts ?? []).compactMap { accountViews[$0.id] }
        }
        let layouts = accounts.map { $0.map { $0.layout(width: inner) } }
        for layout in layouts { specs.append(.init(title: titleHeight, blocks: layout.map(\.height))) }
        let page = UsagePageLayout(width: width, sections: specs)
        var sections = page.sections[...]
        if !activityCard.isHidden, let section = sections.popFirst() {
            activityTitle.setLayoutFrame(section.title)
            if let subtitle = section.subtitle { activitySubtitle.setLayoutFrame(subtitle) }
            activityCard.setLayoutFrame(section.card)
            if let block = section.blocks.first {
                activityGrid.setLayoutFrame(CGRect(x: block.minX, y: block.minY + UsageMetrics.padding, width: block.width, height: activityGrid.height))
            }
        }
        for ((vendor, views), section) in zip(zip(vendorViews, accounts), sections) {
            vendor.title.setLayoutFrame(section.title)
            vendor.card.setLayoutFrame(section.card)
            for (view, block) in zip(views, section.blocks) { view.setLayoutFrame(block) }
            for (line, frame) in zip(vendor.separators, section.separators) { line.setLayoutFrame(frame) }
        }
        scroll.contentSize = CGSize(width: width, height: page.contentHeight)

        let insets = LayoutInsets(view.safeAreaInsets)
        let bodyWidth = max(0, view.bounds.width - 2 * UsageMetrics.emptySide)
        let body = ceil((emptyBody.text as NSString? ?? "").boundingRect(with: CGSize(width: bodyWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: UsageType.emptyBody], context: nil).height)
        let empty = UsageEmptyLayout(size: view.bounds.size, insets: insets, title: UsageType.size(emptyTitle.text ?? "", UsageType.emptyTitle), body: CGSize(width: bodyWidth, height: body))
        emptyTitle.setLayoutFrame(empty.title)
        emptyBody.setLayoutFrame(empty.body)
        spinner.center = CGPoint(x: view.bounds.midX, y: insets.top + (view.bounds.height - insets.top - insets.bottom) / 2)
        if let selection { place(selection) }
    }

    // MARK: The day's callout

    private var grids: [UsageGridView] {
        (activityCard.isHidden ? [] : [activityGrid]) + accountViews.values.filter { !$0.strip.isHidden }.map(\.strip)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        for grid in grids {
            if let index = grid.day(at: recognizer.location(in: grid)) {
                let same = selection.map { $0.grid === grid && $0.index == index } ?? false
                select(same ? nil : (grid, index))
                if !same { UIAccessibility.post(notification: .announcement, argument: callout.accessibilityLabel) }
                return
            }
        }
        select(nil)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    /// Tells day `index` of `grid`, as a finger on it would; nil puts the
    /// callout away.
    func select(_ day: (grid: UsageGridView, index: Int)?) {
        if let previous = selection, previous.grid !== day?.grid { previous.grid.selected = nil }
        selection = day
        guard let day, day.grid.days.indices.contains(day.index) else {
            selection = nil
            callout.isHidden = true
            return
        }
        day.grid.selected = day.index
        callout.show(day.grid.days[day.index])
        callout.isHidden = false
        place(day)
    }

    private func place(_ day: (grid: UsageGridView, index: Int)) {
        guard day.grid.days.indices.contains(day.index) else { return }
        let insets = scroll.adjustedContentInset
        let visible = CGRect(x: -insets.left, y: scroll.contentOffset.y + insets.top, width: view.bounds.width, height: max(0, scroll.bounds.height - insets.top - insets.bottom))
        callout.place(over: day.grid.cell(day.index, in: scroll), in: visible)
    }

    // MARK: For the tests

    /// The services shown, top to bottom, each with its accounts.
    var shownSections: [(name: String, accounts: [String])] {
        vendorViews.map { section in
            (section.name, (overview?.vendors.first { ($0.name ?? Strings.Usage.otherAccounts) == section.name }?.accounts ?? []).map(\.id))
        }
    }

    func accountView(_ id: String) -> UsageAccountView? { accountViews[id] }

    /// Every word the page shows.
    var shownTexts: [String] {
        var texts: [String] = []
        if !activityCard.isHidden { texts += [activityTitle.text, activitySubtitle.text].compactMap { $0 } }
        for section in vendorViews {
            texts.append(section.title.text ?? "")
            for id in shownSections.first(where: { $0.name == section.name })?.accounts ?? [] { texts += accountViews[id]?.texts ?? [] }
        }
        if !emptyTitle.isHidden { texts += [emptyTitle.text, emptyBody.text].compactMap { $0 } }
        if !callout.isHidden { texts += callout.texts }
        return texts
    }

    var calloutTexts: [String]? { callout.isHidden ? nil : callout.texts }
    var calloutFrame: CGRect { callout.frame }
    var isReading: Bool { reading != nil }
}
#endif
