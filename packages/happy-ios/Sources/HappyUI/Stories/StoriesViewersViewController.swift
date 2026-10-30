#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Who has seen one's own story, as Telegram's story view list shows them:
/// a sheet from the foot of the screen, edge to edge, "N views" in its
/// header over the list, those who reacted first with when they reacted
/// under their name and their reaction on the right, read a page at a time.
/// It opens half way; a drag takes it full or away, as does a tap above it.
final class StoriesViewersViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    var onClose: (() -> Void)?
    /// The list, which the sheet's drag hands over to once it is full.
    var list: UIScrollView { tableView }
    private let session: StoriesSession
    private let story: Story
    private var viewers: [StoryViewer] = []
    private var cursor: String?
    private var loading = false
    private var ended = false
    private var failures = 0
    private let header = UIView()
    private let headerLine = UIView()
    private let titleLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .plain)
    private let empty = UILabel()
    private let sheet = StoriesViewersSheet()

    init(session: StoriesSession, story: Story) {
        self.session = session
        self.story = story
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .custom
        transitioningDelegate = sheet
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Over a story, as Telegram's, whatever the system's appearance.
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = UIColor(Palette.storiesViewersGround)
        view.layer.cornerRadius = StoryViewersSheetLayout.Metrics.corner
        view.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        view.clipsToBounds = true
        view.accessibilityIdentifier = "story-viewers"
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = UIColor(Palette.storiesViewerText)
        titleLabel.textAlignment = .center
        titleLabel.accessibilityTraits = .header
        titleLabel.accessibilityIdentifier = "story-viewers-title"
        headerLine.backgroundColor = UIColor(Palette.storiesViewersSeparator)
        header.addSubview(titleLabel)
        header.addSubview(headerLine)
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(StoriesViewerCell.self, forCellReuseIdentifier: StoriesViewerCell.reuse)
        tableView.separatorStyle = .none
        tableView.backgroundColor = .clear
        tableView.accessibilityIdentifier = "story-viewers-list"
        empty.text = Strings.Stories.noViewers
        empty.font = .systemFont(ofSize: 15)
        empty.textColor = UIColor(Palette.storiesViewersSecondary)
        empty.textAlignment = .center
        empty.isHidden = true
        tableView.backgroundView = empty
        view.addSubview(tableView)
        view.addSubview(header)
        titleLabel.text = story.viewCount.map(Strings.Stories.views) ?? Strings.Stories.viewers
        loadMore()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = StoryViewersSheetLayout(size: view.bounds.size, titleSize: titleLabel.sizeThatFits(view.bounds.size))
        header.frame = layout.header
        titleLabel.frame = layout.title
        let hairline = 1 / max(1, traitCollection.displayScale)
        headerLine.frame = CGRect(x: 0, y: layout.header.height - hairline, width: layout.header.width, height: hairline)
        tableView.frame = layout.list
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed, let close = onClose {
            onClose = nil
            close()
        }
    }

    override func accessibilityPerformEscape() -> Bool {
        dismiss(animated: true)
        return true
    }

    private func loadMore() {
        guard !loading, !ended else { return }
        loading = true
        let client = session.client
        let id = story.id
        let cursor = cursor
        Task { [weak self] in
            let page = try? await client.storyViewers(id, cursor: cursor)
            guard let self else { return }
            loading = false
            guard let page else { return retry() }
            failures = 0
            // A viewer who reacts meanwhile moves up into a page already read.
            let seen = Set(viewers.map(\.userId))
            viewers += page.viewers.filter { !seen.contains($0.userId) }
            self.cursor = page.nextCursor
            ended = page.nextCursor == nil
            empty.isHidden = !viewers.isEmpty
            if story.viewCount != nil || !viewers.isEmpty {
                titleLabel.text = Strings.Stories.views(max(story.viewCount ?? 0, viewers.count))
                view.setNeedsLayout()
            }
            tableView.reloadData()
        }
    }

    /// A page that failed is asked for again a little later, a few times;
    /// after that the list stops where it is.
    private func retry() {
        failures += 1
        guard failures < 3 else {
            ended = true
            empty.isHidden = !viewers.isEmpty
            return
        }
        Task { [weak self, failures] in
            try? await Task.sleep(for: .seconds(failures))
            guard let self, viewIfLoaded?.window != nil else { return }
            loadMore()
        }
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { viewers.count }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        StoriesViewerCell.layout(viewers[indexPath.row], width: tableView.bounds.width).height
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: StoriesViewerCell.reuse, for: indexPath) as! StoriesViewerCell
        cell.configure(viewers[indexPath.row], last: indexPath.row == viewers.count - 1, images: session.images)
        if indexPath.row >= viewers.count - 5 { loadMore() }
        return cell
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool { false }
}

/// Presents the views sheet as Telegram's: up from the foot, half open.
final class StoriesViewersSheet: NSObject, UIViewControllerTransitioningDelegate {
    func presentationController(forPresented presented: UIViewController, presenting: UIViewController?, source: UIViewController) -> UIPresentationController? {
        StoriesViewersPresentation(presentedViewController: presented, presenting: presenting)
    }

