#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Who has seen one's own story, those who reacted first with their
/// reaction beside them, read a page at a time.
final class StoriesViewersViewController: UITableViewController, UIAdaptivePresentationControllerDelegate {
    var onClose: (() -> Void)?
    private let session: StoriesSession
    private let story: Story
    private var viewers: [StoryViewer] = []
    private var cursor: String?
    private var loading = false
    private var ended = false
    private let empty = UILabel()

    init(session: StoriesSession, story: Story) {
        self.session = session
        self.story = story
        super.init(style: .plain)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = story.viewCount.map(Strings.Stories.views) ?? Strings.Stories.viewers
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true) { self?.onClose?() }
        })
        tableView.register(StoriesViewerCell.self, forCellReuseIdentifier: StoriesViewerCell.reuse)
        tableView.rowHeight = 56
        tableView.accessibilityIdentifier = "story-viewers-list"
        empty.text = Strings.Stories.noViewers
        empty.textColor = .secondaryLabel
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
            guard let page else { ended = true; return }
            viewers += page.viewers
            self.cursor = page.nextCursor
            ended = page.nextCursor == nil
            empty.isHidden = !viewers.isEmpty
            tableView.reloadData()
        }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { viewers.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: StoriesViewerCell.reuse, for: indexPath) as! StoriesViewerCell
        cell.configure(viewers[indexPath.row], images: session.images)
        if indexPath.row >= viewers.count - 5 { loadMore() }
        return cell
    }

    override func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool { false }
}

final class StoriesViewerCell: UITableViewCell {
    static let reuse = "viewer"
    private let avatar = UIImageView()
    private let initials = UILabel()
    private let name = UILabel()
    private let reaction = UILabel()
    private var loading: Task<Void, Never>?
    private var key: String?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = 20
        avatar.contentMode = .scaleAspectFill
        avatar.backgroundColor = UIColor(Palette.storiesAvatarFill)
        initials.font = .systemFont(ofSize: 15, weight: .semibold)
        initials.textColor = UIColor(Palette.storiesAvatarText)
        initials.textAlignment = .center
        avatar.addSubview(initials)
        name.font = .systemFont(ofSize: 16, weight: .medium)
        reaction.font = .systemFont(ofSize: 22)
        reaction.textAlignment = .right
        for view in [avatar, name, reaction] { contentView.addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func prepareForReuse() {
        super.prepareForReuse()
        loading?.cancel()
        key = nil
        avatar.image = nil
        initials.isHidden = false
    }

    func configure(_ viewer: StoryViewer, images: StemCellsImages) {
        name.text = viewer.name
        reaction.text = viewer.reaction
        initials.text = StoriesRow.initials(viewer.name)
        accessibilityIdentifier = "story-viewer:\(viewer.name)"
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
        let height = contentView.bounds.height
        avatar.frame = CGRect(x: 16, y: (height - 40) / 2, width: 40, height: 40)
        initials.frame = avatar.bounds
        reaction.frame = CGRect(x: contentView.bounds.width - 56, y: 0, width: 40, height: height)
        name.frame = CGRect(x: avatar.frame.maxX + 12, y: 0, width: max(0, reaction.frame.minX - avatar.frame.maxX - 20), height: height)
    }
}
#endif
