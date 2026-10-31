#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Search owns the whole content surface, including an empty query, which
/// shows the conversations last active. Its scrolling and dismissal never
/// move the home list underneath: pulled down from its top, the list
/// bounces as any list does, the keyboard goes, and let go far enough,
/// search closes.
final class HomeSearchResultsView: UIView {
    /// The results, on their own ground: never home's list, though drawn
    /// as it is, grouped, on UltraList.
    let list = SidebarList()
    private let pill = UIVisualEffectView(effect: UIGlassEffect())
    private let nothingFound = UILabel()
    /// The pan began with the list at its top, pulling down.
    private var pulling = false
    var onDismiss: (() -> Void)?

    /// Where the results start (the bar's foot) and the room under them.
    var insets = UIEdgeInsets.zero {
        didSet { if insets != oldValue { setNeedsLayout() } }
    }
    var keyboardTop: CGFloat? {
        didSet { if keyboardTop != oldValue { setNeedsLayout() } }
    }

    /// Search is open, so the results cover home.
    var showsResults: Bool { !isHidden }

    /// Shown, the results answer the status bar instead of home's list.
    override var isHidden: Bool {
        didSet { list.list.scrollsToTop = !isHidden }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "search-results"
        backgroundColor = UIColor(Palette.groupedGround)
        list.startsEachChangeAtTop = true
        list.list.keyboardDismissMode = .interactive
        list.panGestureRecognizer?.addTarget(self, action: #selector(panned(_:)))
        list.list.accessibilityIdentifier = "search-results-rows"
        list.edge.accessibilityIdentifier = "search-results-list"
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

    /// `rows`; for a typed `query` that nothing answers, the capsule.
    func show(_ rows: [Row], query: String) {
        let typed = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        pill.isHidden = !typed || !rows.isEmpty
        // Other rows than before start at the top (`startsEachChangeAtTop`).
        list.apply(rows)
        setNeedsLayout()
    }

    func clear() {
        endPull()
        show([], query: "")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = SearchLayout(size: bounds.size, contentTop: insets.top, safeBottom: insets.bottom, keyboardTop: keyboardTop ?? bounds.height, nothingFound: nothingFound.measurable)
        list.frame = bounds
        let listInsets = UIEdgeInsets(top: insets.top, left: 0, bottom: layout.listBottom, right: 0)
        list.setInsets(listInsets, indicator: listInsets, keepsTop: list.isAtTop)
        pill.setLayoutFrame(layout.nothingFoundPill)
        pill.layer.cornerRadius = layout.nothingFoundPill.height / 2
        nothingFound.setLayoutFrame(layout.nothingFound.offsetBy(dx: -layout.nothingFoundPill.minX, dy: -layout.nothingFoundPill.minY))
    }

    /// A pull from the top closes search, so the keyboard goes as it starts
    /// rather than following the finger down.
    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            pulling = list.isAtTop && gesture.velocity(in: self).y > 0
            if pulling { window?.endEditing(true) }
        case .ended:
            let distance = gesture.translation(in: self).y
            let dismiss = pulling && HomeSearchPresentationLayout.shouldDismiss(distance: distance, velocity: gesture.velocity(in: self).y)
            endPull()
            if dismiss { onDismiss?() }
        case .cancelled, .failed:
            endPull()
        default:
            break
        }
    }

    private func endPull() {
        pulling = false
    }
}
#endif