    func animationController(forPresented presented: UIViewController, presenting: UIViewController, source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        StoriesViewersSlide(presenting: true)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        StoriesViewersSlide(presenting: false)
    }
}

/// The sheet sliding up into place, or down away from wherever it is.
final class StoriesViewersSlide: NSObject, UIViewControllerAnimatedTransitioning {
    private let presenting: Bool
    init(presenting: Bool) { self.presenting = presenting }

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval { 0.35 }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        let container = context.containerView
        let key: UITransitionContextViewControllerKey = presenting ? .to : .from
        guard let controller = context.viewController(forKey: key), let view = controller.view else { return context.completeTransition(false) }
        let size = container.bounds.size
        let end: CGRect
        if presenting {
            end = context.finalFrame(for: controller)
            container.addSubview(view)
            view.frame = StoryViewersSheetLayout.sheet(container: size, shown: 0)
        } else {
            end = StoryViewersSheetLayout.sheet(container: size, shown: 0)
        }
        UIView.animate(withDuration: transitionDuration(using: context), delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            view.frame = end
        } completion: { _ in
            context.completeTransition(!context.transitionWasCancelled)
        }
    }
}

/// Holds the sheet at half or full, follows a drag on it, and closes it on
/// a drag down past half or a tap above it. Once full, a drag up scrolls
/// the list; a drag down scrolls it back to its top before moving the sheet.
final class StoriesViewersPresentation: UIPresentationController, UIGestureRecognizerDelegate {
    private let outside = UIControl()
    private var full = false
    private var dragging = false
    private var start: CGFloat = 0
    /// Whether the drag began on the list, which then scrolls once full.
    private var onList = false
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
    private var list: UIScrollView? { (presentedViewController as? StoriesViewersViewController)?.list }

    override var frameOfPresentedViewInContainerView: CGRect {
        guard let containerView else { return .zero }
        let height = containerView.bounds.height
        return StoryViewersSheetLayout.sheet(container: containerView.bounds.size, shown: full ? StoryViewersSheetLayout.full(height) : StoryViewersSheetLayout.half(height))
    }

    override func presentationTransitionWillBegin() {
        super.presentationTransitionWillBegin()
        guard let containerView else { return }
        outside.frame = containerView.bounds
        outside.isAccessibilityElement = true
        outside.accessibilityLabel = Strings.Stories.close
        outside.accessibilityTraits = .button
        outside.accessibilityIdentifier = "story-viewers-outside"
        outside.addAction(UIAction { [weak self] _ in self?.presentedViewController.dismiss(animated: true) }, for: .touchUpInside)
        containerView.insertSubview(outside, at: 0)
        // The sheet and the close above it, and nothing of the story under.
        containerView.accessibilityViewIsModal = true
        pan.delegate = self
        presentedView?.addGestureRecognizer(pan)
    }

    override func containerViewWillLayoutSubviews() {
        super.containerViewWillLayoutSubviews()
        guard let containerView else { return }
        placeOutside()
        if !dragging, !presentedViewController.isBeingPresented, !presentedViewController.isBeingDismissed {
            presentedView?.frame = frameOfPresentedViewInContainerView
        }
    }

    /// Above the sheet at rest, so VoiceOver's ring sits where a tap closes.
    private func placeOutside() {
        guard let containerView else { return }
        outside.frame = CGRect(x: 0, y: 0, width: containerView.bounds.width, height: max(0, frameOfPresentedViewInContainerView.minY))
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        !presentedViewController.isBeingPresented && !presentedViewController.isBeingDismissed
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other === list?.panGestureRecognizer
    }

    @objc private func drag(_ gesture: UIPanGestureRecognizer) {
        guard let containerView, let view = presentedView else { return }
        let size = containerView.bounds.size
        let half = StoryViewersSheetLayout.half(size.height)
        let fullHeight = StoryViewersSheetLayout.full(size.height)
        // Caught while settling, it is where it shows, not where it is going.
        let shown = size.height - (view.layer.presentation()?.frame.minY ?? view.frame.minY)
        let top = -(list?.adjustedContentInset.top ?? 0)
        // Only a full sheet's list scrolls; below full the sheet moves.
        let scrolled = onList && shown >= fullHeight - 0.5 && (list?.contentOffset.y ?? top) > top + 0.5
        switch gesture.state {
        case .began:
            dragging = true
            start = shown
            onList = list.map { $0.bounds.contains(gesture.location(in: $0)) } ?? false
            view.layer.removeAllAnimations()
            view.frame = StoryViewersSheetLayout.sheet(container: size, shown: shown)
        case .changed:
            // The list moves first while it isn't at its top.
            if scrolled {
                gesture.setTranslation(.zero, in: containerView)
                start = shown
                return
            }
            var next = start - gesture.translation(in: containerView).y
            if next >= fullHeight {
                next = fullHeight
            } else if let list {
                list.setContentOffset(CGPoint(x: list.contentOffset.x, y: top), animated: false)
            }
            view.frame = StoryViewersSheetLayout.sheet(container: size, shown: max(0, next))
        default:
            dragging = false
            // A cancelled drag only puts the sheet back where it was.
            if gesture.state == .ended {
                let velocity = gesture.velocity(in: containerView).y
                if !scrolled, shown < half - 80 || (velocity > 800 && shown <= half + 1) {
                    presentedViewController.dismiss(animated: true)
                    return
                }
                // Taken full and on into the list, it stays full.
                full = scrolled || (velocity < -500 ? true : velocity > 500 ? false : shown > (half + fullHeight) / 2)
            }
            if !full, let list { list.setContentOffset(CGPoint(x: list.contentOffset.x, y: top), animated: false) }
            UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                view.frame = self.frameOfPresentedViewInContainerView
                view.layoutIfNeeded()
                self.placeOutside()
            }
        }
    }
}

