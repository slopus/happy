#if canImport(UIKit)
import HappyLayout
import UIKit

/// One of settings' nested pages (Appearance, Account, Voice, Support us):
/// its rows in the same grouped cards as the main page, under the bar, a
/// card's footer under it. `rows` is asked again whenever a row changes
/// something the page shows; a page with state of its own subclasses and
/// overrides `makeRows`, calling `reload` when it changes.
class SettingsPageViewController: UIViewController {
    private let rowsFor: (() -> [[SettingsRow]])?
    let scroll = UIScrollView()
    private var cards: [SettingsCardView] = []
    private lazy var footers = SettingsFooters(in: scroll)
    private(set) var rows: [[SettingsRow]] = []
    private var settingsLayout = SettingsLayout(width: 0, nameHeight: 0, subtitleHeight: 0, cards: [], searching: true)
    /// The row home's search found, scrolled to and flashed once shown.
    var reveal: String?

    /// What the page shows, card by card: for the tests.
    var shownRowIDs: [[String]] { rows.map { $0.map(\.id) } }
    var shownFooters: [String] { footers.texts }
    /// The row `id` as the page shows it.
    func shownRow(_ id: String) -> SettingsRow? { rows.joined().first { $0.id == id } }
    /// Runs the row `id`'s action, as a finger on it would.
    func tapRow(_ id: String) { shownRow(id)?.action?() }

    init(title: String, rows: (() -> [[SettingsRow]])? = nil) {
        rowsFor = rows
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        navigationItem.largeTitleDisplayMode = .never
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        reload()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard let id = reveal, let card = rows.firstIndex(where: { $0.contains { $0.id == id } }),
              let index = rows[card].firstIndex(where: { $0.id == id }), cards.indices.contains(card) else { return }
        reveal = nil
        if let y = settingsLayout.revealOffset(card: card, row: index, viewport: scroll.bounds.height, insets: LayoutInsets(scroll.adjustedContentInset)) {
            scroll.setContentOffset(CGPoint(x: 0, y: y), animated: true)
        }
        cards[card].flash(index)
    }

    /// The page's rows, card by card.
    func makeRows() -> [[SettingsRow]] { rowsFor?() ?? [] }

    func reload() {
        guard isViewLoaded else { return }
        rows = makeRows().filter { !$0.isEmpty }.map { card in
            card.map { row in
                var row = row
                // A switch or a choice may change what the page shows.
                if let action = row.action { row.action = { [weak self] in action(); self?.reload() } }
                if let toggled = row.toggled { row.toggled = { [weak self] on in toggled(on); self?.reload() } }
                return row
            }
        }
        while cards.count < rows.count { let card = SettingsCardView(); scroll.addSubview(card); cards.append(card) }
        while cards.count > rows.count { cards.removeLast().removeFromSuperview() }
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        scroll.frame = view.bounds
        let specs = SettingsCardView.specs(rows, width: width)
        let layout = SettingsLayout(width: width, nameHeight: 0, subtitleHeight: 0, cards: specs, footers: SettingsCardView.footers(rows, width: width), searching: true)
        settingsLayout = layout
        for (index, card) in cards.enumerated() where layout.cards.indices.contains(index) {
            card.frame = layout.cards[index].frame
            card.show(rows[index], layout: layout.cards[index])
        }
        footers.show(rows.map { $0.last?.footer }, layout: layout.cards)
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }
}
#endif
