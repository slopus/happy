#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A document's permanent change log, newest first: who made each change,
/// when, and how big it was. Choosing one shows the document as it stood
/// right after it.
@MainActor
final class DocumentHistoryViewController: UITableViewController {
    private let session: Session
    private let surfaceId: String
    private let name: String
    private var changes: [DocumentChange] = []
    private var users: [String: TeamUser] = [:]
    private var faces: [String: UIImage] = [:]
    private let empty = UILabel()

    init(session: Session, surfaceId: String, name: String) {
        self.session = session
        self.surfaceId = surfaceId
        self.name = name
        super.init(style: .plain)
        navigationItem.title = Strings.Documents.historyTitle
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(DocumentHistoryCell.self, forCellReuseIdentifier: DocumentHistoryCell.reuse)
        tableView.accessibilityIdentifier = "document.history"
        empty.text = Strings.Documents.loading
        empty.textAlignment = .center
        empty.textColor = UIColor(Palette.documentSecondary)
        empty.font = .preferredFont(forTextStyle: .subheadline)
        empty.adjustsFontForContentSizeCategory = true
        tableView.backgroundView = empty
        load()
    }

    private func load() {
        let client = session.client
        let surfaceId = surfaceId
        Task { [weak self] in
            // Every page, read off the main thread; a long log is a few of them.
            let read = await Task.detached { () -> [DocumentChange]? in
                var all: [DocumentChange] = []
                var after = 0
                while true {
                    guard let page = try? await client.documentChanges(surfaceId, afterSeq: after) else { return all.isEmpty ? nil : all }
                    all += page.changes
                    guard let next = page.next, next > after else { break }
                    after = next
                }
                return all.reversed()
            }.value
            guard let self else { return }
            self.changes = read ?? []
            self.empty.text = read == nil ? Strings.Documents.unavailable : Strings.Documents.historyEmpty
            self.tableView.backgroundView?.isHidden = !(read ?? []).isEmpty
            self.tableView.reloadData()
            self.loadAuthors()
        }
    }

    private func loadAuthors() {
        let ids = Array(Set(changes.compactMap(\.actor.userId)))
        guard !ids.isEmpty else { return }
        let client = session.client
        let images = session.images
        Task { [weak self] in
            let users = (try? await client.teamUsers(ids)) ?? []
            guard let self else { return }
            for user in users { self.users[user.id] = user }
            self.reconfigureAll()
            for user in users {
                guard let image = await images.picture(TeamUser.photoPath(user.id), thumbhash: user.photo?.thumbhash, pixels: 108) else { continue }
                self.faces[user.id] = image
                self.reconfigureAll()
            }
        }
    }

    private func reconfigureAll() {
        guard let visible = tableView.indexPathsForVisibleRows, !visible.isEmpty else { return }
        tableView.reconfigureRows(at: visible)
    }

    private func author(_ change: DocumentChange) -> String {
        if change.source == "conversion" { return Strings.Documents.conversion }
        if let id = change.actor.userId, let user = users[id], !user.name.isEmpty { return change.actor.agentId == nil ? user.name : "\(user.name) · \(Strings.Documents.agent)" }
        if change.actor.agentId != nil || change.source == "tool" { return Strings.Documents.agent }
        return Strings.Documents.someone
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { changes.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: DocumentHistoryCell.reuse, for: indexPath) as! DocumentHistoryCell
        let change = changes[indexPath.row]
        let when = Date(timeIntervalSince1970: change.createdAt / 1000).formatted(date: .abbreviated, time: .shortened)
        let detail = indexPath.row == 0 ? "\(when) · \(Strings.Documents.current)" : "\(when) · \(Strings.Documents.size(change.size))"
        cell.show(title: author(change), detail: detail, face: change.actor.userId.flatMap { faces[$0] }, seed: change.actor.userId ?? change.actor.agentId ?? "agent")
        cell.accessibilityIdentifier = "document.history.\(change.seq)"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let change = changes[indexPath.row]
        let version = DocumentVersionViewController(session: session, surfaceId: surfaceId, seq: change.seq, title: author(change))
        navigationController?.pushViewController(version, animated: true)
    }
}