final class StoriesViewerCell: UITableViewCell {
    static let reuse = "viewer"
    private static let titleFont = UIFont.systemFont(ofSize: StoryViewersRowLayout.Metrics.titleSize, weight: .semibold)
    private static let subtitleFont = UIFont.systemFont(ofSize: StoryViewersRowLayout.Metrics.subtitleSize)
    private let avatar = UIImageView()
    private let initials = UILabel()
    private let name = UILabel()
    private let time = UILabel()
    private let reaction = UILabel()
    private let separator = UIView()
    private var loading: Task<Void, Never>?
    private var key: String?
    private var viewer: StoryViewer?

    static func layout(_ viewer: StoryViewer, width: CGFloat) -> StoryViewersRowLayout {
        StoryViewersRowLayout(width: width, titleHeight: titleFont.lineHeight, subtitleHeight: viewer.reactedAt == nil ? nil : subtitleFont.lineHeight, reacted: viewer.reaction != nil)
    }

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = StoryViewersRowLayout.Metrics.avatar / 2
        avatar.contentMode = .scaleAspectFill
        avatar.backgroundColor = UIColor(Palette.storiesAvatarFill)
        initials.font = .systemFont(ofSize: 16, weight: .semibold)
        initials.textColor = UIColor(Palette.storiesAvatarText)
        initials.textAlignment = .center
        // The name says who it is; the initials would only repeat it.
        initials.isAccessibilityElement = false
        avatar.addSubview(initials)
        name.font = Self.titleFont
        name.textColor = UIColor(Palette.storiesViewerText)
        time.font = Self.subtitleFont
        time.textColor = UIColor(Palette.storiesViewersSecondary)
        // An emoji's glyph at 19 pt fills Telegram's 22 pt reaction square.
        reaction.font = .systemFont(ofSize: 19)
        reaction.textAlignment = .center
        separator.backgroundColor = UIColor(Palette.storiesViewersSeparator)
        backgroundColor = .clear
        for view in [avatar, name, time, reaction, separator] { contentView.addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func prepareForReuse() {
        super.prepareForReuse()
        loading?.cancel()
        key = nil
        avatar.image = nil
        initials.isHidden = false
    }

    func configure(_ viewer: StoryViewer, last: Bool, images: Images) {
        name.text = viewer.name
        time.text = viewer.reactedAt.map { Strings.Stories.when($0, now: Int64(Date().timeIntervalSince1970 * 1000)) }
        reaction.text = viewer.reaction
        initials.text = StoriesRow.initials(viewer.name)
        separator.isHidden = last
        self.viewer = viewer
        accessibilityIdentifier = "story-viewer:\(viewer.name)"
        setNeedsLayout()
        let key = viewer.photo.map { "\($0)#\(viewer.thumbhash ?? "")" }
        guard key != self.key else { return }
        self.key = key
        loading?.cancel()
        avatar.image = nil
        initials.isHidden = false
        guard let path = viewer.photo else { return }
        loading = Task { [weak self] in
            let image = await images.picture(path, thumbhash: viewer.thumbhash, pixels: 120)
            guard let self, !Task.isCancelled, self.key == key, let image else { return }
            avatar.image = image
            initials.isHidden = true
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let viewer else { return }
        let bounds = contentView.bounds
        let row = Self.layout(viewer, width: bounds.width)
        avatar.frame = row.avatar
        initials.frame = avatar.bounds
        name.frame = row.title
        time.frame = row.subtitle ?? .zero
        time.isHidden = row.subtitle == nil
        reaction.frame = row.reaction ?? .zero
        reaction.isHidden = row.reaction == nil
        let hairline = 1 / max(1, traitCollection.displayScale)
        separator.frame = CGRect(x: row.separatorLeading, y: bounds.height - hairline, width: max(0, bounds.width - row.separatorLeading - row.separatorTrailing), height: hairline)
    }
}
#endif
