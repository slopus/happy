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
    /// The results, on their own ground: never home's list.
    let list = SidebarView()
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

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "search-results"
        backgroundColor = UIColor(Palette.groupedGround)
        // Grouped as home is: each section a quiet card.
        list.style = .grouped
        list.keyboardDismissMode = .interactive
        list.panGestureRecognizer.addTarget(self, action: #selector(panned(_:)))
        list.accessibilityIdentifier = "search-results-list"
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
        let previous = list.rows.map(\.id)
        pill.isHidden = !typed || !rows.isEmpty
        list.apply(rows)
        if !rows.isEmpty, previous != rows.map(\.id) {
            list.layoutIfNeeded()
            list.contentOffset.y = -list.contentInset.top
        }
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
        if list.contentInset != listInsets {
            list.contentInset = listInsets
            list.verticalScrollIndicatorInsets = listInsets
        }
        pill.setLayoutFrame(layout.nothingFoundPill)
        pill.layer.cornerRadius = layout.nothingFoundPill.height / 2
        nothingFound.setLayoutFrame(layout.nothingFound.offsetBy(dx: -layout.nothingFoundPill.minX, dy: -layout.nothingFoundPill.minY))
    }

    /// A pull from the top closes search, so the keyboard goes as it starts.
    /// Left to follow the finger, the keyboard takes the touch once the
    /// finger reaches it, and UIKit springs the pulled list back to its top
    /// under the finger.
    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            pulling = list.contentOffset.y <= -list.adjustedContentInset.top + 1 && gesture.velocity(in: self).y > 0
            if pulling {
                list.keyboardDismissMode = .none
                window?.endEditing(true)
            }
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
        list.keyboardDismissMode = .interactive
    }
}
#endif
