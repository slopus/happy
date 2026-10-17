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
    /// A long press on a row's long-press target. `frame` is the target's
    /// and `point` the finger's, both in the list's coordinates.
    func chatList(_ list: ChatListView, hold action: ChatRowAction, frame: CGRect, at point: CGPoint)
}

/// The chat's message list: a flipped UICollectionView whose rows were all
/// measured before they were handed over (`ChatRowPlan`), so every frame
/// is exact and nothing jumps. The rows, their geometry and their changes
/// arrive worked out (`ChatListUpdate`); the list only applies them.
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
    private var ids: [String] = []
    private var hasContent = false
    private let holdRecognizer = UILongPressGestureRecognizer()

    /// ChatFooter, just past the newest message: it scrolls with the rows,
    /// as the inverted list's header does in happy-app.
    private let footer = ChatPlanView()
    /// OlderEnd, past the oldest message, in the slot the layout keeps for
    /// it (`ChatListLayout.olderEndFrame`): the inverted list's footer.
    let olderEnd = ChatOlderEndView()

    override init(frame: CGRect) {
        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init(frame: frame)
        collectionView.transform = ChatCollectionLayout.flip
        collectionView.backgroundColor = .clear
        collectionView.contentInsetAdjustmentBehavior = .never
        // No scroll indicator, as Telegram's chat list draws none: nothing
        // at the edge to press and drag (docs/telegram-notes.md).
        collectionView.showsVerticalScrollIndicator = false
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
        olderEnd.transform = ChatCollectionLayout.flip
        collectionView.addSubview(olderEnd)
        addSubview(collectionView)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        collectionView.addGestureRecognizer(tap)
        // Starts only over a long-press target, so a slow tap elsewhere is
        // still a tap; a tap waits for it, which costs nothing, as it fails
        // the moment the finger lifts.
        holdRecognizer.addTarget(self, action: #selector(held(_:)))
        holdRecognizer.minimumPressDuration = CopyMenuLayout.Metrics.pressDuration
        holdRecognizer.delegate = self
        collectionView.addGestureRecognizer(holdRecognizer)
        tap.require(toFail: holdRecognizer)
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
    /// so a rising keyboard carries the conversation up with the composer;
    /// under the reader's finger, as in an interactive dismiss, the
    /// conversation stays with the finger
    /// (`ChatScrollAnchor.visibleMinY(afterNewestInsetChange:…)`).
    func setEdgeInsets(newest: CGFloat, oldest: CGFloat) {
        // On the pixels the header and the dock were snapped to, or the
        // offset lands between them.
        let scale = window?.screen.scale ?? traitCollection.displayScale
        let newest = PixelGrid.round(newest, scale: scale)
        let oldest = PixelGrid.round(oldest, scale: scale)
        // Flipped: the collection view's top is the screen's bottom.
        let inset = UIEdgeInsets(top: newest, left: 0, bottom: oldest, right: 0)
        guard collectionView.contentInset != inset else { return }
        let current = visibleMinY
        let delta = newest - collectionView.contentInset.top
        collectionView.contentInset = inset
        let target = ChatScrollAnchor.visibleMinY(
            afterNewestInsetChange: delta, from: current, maxVisibleMinY: maxVisibleMinY(layout.model), tracking: collectionView.isTracking
        )
        if collectionView.contentOffset.y != target - newest {
            collectionView.contentOffset.y = target - newest
        }
    }

    func scrollToNewest(animated: Bool) {
        collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.contentInset.top), animated: animated)
    }

    // MARK: Updates

    /// Shows `update`'s rows (newest first) under its footer, all measured
    /// at the list's width. Only the rows its changeset names are touched:
    /// deleted, inserted, moved, or given their new plan if on screen.
    /// `update.pinning` is a row the reader just opened or closed: its top
    /// stays where it is on screen. Returns how many rows it touched.
    @discardableResult
    func apply(_ update: ChatListUpdate, animated: Bool) -> Int {
        let model = update.model
        guard hasContent, !plans.isEmpty else {
            hasContent = !update.plans.isEmpty
            install(update)
            layout.invalidateLayout()
            collectionView.reloadData()
            collectionView.layoutIfNeeded()
            scrollToNewest(animated: false)
            scrollViewDidScroll(collectionView)
            return update.plans.count
        }

        let oldIds = ids
        let newIds = update.ids
        let changeset = update.changeset
        let current = visibleMinY
        // Never snap to the newest edge under the reader's finger or while
        // the list coasts.
        let moving = collectionView.isTracking || collectionView.isDecelerating
        let pinned = update.pinning.flatMap { id in
            newIds.contains(id) ? ChatScrollAnchor.pinning(id, layout: layout.model, ids: oldIds, visibleMinY: current) : nil
        }
        let anchor = pinned ?? ChatScrollAnchor.capture(layout: layout.model, ids: oldIds, visibleMinY: current, follow: !moving)
        let target = anchor.visibleMinY(in: model, ids: newIds, current: current, maxVisibleMinY: maxVisibleMinY(model))

        // Rows whose content changed, by id: on screen they take their new
        // plan in place; off screen, `cellForItemAt` reads it later.
        let changed = Dictionary(changeset.reconfigures.map { (newIds[$0], update.plans[$0]) }, uniquingKeysWith: { first, _ in first })
        let apply = {
            self.collectionView.performBatchUpdates {
                self.install(update)
                self.layout.anchoredVisibleMinY = target
                self.collectionView.deleteItems(at: changeset.deletes.map { IndexPath(item: $0, section: 0) })
                self.collectionView.insertItems(at: changeset.inserts.map { IndexPath(item: $0, section: 0) })
                for move in changeset.moves {
                    self.collectionView.moveItem(at: IndexPath(item: move.from, section: 0), to: IndexPath(item: move.to, section: 0))
                }
                if !changeset.isStructural {
                    self.layout.invalidateLayout()
                }
                // Inside the same transaction, so a growing message animates
                // with its frame.
                guard !changed.isEmpty else { return }
                for cell in self.collectionView.visibleCells {
                    guard let cell = cell as? ChatRowCell, let id = cell.plan?.id, let plan = changed[id] else { continue }
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
            apply()
        } else {
            UIView.performWithoutAnimation(apply)
        }
        hasContent = !update.plans.isEmpty
        // A short window may not reach a screen back; let the delegate page.
        scrollViewDidScroll(collectionView)
        return changeset.touchedRows
    }

    private func install(_ update: ChatListUpdate) {
        plans = update.plans
        ids = update.ids
        layout.model = update.model
        if let footerPlan = update.footer { footer.apply(footerPlan) }
        // Flipped like the cells; a transformed view is placed by bounds
        // and center.
        let frame = update.model.newerEndFrame
        footer.bounds = CGRect(origin: .zero, size: frame.size)
        footer.center = CGPoint(x: frame.midX, y: frame.midY)
        let older = update.model.olderEndFrame
        olderEnd.bounds = CGRect(origin: .zero, size: older.size)
        olderEnd.center = CGPoint(x: older.midX, y: older.midY)
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

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === holdRecognizer else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        return holdTarget(at: gestureRecognizer.location(in: collectionView)) != nil
    }

    /// The long-press target under `point` (in the collection view), with
    /// its frame in this view's coordinates.
    private func holdTarget(at point: CGPoint) -> (action: ChatRowAction, frame: CGRect)? {
        guard let indexPath = collectionView.indexPathForItem(at: point),
              let cell = collectionView.cellForItem(at: indexPath) as? ChatRowCell,
              let hit = cell.hold(at: cell.convert(point, from: collectionView)) else { return nil }
        return (hit.action, cell.convert(hit.frame, to: self))
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let target = holdTarget(at: recognizer.location(in: collectionView)) else { return }
        delegate?.chatList(self, hold: target.action, frame: target.frame, at: recognizer.location(in: self))
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
