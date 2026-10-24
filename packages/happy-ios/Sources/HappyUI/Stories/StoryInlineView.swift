#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The screen whose computer's Stories an inline story reads, found up the
/// responder chain from it.
@MainActor
protocol StoriesProviding: AnyObject {
    var stories: StoriesSession? { get }
}

/// A story drawn inline in a conversation, as `draft_story` presents it
/// (happy-agent `API.md` "The inline draft"): its first frame drawn by the
/// viewer's own canvas, followed live. A draft has Post and Edit under it;
/// posted, it reads "Posted" and opens the viewer; deleted, it says so.
final class StoryInlineView: UIView {
    private let canvas = StoryCanvasView()
    private let placeholder = UIView()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let postButton = UIButton(type: .system)
    private let editButton = UIButton(type: .system)
    private let status = UILabel()
    private var storyId: String?
    private weak var session: StoriesSession?
    private var watch: StemCellsWatch?
    private var story: Story?
    private var posting = false
    /// The person reading is the story's author, so a draft is theirs to post.
    private var isAuthor = false
    /// Whether the store was asked for the story while it could answer.
    private var asked = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        canvas.layer.cornerRadius = StoryCardLayout.Metrics.cornerRadius
        canvas.layer.cornerCurve = .continuous
        canvas.isHidden = true
        addSubview(canvas)
        placeholder.backgroundColor = UIColor(Palette.surfacePressed)
        placeholder.layer.cornerRadius = StoryCardLayout.Metrics.cornerRadius
        placeholder.layer.cornerCurve = .continuous
        addSubview(placeholder)
        message.font = .systemFont(ofSize: 13)
        message.textColor = UIColor(Palette.textSecondary)
        message.textAlignment = .center
        message.numberOfLines = 0
        placeholder.addSubview(message)
        placeholder.addSubview(spinner)
        for (button, title, id) in [(postButton, Strings.Stories.post, "story-inline-post"), (editButton, Strings.Stories.edit, "story-inline-edit")] {
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            button.contentHorizontalAlignment = .leading
            button.accessibilityIdentifier = id
            addSubview(button)
        }
        postButton.addTarget(self, action: #selector(postTapped), for: .touchUpInside)
        editButton.addTarget(self, action: #selector(editTapped), for: .touchUpInside)
        status.font = .systemFont(ofSize: 13, weight: .medium)
        status.textColor = UIColor(Palette.textSecondary)
        status.accessibilityIdentifier = "story-inline-status"
        addSubview(status)
        canvas.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(canvasTapped)))
        canvas.isUserInteractionEnabled = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows the story `id`, or nothing.
    func apply(_ id: String?) {
        guard id != storyId else { return }
        storyId = id
        story = nil
        posting = false
        accessibilityIdentifier = id.map { "story-inline:\($0)" }
        watch?.invalidate(); watch = nil
        canvas.stop()
        render(nil)
        attach()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            watch?.invalidate(); watch = nil
        } else {
            attach()
        }
    }

    private func attach() {
        guard watch == nil, window != nil, storyId != nil, let session = provider() else { return }
        self.session = session
        asked = false
        watch = session.watch { [weak self] snapshot in self?.render(snapshot) }
    }

    /// Asks the store for the story while it is missing, again each time
    /// the connection comes back, so a read lost offline is made later.
    private func want(_ snapshot: StoriesSnapshot) {
        guard let storyId, let session else { return }
        guard snapshot.isOn, snapshot.stories[storyId] == nil, !snapshot.gone.contains(storyId) else { return }
        guard !asked || !wasLive && snapshot.live else { wasLive = snapshot.live; return }
        asked = true
        wasLive = snapshot.live
        let store = session.store
        Task { await store.want(storyId) }
    }

    private var wasLive = false

    private func provider() -> StoriesSession? {
        var responder: UIResponder? = self
        while let current = responder {
            if let provider = current as? StoriesProviding { return provider.stories }
            responder = current.next
        }
        return nil
    }

    private var host: UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { return controller }
            responder = current.next
        }
        return nil
    }

    // MARK: Drawing

    private func render(_ snapshot: StoriesSnapshot?) {
        guard let storyId else { return }
        if let snapshot { want(snapshot) }
        let story = snapshot?.stories[storyId]
        let off = snapshot.map { $0.availability == .off || $0.availability == .unsupported } ?? false
        let gone = off || snapshot?.gone.contains(storyId) == true
        self.story = story
        let shown = off ? nil : story.flatMap { $0.status == .deleted ? nil : $0 }
        // In standalone mode there is no user ID, and every story is the person's.
        let mine = snapshot?.feed?.authors.first(where: \.isSelf)?.userId
        isAuthor = shown.map { $0.authorUserId == nil || $0.authorUserId == mine } ?? false
        canvas.isHidden = shown == nil
        placeholder.isHidden = shown != nil
        if let shown, let frame = shown.frames.first {
            canvas.show(shown, frame: frame, media: session?.media, playsVideo: false)
        }
        if story?.status == .deleted, !off {
            message.text = Strings.Stories.deleted
        } else if gone {
            message.text = Strings.Stories.unavailable
        } else {
            message.text = nil
        }
        if message.text == nil, shown == nil { spinner.startAnimating() } else { spinner.stopAnimating() }
        let isDraft = shown?.status == .draft
        let mayPost = isDraft && isAuthor
        postButton.isHidden = !mayPost
        editButton.isHidden = !mayPost
        postButton.isEnabled = !posting
        editButton.isEnabled = !posting
        status.isHidden = mayPost
        status.text = switch shown?.status {
        case .posted: Strings.Stories.posted
        case .draft: Strings.Stories.draft
        default: nil
        }
        accessibilityValue = shown.map { "\($0.status.rawValue)#\($0.artifactVersion)" } ?? (gone ? "gone" : "loading")
        accessibilityLabel = shown?.caption
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = StoryCardLayout(width: bounds.width)
        canvas.frame = layout.canvas
        placeholder.frame = layout.canvas
        message.frame = placeholder.bounds.insetBy(dx: 16, dy: 0)
        spinner.center = CGPoint(x: placeholder.bounds.midX, y: placeholder.bounds.midY)
        postButton.frame = layout.post
        editButton.frame = layout.edit
        status.frame = layout.label
    }

    // MARK: Acts

    @objc private func canvasTapped() {
        guard let story, let session, let host else { return }
        switch story.status {
        case .posted: StoriesViewerPresenter.present(session: session, story: story, from: host, origin: canvas)
        case .draft: if isAuthor { editTapped() }
        case .deleted: break
        }
    }

    /// Posts the version shown; a refusal says why and the draft stays.
    @objc private func postTapped() {
        guard let story, story.status == .draft, isAuthor, let session, !posting else { return }
        posting = true
        render(session.snapshot)
        StoriesHaptics.prepare(.post, .refused)
        let store = session.store
        let id = story.id
        Task { [weak self] in
            do {
                _ = try await store.post(id, artifactVersion: story.artifactVersion)
                self?.posted(id, refusal: nil)
            } catch {
                self?.posted(id, refusal: StoryRefusal(error)?.isConflict == true ? Strings.Stories.newerVersion : Strings.Stories.postFailed)
            }
        }
    }

    private func posted(_ id: String, refusal: String?) {
        guard storyId == id, window != nil else { return }
        StoriesHaptics.play(refusal == nil ? .post : .refused)
        posting = false
        if let session { render(session.snapshot) }
        guard let refusal, let host else { return }
        let alert = UIAlertController(title: refusal, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
        host.present(alert, animated: true)
    }

    @objc private func editTapped() {
        guard let story, story.status == .draft, isAuthor, !posting, let session, let host else { return }
        StoriesEditorPresenter.present(session: session, draft: story, from: host)
    }
}
#endif
