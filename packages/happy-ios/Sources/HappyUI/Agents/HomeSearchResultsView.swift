#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Search's results, a component of their own over home: home's list stays
/// as it was under them, its rows, scroll and insets untouched. Nothing
/// shows while nothing is typed; once something answers, its own list
/// covers home under the bar; when nothing does, a small capsule says so
/// over home, and home still takes touches around it.
final class HomeSearchResultsView: UIView {
    /// The results, on their own ground: never home's list.
    let list = SidebarView()
    private let pill = UIVisualEffectView(effect: UIGlassEffect())
    private let nothingFound = UILabel()

    /// Where the results start (the bar's foot) and the room under them.
    var insets = UIEdgeInsets.zero {
        didSet { if insets != oldValue { setNeedsLayout() } }
    }
    var keyboardTop: CGFloat? {
        didSet { if keyboardTop != oldValue { setNeedsLayout() } }
    }

    /// Something answers, so the results cover home.
    var showsResults: Bool { !list.isHidden }

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "search-results"
        list.backgroundColor = UIColor(Palette.surface)
        list.keyboardDismissMode = .onDrag
        list.accessibilityIdentifier = "search-results-list"
        list.isHidden = true
        addSubview(list)
        nothingFound.text = Strings.nothingFound
        nothingFound.font = Fonts.ui(.regular, size: 15)
        nothingFound.textColor = UIColor(Palette.rowText)
        nothingFound.textAlignment = .center
        nothingFound.numberOfLines = 0
        nothingFound.accessibilityIdentifier = "search-nothing"
        pill.isHidden = true
        pill.isUserInteractionEnabled = false
        pill.clipsToBounds = true
        pill.contentView.addSubview(nothingFound)
        addSubview(pill)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Empty `query`: nothing shows. Otherwise `rows`, or the capsule when
    /// there are none.
    func show(_ rows: [Row], query: String) {
        let typed = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let found = typed && !rows.isEmpty
        let wasShown = !list.isHidden
        list.isHidden = !found
        pill.isHidden = !typed || found
        list.apply(found ? rows : [])
        if found, !wasShown || list.rows.map(\.id) != rows.map(\.id) {
            list.layoutIfNeeded()
            list.contentOffset.y = -list.contentInset.top
        }
        setNeedsLayout()
    }

    func clear() {
        show([], query: "")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = SearchLayout(size: bounds.size, contentTop: insets.top, safeBottom: insets.bottom, keyboardTop: keyboardTop ?? bounds.height, nothingFound: nothingFound.measurable)
        list.frame = bounds
        let listInsets = UIEdgeInsets(top: insets.top, left: 0, bottom: layout.listBottom, right: 0)
        if list.contentInset != listInsets {
            list.contentInset = listInsets
            list.verticalScrollIndicatorInsets = listInsets
        }
        pill.setLayoutFrame(layout.nothingFoundPill)
        pill.layer.cornerRadius = layout.nothingFoundPill.height / 2
        nothingFound.setLayoutFrame(layout.nothingFound.offsetBy(dx: -layout.nothingFoundPill.minX, dy: -layout.nothingFoundPill.minY))
    }

    /// Touches off the results and the capsule reach home.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}
#endif