final class DocumentHistoryCell: UITableViewCell {
    static let reuse = "DocumentHistoryCell"
    private let face = UIImageView()
    private let initial = UILabel()
    private let title = UILabel()
    private let detail = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        face.layer.cornerRadius = DocumentHistoryRowLayout.Metrics.avatar / 2
        face.clipsToBounds = true
        face.contentMode = .scaleAspectFill
        initial.textAlignment = .center
        initial.font = .systemFont(ofSize: 15, weight: .semibold)
        initial.textColor = .white
        title.font = .preferredFont(forTextStyle: .body)
        title.adjustsFontForContentSizeCategory = true
        title.textColor = UIColor(Palette.documentText)
        detail.font = .preferredFont(forTextStyle: .footnote)
        detail.adjustsFontForContentSizeCategory = true
        detail.textColor = UIColor(Palette.documentSecondary)
        face.addSubview(initial)
        [face, title, detail].forEach(contentView.addSubview)
        accessoryType = .disclosureIndicator
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func show(title: String, detail: String, face image: UIImage?, seed: String) {
        self.title.text = title
        self.detail.text = detail
        face.image = image
        face.backgroundColor = image == nil ? DocumentPeersView.uiColor(DocumentPeersView.color(for: seed)) : nil
        initial.text = image == nil ? title.first.map { String($0).uppercased() } : nil
        isAccessibilityElement = true
        accessibilityLabel = "\(title), \(detail)"
        accessibilityTraits = .button
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> DocumentHistoryRowLayout {
        DocumentHistoryRowLayout(width: width, safeArea: .zero,
                                 title: Measurable { [title] w in title.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)) },
                                 detail: Measurable { [detail] w in detail.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)) })
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: layout(width: size.width).height)
    }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority h: UILayoutPriority, verticalFittingPriority v: UILayoutPriority) -> CGSize {
        sizeThatFits(targetSize)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: contentView.bounds.width)
        face.frame = layout.avatar
        initial.frame = face.bounds
        title.frame = layout.title
        detail.frame = layout.detail
    }
}

/// The document as it stood right after one change, read-only.
@MainActor
final class DocumentVersionViewController: UIViewController {
    private let session: Session
    private let surfaceId: String
    private let seq: Int
    private let textView = DocumentTextView()
    private let status = UILabel()

    init(session: Session, surfaceId: String, seq: Int, title: String) {
        self.session = session
        self.surfaceId = surfaceId
        self.seq = seq
        super.init(nibName: nil, bundle: nil)
        navigationItem.title = Strings.Documents.version(seq)
        navigationItem.subtitle = title
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.documentGround)
        textView.isEditable = false
        textView.accessibilityIdentifier = "document.version"
        view.addSubview(textView)
        status.text = Strings.Documents.loading
        status.textAlignment = .center
        status.numberOfLines = 0
        status.textColor = UIColor(Palette.documentSecondary)
        status.font = .preferredFont(forTextStyle: .subheadline)
        view.addSubview(status)
        let client = session.client
        let surfaceId = surfaceId
        let seq = seq
        let style = DocumentStyle(traits: traitCollection)
        Task { [weak self] in
            // Read and drawn off the main thread: a whole document, once.
            let text = await Task.detached { () -> DocumentViewController.Box? in
                guard let state = try? await client.documentState(surfaceId, seq: seq) else { return nil }
                let doc = YDoc()
                guard (try? doc.applyUpdate(state.update)) != nil else { return nil }
                return DocumentViewController.Box(style.document(DocumentEditor.flatten(DocumentReader.blocks(doc))))
            }.value
            guard let self else { return }
            if let text {
                self.textView.attributedText = text.value
                self.status.isHidden = true
            } else {
                self.status.text = Strings.Documents.unavailable
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = DocumentScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), keyboard: 0,
                                          maxWidth: ContentWidthLimit.maxWidth(isPad: traitCollection.userInterfaceIdiom == .pad),
                                          status: Measurable { [status] width in status.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)) })
        textView.frame = layout.text
        textView.textContainerInset = UIEdgeInsets(top: layout.inset.top, left: layout.inset.left, bottom: layout.inset.bottom, right: layout.inset.right)
        status.frame = layout.status
    }
}

/// Where a document Surface opens (`SurfaceScreens`).
@MainActor
enum DocumentScreens {
    static func make(session: Session, surfaceId: String, name: String) -> UIViewController {
        DocumentViewController(session: session, surfaceId: surfaceId, name: name)
    }
}
#endif
