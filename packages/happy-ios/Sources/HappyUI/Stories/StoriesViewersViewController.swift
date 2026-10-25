#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Who has seen one's own story, as Telegram's story view list shows them:
/// "N views" over a dark list, those who reacted first with when they
/// reacted under their name and their reaction on the right, read a page
/// at a time.
final class StoriesViewersViewController: UITableViewController, UIAdaptivePresentationControllerDelegate {
    var onClose: (() -> Void)?
    private let session: StoriesSession
    private let story: Story
    private var viewers: [StoryViewer] = []
    private var cursor: String?
    private var loading = false
    private var ended = false
    private var failures = 0
    private let empty = UILabel()

    init(session: StoriesSession, story: Story) {
        self.session = session
        self.story = story
        super.init(style: .plain)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Over a story, as Telegram's, whatever the system's appearance.
        navigationController?.overrideUserInterfaceStyle = .dark
        overrideUserInterfaceStyle = .dark
        title = story.viewCount.map(Strings.Stories.views) ?? Strings.Stories.viewers
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true) { self?.onClose?() }
        })
        tableView.register(StoriesViewerCell.self, forCellReuseIdentifier: StoriesViewerCell.reuse)
        tableView.separatorStyle = .none
        tableView.backgroundColor = UIColor(Palette.storiesViewersGround)
        tableView.accessibilityIdentifier = "story-viewers-list"
        empty.text = Strings.Stories.noViewers
        empty.font = .systemFont(ofSize: 15)
        empty.textColor = UIColor(Palette.storiesViewersSecondary)
        empty.textAlignment = .center
        empty.isHidden = true
        tableView.backgroundView = empty
        loadMore()
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { onClose?() }

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
                title = Strings.Stories.views(max(story.viewCount ?? 0, viewers.count))
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

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { viewers.count }

    override func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        StoriesViewerCell.layout(viewers[indexPath.row], width: tableView.bounds.width).height
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: StoriesViewerCell.reuse, for: indexPath) as! StoriesViewerCell
        cell.configure(viewers[indexPath.row], last: indexPath.row == viewers.count - 1, images: session.images)
        if indexPath.row >= viewers.count - 5 { loadMore() }
        return cell
    }

    override func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool { false }
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

    func configure(_ viewer: StoryViewer, last: Bool, images: StemCellsImages) {
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
