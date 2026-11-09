#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A team member's profile on a Happy Cloud server, opened from a person
/// search found: their picture large, their name, job title and role on
/// the team; what they have done as tiles (tasks, active tasks, active
/// days in the last 30, when they were last active); their tokens over
/// the past hour, day, week and month, summed across providers and
/// models; then the tasks they were last at, each opening its chat. A
/// conversation's detail draws the same way, so its pieces are reused, at
/// `SessionDetailLayout`'s frames. Read once as it opens
/// (`GET /v0/users/:id/profile`); a refusal says why under the name.
final class UserProfileViewController: UIViewController {
    private let session: Session
    private let userId: String
    private var user: AgentWire.ProfileUser
    private var profile: AgentWire.UserProfile?
    private var failure: String?
    private var loading: Task<Void, Never>?

    private let scroll = DetailScrollView()
    let header = ProfileHeaderView()
    private let tiles = (0..<4).map { _ in DetailTileView() }
    private lazy var sections = ProfileSections(in: scroll)
    private let tasksHeading = DetailTileView.heading()
    private let tasksCard = DetailActivityCardView()

    /// Only a Happy Cloud server has profiles; a computer of one's own has
    /// no team to show.
    static func offered(_ session: Session) -> Bool { session.isCloud }

    /// `user` is what the opener already knows of them (a search's name,
    /// the cached picture), drawn until the profile is read.
    init(session: Session, user: TeamUser) {
        self.session = session
        userId = user.id
        self.user = AgentWire.ProfileUser(id: user.id, name: user.name, photo: user.photo)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "user-profile"
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        header.images = session.images
        header.mark.round = true
        scroll.addSubview(header)
        for (tile, id) in zip(tiles, ["tasks", "active", "days", "last"]) {
            tile.accessibilityIdentifier = "user-profile-tile:\(id)"
            scroll.addSubview(tile)
        }
        tasksHeading.text = Strings.UserProfile.lastActivity.uppercased()
        scroll.addSubview(tasksHeading)
        tasksCard.accessibilityIdentifier = "user-profile-tasks"
        tasksCard.onSelect = { [weak self] index in self?.openTask(index) }
        scroll.addSubview(tasksCard)
        navigationItem.largeTitleDisplayMode = .never
        apply()
        load()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController == nil { loading?.cancel() }
    }

    private func load() {
        let client = session.client
        let userId = userId
        loading = Task { [weak self] in
            do {
                let read = try await client.userProfile(userId)
                guard let self, !Task.isCancelled else { return }
                profile = read
                user = read.user
                failure = nil
            } catch {
                guard let self, !Task.isCancelled else { return }
                failure = Self.message(error)
            }
            self?.apply()
        }
    }

    /// Why a profile wasn't read, in the person's words.
    static func message(_ error: Error) -> String {
        switch error as? AgentClientError {
        case .status(403, _, _)?: Strings.UserProfile.notAllowed
        case .status(404, _, _)?: Strings.UserProfile.notFound
        default: Strings.UserProfile.failed
        }
    }

    // MARK: What it shows

    private func apply() {
        header.name.text = user.name.isEmpty ? Strings.none : user.name
        header.subtitle.text = failure ?? [user.role?.trimmingCharacters(in: .whitespacesAndNewlines), profile.map { _ in Strings.UserProfile.teamRole(user.teamRole) }]
            .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
        header.avatar = .mark(Self.mark(user, me: session.home.userId, myPhoto: session.home.profilePhoto))
        applyNumbers()
        applyTasks()
        view.setNeedsLayout()
    }

    /// Their picture over its ThumbHash, else the placeholder their user ID
    /// picks, as their tasks wear it (`SidebarRows.authorMark`).
    static func mark(_ user: AgentWire.ProfileUser, me: String?, myPhoto: String?) -> Row.Mark {
        let thumbhash = user.photo?.thumbhash ?? (user.id == me ? myPhoto : nil)
        guard let thumbhash else { return .placeholder(seed: user.id) }
        return .image(path: TeamUser.photoPath(user.id), thumbhash: thumbhash)
    }

