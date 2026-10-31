#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Search owns the whole content surface, including an empty query. Its
/// scrolling and interactive dismissal never move the home list underneath.
final class HomeSearchResultsView: UIView {
    /// The results, on their own ground: never home's list.
    let list = SidebarView()
    private let pill = UIVisualEffectView(effect: UIGlassEffect())
    private let nothingFound = UILabel()
    private let backdrop = UIView()
    private let surface = UIView()
    private var pulling = false
    private var pull: CGFloat = 0
    var onDismiss: (() -> Void)?

    /// Where the results start (the bar's foot) and the room under them.
    var insets = UIEdgeInsets.zero {
        didSet { if insets != oldValue { setNeedsLayout() } }
    }
    var keyboardTop: CGFloat? {
        didSet { if keyboardTop != oldValue { setNeedsLayout() } }
    }

    /// Something answers, so the results cover home.
    var showsResults: Bool { !isHidden }

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "search-results"
        backdrop.backgroundColor = .black
        addSubview(backdrop)
        surface.backgroundColor = UIColor(Palette.surface)
        addSubview(surface)
        list.keyboardDismissMode = .interactive
        list.panGestureRecognizer.addTarget(self, action: #selector(panned(_:)))
        list.accessibilityIdentifier = "search-results-list"
        surface.addSubview(list)
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
        surface.addSubview(pill)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Empty `query`: nothing shows. Otherwise `rows`, or the capsule when
    /// there are none.
    func show(_ rows: [Row], query: String) {
        let typed = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let found = typed && !rows.isEmpty
        let previous = list.rows.map(\.id)
        pill.isHidden = !typed || found
        list.apply(found ? rows : [])
        if found, previous != rows.map(\.id) {
            list.layoutIfNeeded()
            list.contentOffset.y = -list.contentInset.top
        }
        setNeedsLayout()
    }

    func clear() {
        pulling = false
        pull = 0
        show([], query: "")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let presentation = HomeSearchPresentationLayout(size: bounds.size, pull: pull)
        backdrop.frame = bounds
        backdrop.alpha = presentation.backdropAlpha
        surface.frame = presentation.surface
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

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            pulling = list.contentOffset.y <= -list.adjustedContentInset.top + 1 && gesture.velocity(in: self).y > 0
        case .changed where pulling:
            pull = max(0, gesture.translation(in: self).y)
            if pull > 0 { list.contentOffset.y = -list.adjustedContentInset.top }
            setNeedsLayout()
            layoutIfNeeded()
        case .ended, .cancelled, .failed:
            let dismiss = gesture.state == .ended && pulling && HomeSearchPresentationLayout.shouldDismiss(distance: pull, velocity: gesture.velocity(in: self).y)
            pulling = false
            if dismiss {
                pull = bounds.height
                window?.endEditing(true)
                setNeedsLayout()
                UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) { self.layoutIfNeeded() } completion: { [weak self] _ in self?.onDismiss?() }
            }
            else {
                pull = 0
                setNeedsLayout()
                UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) { self.layoutIfNeeded() }
            }
        default: break
        }
    }
}
#endif
