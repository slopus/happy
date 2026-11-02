#if canImport(UIKit)
import HappyCore
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
    /// and `point` the finger's, both in the list's coordinates; `canvas`
    /// is the row's plan view, where the row's own coordinates hold.
    func chatList(_ list: ChatListView, hold action: ChatRowAction, frame: CGRect, at point: CGPoint, canvas: ChatPlanView?)
    /// VoiceOver's Select Text on a message: its words, whole.
    func chatList(_ list: ChatListView, selectText text: String)
}

/// The chat's message list, on UltraList (`ChatUltraListAdapter`): turned
/// upside down, so row 0, the newest, rests at the foot. Every row was
/// measured before it was handed over (`ChatRowPlan`), so every frame is
/// exact and nothing jumps. The rows, their geometry and their changes
/// arrive worked out (`ChatListUpdate`); the list only applies them.
///
/// An update keeps the reader's place: a reader at the newest message is
/// carried along as rows arrive and grow, animated; a reader further back
/// keeps the row they are looking at where it is, whatever changed around
/// it.
final class ChatListView: UIView {
    /// Turns the list upside down, and each row the right way up in it.
    static let flip = CGAffineTransform(scaleX: 1, y: -1)

    weak var delegate: (any ChatListViewDelegate)?

    let ultra: ChatUltraListAdapter
    private var latest: ChatListUpdate?
    private var edgeInsets = UIEdgeInsets.zero
    private var model = ChatListLayout(width: 0, heights: [])
    private(set) var plans: [ChatRowPlan] = []

    /// OlderEnd, past the oldest message, in the slot the layout keeps for
    /// it (`ChatListLayout.olderEndFrame`): the inverted list's footer.
    let olderEnd = ChatOlderEndView()

    override init(frame: CGRect = .zero) {
        ultra = ChatUltraListAdapter(olderEnd: olderEnd)
        super.init(frame: frame)
        ultra.onScroll = { [weak self] in self?.reportScroll() }
        ultra.onAction = { [weak self] action in
            guard let self else { return }
            self.delegate?.chatList(self, perform: action)
        }
        ultra.onLink = { [weak self] url in
            guard let self else { return }
            self.delegate?.chatList(self, openLink: url)
        }
        ultra.onHold = { [weak self] action, view, frame, point in
            guard let self else { return }
            self.delegate?.chatList(self, hold: action, frame: view.convert(frame, to: self), at: view.convert(point, to: self), canvas: view as? ChatPlanView)
        }
        ultra.onSelectText = { [weak self] text in
            guard let self else { return }
            self.delegate?.chatList(self, selectText: text)
        }
        ultra.list.frame = bounds
        addSubview(ultra.list)
        // Resolve UltraView's measurement environment before its first
        // asynchronous collection.
        ultra.list.layoutIfNeeded()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        ultra.setViewport(frame: sidesBand, insets: edgeInsets)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        ultra.list.takingMargins(super.hitTest(point, with: event), of: self)
    }

    /// The width the rows are laid out at: this view less the safe area's
    /// sides, so a phone held sideways keeps them off the camera.
    var contentWidth: CGFloat { sidesBand.width }

    /// The width the current rows were measured at.
    var measuredWidth: CGFloat { model.width }

    // MARK: Position

    /// The content y at the newest edge of the visible area; 0 when the
    /// newest message is showing.
    var visibleMinY: CGFloat { ultra.visibleMinY }

    var isTracking: Bool { ultra.list.isTracking }
    var isDragging: Bool { ultra.list.isDragging }
    var isDecelerating: Bool { ultra.list.isDecelerating }
    var contentInsets: UIEdgeInsets { edgeInsets }
    var contentHeight: CGFloat { model.contentHeight }
    var scrollGestureView: UIView { ultra.list.scrollGestureHostView }
    var scrollOffset: CGFloat { visibleMinY - edgeInsets.top }
    var maximumVisibleMinY: CGFloat { max(0, model.contentHeight + edgeInsets.top + edgeInsets.bottom - bounds.height) }
    var isDisplayReady: Bool { ultra.isDisplayReady }

    func setVisibleMinY(_ distance: CGFloat) { ultra.setVisibleMinY(distance) }

    var distanceFromNewest: CGFloat { max(0, visibleMinY) }

    /// Insets at both ends: the newest edge clears the dock, the oldest the
    /// navigation bar. What the reader sees at the newest edge stays put,
    /// so a rising keyboard carries the conversation up with the composer;
    /// under the reader's finger, as in an interactive dismiss, the
    /// conversation stays with the finger. `keyboard` is UltraList's own
    /// keyboard move (`ChatUltraKeyboard`).
    func setEdgeInsets(newest: CGFloat, oldest: CGFloat, keyboard: ChatUltraKeyboard.Change? = nil) {
        // On the pixels the header and the dock were snapped to, or the
        // offset lands between them.
        let scale = window?.screen.scale ?? traitCollection.displayScale
        let newest = PixelGrid.round(newest, scale: scale)
        let oldest = PixelGrid.round(oldest, scale: scale)
        // Flipped: the list's top is the screen's bottom.
        edgeInsets = UIEdgeInsets(top: newest, left: 0, bottom: oldest, right: 0)
        ultra.setViewport(frame: sidesBand, insets: edgeInsets, keyboard: keyboard)
    }

    func scrollToNewest(animated: Bool) { ultra.scrollToNewest(animated: animated) }

    // MARK: Updates

    /// Shows `update`'s rows (newest first) under its footer, all measured
    /// at the list's width. Rows whose plan is unchanged keep their views
    /// and drawings. `update.pinning` is a row the reader just opened or
    /// closed: its end stays where it is on screen. Returns how many rows
    /// the changeset touched.
    @discardableResult
    func apply(_ update: ChatListUpdate, animated: Bool) -> Int {
        var complete = update
        complete.footer = update.footer ?? latest?.footer
        complete.footerReplan = update.footerReplan ?? latest?.footerReplan
        latest = complete
        plans = update.plans
        model = update.model
        ultra.apply(complete, animated: animated)
        return update.changeset.touchedRows
    }

    private func reportScroll() {
        delegate?.chatList(self, didScroll: distanceFromNewest, distanceFromOldest: maximumVisibleMinY - visibleMinY)
    }
}
#endif