    private func applyNumbers() {
        typealias Text = Strings.UserProfile
        let stats = profile?.stats
        let now = Date().timeIntervalSince1970 * 1000
        let values: [(String, String)] = [
            (stats.map { "\($0.tasks.total)" } ?? Strings.none, Text.tasks),
            (stats.map { "\($0.tasks.active)" } ?? Strings.none, Text.activeTasks),
            (stats.map { Text.activeDays($0.activeDays) } ?? Strings.none, Text.activeDays),
            (stats?.lastActivityAt.map { Text.ago(DetailFormat.age(since: $0, now: now)) } ?? Strings.none, Text.lastActive),
        ]
        for (tile, (value, label)) in zip(tiles, values) { tile.show(value: value, label: label) }
        sections.show(stats.map { stats in
            [ProfileSection(id: "tokens", heading: Text.tokens, rows: AgentWire.UsageWindow.allCases.map { window in
                SettingsRow(id: "tokens-\(window.rawValue)", title: Text.window(window), value: DetailFormat.tokens(stats.tokens(window)), accessory: .none)
            })]
        } ?? [])
    }

    private var tasks: [AgentWire.Task] { profile?.recentTasks ?? [] }

    private func applyTasks() {
        let now = Date().timeIntervalSince1970 * 1000
        tasksCard.show(tasks.map { task in
            let agent = task.agent
            let archived = agent?.archivedAt != nil
            let when = agent?.activityAt.map { Strings.UserProfile.ago(DetailFormat.age(since: $0, now: now)) }
            return .init(glyph: "agents", tile: agent?.isWorking == true && !archived ? .purple : .gray, title: Self.title(task),
                         meta: [agent.map { Strings.activityStatus($0.status, archived: archived) }, when].compactMap { $0 }.joined(separator: " · "),
                         opens: agent != nil, id: "user-profile-task:\(task.id)")
        }, disclosure: nil)
    }

    private static func title(_ task: AgentWire.Task) -> String {
        let name = task.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        return task.agent?.title ?? Strings.UserProfile.untitledTask
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if scroll.frame != view.bounds { scroll.frame = view.bounds }
        let width = scroll.readableColumn(width: view.bounds.width)
        let layout = SessionDetailLayout(
            width: width, nameHeight: header.nameHeight, nameWidth: header.nameWidth, subtitleHeight: header.subtitleHeight,
            tiles: tiles.count, sections: sections.specs(width: width), family: nil, running: tasks.count, completed: 0, open: false
        )
        header.place(layout.header, width: width)
        for (tile, frame) in zip(tiles, layout.tiles) { tile.place(frame) }
        sections.place(layout.sections)
        tasksHeading.isHidden = layout.activityHeading == nil
        if let frame = layout.activityHeading { tasksHeading.frame = frame }
        tasksCard.isHidden = layout.running == nil
        if let card = layout.running { tasksCard.place(card) }
        let size = CGSize(width: width, height: layout.contentHeight)
        if scroll.contentSize != size { scroll.contentSize = size }
    }

    // MARK: Acts

    /// A task opens its chat, as the Feed opens one (`FeedOpening`).
    private func openTask(_ index: Int) {
        guard tasks.indices.contains(index), let agentId = tasks[index].agent?.id else { return }
        let home = session.home.allRows.first { $0.agentId == agentId && $0.kind == .space }
        session.warm.tap(agentId)
        navigationController?.pushViewController(ChatViewController(session: session, agentId: agentId, title: Self.title(tasks[index]), spaceId: home?.spaceId, intro: nil), animated: true)
    }

    // MARK: Tests

    var shownTiles: [String?] { tiles.map(\.accessibilityValue) }
    var shownTaskCount: Int { tasks.count }
    func selectTask(_ index: Int) { openTask(index) }
}
#endif
