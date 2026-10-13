#if canImport(UIKit)
import HappyLayout
import UIKit

@MainActor
protocol ChatListViewDelegate: AnyObject {
    /// `distanceFromNewest` is how far the reader has scrolled back from the
    /// newest message; `distanceFromOldest` how much more there is to
    /// scroll before the oldest row shown, where the next page of history
    /// should be added once it is within a screen.
    func chatList(_ list: ChatListView, didScroll distanceFromNewest: CGFloat, distanceFromOldest: CGFloat)
    func chatList(_ list: ChatListView, perform action: ChatRowAction)
    func chatList(_ list: ChatListView, openLink url: String)
}

/// The chat's message list: a flipped UICollectionView whose rows were all
/// measured before they were handed over (`ChatRowPlan`), so every frame
/// is exact and nothing jumps.
///
/// An update keeps the reader's place (`ChatScrollAnchor`): a reader at the
/// newest message is carried along as rows arrive and grow, animated; a
/// reader further back keeps the row they are looking at exactly where it
/// is, with no animation, whatever changed around it.
final class ChatListView: UIView, UICollectionViewDataSource, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    weak var delegate: (any ChatListViewDelegate)?

    let collectionView: UICollectionView
    private let layout = ChatCollectionLayout()
    private(set) var plans: [ChatRowPlan] = []
    private var planById: [String: ChatRowPlan] = [:]
    private var hasContent = false

    /// ChatFooter, just past the newest message: it scrolls with the rows,
    /// as the inverted list's header does in happy-app.
    private let footer = ChatPlanView()
    /// The footer's height (no warning: 4 + 2).
    private var newerEndHeight: CGFloat = ChatFooterLayout.Metrics.paddingTop + ChatFooterLayout.Metrics.paddingBottom
    /// The slot past the oldest message for the history spinner.
    var olderEndHeight: CGFloat = ChatOlderEndLayout.height

    override init(frame: CGRect) {
        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init(frame: frame)
        collectionView.transform = ChatCollectionLayout.flip
        collectionView.backgroundColor = .clear
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.keyboardDismissMode = .interactive
        collectionView.alwaysBounceVertical = true
        collectionView.showsHorizontalScrollIndicator = false
        // Rows are measured before they arrive; there is nothing to prefetch.
        collectionView.isPrefetchingEnabled = false
        if #available(iOS 26.0, *) {
            // The screen draws its own scrims under the bar and behind the
            // dock; and to the system, this flipped list's ends are swapped.
            collectionView.topEdgeEffect.isHidden = true
            collectionView.bottomEdgeEffect.isHidden = true
        }
        collectionView.register(ChatRowCell.self, forCellWithReuseIdentifier: ChatRowCell.reuseIdentifier)
        collectionView.dataSource = self
        collectionView.delegate = self
        footer.transform = ChatCollectionLayout.flip
        footer.isUserInteractionEnabled = false
        collectionView.addSubview(footer)
        addSubview(collectionView)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        collectionView.addGestureRecognizer(tap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // A transformed view is placed by bounds and center, never frame.
        if collectionView.bounds.size != bounds.size {
            collectionView.bounds = CGRect(origin: collectionView.bounds.origin, size: bounds.size)
        }
        collectionView.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// The width the current rows were measured at.
    var measuredWidth: CGFloat { layout.model.width }

    // MARK: Position

    /// The content y at the newest edge of the visible area; 0 when the
    /// newest message is showing.
    var visibleMinY: CGFloat {
        collectionView.contentOffset.y + collectionView.contentInset.top
    }

    private func maxVisibleMinY(_ model: ChatListLayout) -> CGFloat {
        let inset = collectionView.contentInset
        return max(0, model.contentHeight + inset.top + inset.bottom - collectionView.bounds.height)
    }

    var distanceFromNewest: CGFloat { max(0, visibleMinY) }

    /// Insets at both ends: the newest edge clears the dock, the oldest the
    /// navigation bar. What the reader sees at the newest edge stays put,
    /// so a rising keyboard carries the conversation up with the composer.
    func setEdgeInsets(newest: CGFloat, oldest: CGFloat) {
        let inset = UIEdgeInsets(top: newest, left: 0, bottom: oldest, right: 0)
        guard collectionView.contentInset != inset else { return }
        let anchor = visibleMinY
        collectionView.contentInset = inset
        collectionView.verticalScrollIndicatorInsets = inset
        let target = min(max(0, anchor), maxVisibleMinY(layout.model))
        collectionView.contentOffset.y = target - newest
    }

    func scrollToNewest(animated: Bool) {
        collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.contentInset.top), animated: animated)
    }

    // MARK: Updates

    /// Shows `newPlans` (newest first) under `footer`, all measured at the
    /// list's width. `pinning` is a row the reader just opened or closed:
    /// its top stays where it is on screen.
    func apply(_ newPlans: [ChatRowPlan], footer footerPlan: ChatRowPlan? = nil, animated: Bool, pinning: String? = nil) {
        let width = newPlans.first?.size.width ?? bounds.width
        if let footerPlan { newerEndHeight = footerPlan.size.height }
        let model = ChatListLayout(width: width, heights: newPlans.map(\.size.height), newerEndHeight: newerEndHeight, olderEndHeight: olderEndHeight)

        guard hasContent, !plans.isEmpty else {
            hasContent = !newPlans.isEmpty
            install(newPlans, footer: footerPlan, model: model)
            layout.invalidateLayout()
            collectionView.reloadData()
            collectionView.layoutIfNeeded()
            scrollToNewest(animated: false)
            scrollViewDidScroll(collectionView)
            return
        }

        let oldIds = plans.map(\.id)
        let newIds = newPlans.map(\.id)
        let current = visibleMinY
        // Never snap to the newest edge under the reader's finger or while
        // the list coasts.
        let moving = collectionView.isTracking || collectionView.isDecelerating
        let pinned = pinning.flatMap { id in
            newIds.contains(id) ? ChatScrollAnchor.pinning(id, layout: layout.model, ids: oldIds, visibleMinY: current) : nil
        }
        let anchor = pinned ?? ChatScrollAnchor.capture(layout: layout.model, ids: oldIds, visibleMinY: current, follow: !moving)
        let target = anchor.visibleMinY(in: model, ids: newIds, current: current, maxVisibleMinY: maxVisibleMinY(model))

        var deletes: [IndexPath] = []
        var inserts: [IndexPath] = []
        for change in newIds.difference(from: oldIds) {
            switch change {
            case .remove(let offset, _, _): deletes.append(IndexPath(item: offset, section: 0))
            case .insert(let offset, _, _): inserts.append(IndexPath(item: offset, section: 0))
            }
        }

        let update = {
            self.collectionView.performBatchUpdates {
                self.install(newPlans, footer: footerPlan, model: model)
                self.layout.anchoredVisibleMinY = target
                self.collectionView.deleteItems(at: deletes)
                self.collectionView.insertItems(at: inserts)
                if deletes.isEmpty && inserts.isEmpty {
                    self.layout.invalidateLayout()
                }
                // Visible rows take their new content inside the same
                // transaction, so a growing message animates with its frame.
                for cell in self.collectionView.visibleCells {
                    guard let cell = cell as? ChatRowCell, let id = cell.plan?.id, let plan = self.planById[id] else { continue }
                    cell.apply(plan)
                }
            }
            self.layout.anchoredVisibleMinY = nil
            let offset = target - self.collectionView.contentInset.top
            if abs(self.collectionView.contentOffset.y - offset) > 0.5 {
                self.collectionView.contentOffset.y = offset
            }
        }
        // Only a reader at the newest edge sees rows move; anyone else is
        // held still, and an animation would only show the correction.
        if animated, case .newest = anchor.kind {
            update()
        } else {
            UIView.performWithoutAnimation(update)
        }
        hasContent = !newPlans.isEmpty
        // A short window may not reach a screen back; let the delegate page.
        scrollViewDidScroll(collectionView)
    }

    private func install(_ newPlans: [ChatRowPlan], footer footerPlan: ChatRowPlan?, model: ChatListLayout) {
        plans = newPlans
        planById = Dictionary(newPlans.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        layout.model = model
        if let footerPlan { footer.apply(footerPlan) }
        // Flipped like the cells; a transformed view is placed by bounds
        // and center.
        let frame = model.newerEndFrame
        footer.bounds = CGRect(origin: .zero, size: frame.size)
        footer.center = CGPoint(x: frame.midX, y: frame.midY)
    }

    // MARK: UICollectionViewDataSource

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        plans.count
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: ChatRowCell.reuseIdentifier, for: indexPath)
        if let cell = cell as? ChatRowCell, indexPath.item < plans.count {
            cell.apply(plans[indexPath.item])
            cell.onAction = { [weak self] action in
                guard let self else { return }
                self.delegate?.chatList(self, perform: action)
            }
        }
        return cell
    }

    // MARK: Scrolling and taps

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let remaining = maxVisibleMinY(layout.model) - visibleMinY
        delegate?.chatList(self, didScroll: distanceFromNewest, distanceFromOldest: remaining)
    }

    /// A control inside a row (a diff's "Show N more lines") handles its
    /// own taps; the row's hits never see them.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view, current !== collectionView {
            if current is UIControl { return false }
            view = current.superview
        }
        return true
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        let point = recognizer.location(in: collectionView)
        guard let indexPath = collectionView.indexPathForItem(at: point),
              let cell = collectionView.cellForItem(at: indexPath) as? ChatRowCell else { return }
        let local = cell.convert(point, from: collectionView)
        if let url = cell.link(at: local) {
            delegate?.chatList(self, openLink: url)
        } else if let action = cell.action(at: local) {
            delegate?.chatList(self, perform: action)
        }
    }
}
#endif
