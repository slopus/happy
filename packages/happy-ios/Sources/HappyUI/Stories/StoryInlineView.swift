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
/// viewer's own canvas, followed live. A draft has Post and Edit under it,
/// Post turning to a spinner while it posts; posted, it reads "Posted"
/// after a story ring and opens the viewer; deleted, a mark and the words
/// say so where it was, as Telegram marks a story no longer there. Each
/// change crossfades.
final class StoryInlineView: UIView {
    private let canvas = StoryCanvasView()
    private let placeholder = UIView()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let postButton = UIButton(type: .system)
    private let editButton = UIButton(type: .system)
    private let status = UILabel()
    private let ring = UIImageView(image: StoryInlineView.ringImage)
    private let notice = UIImageView(image: StoryInlineView.goneImage.withRenderingMode(.alwaysTemplate))
    private let postSpinner = UIActivityIndicatorView(style: .medium)
    /// What was last drawn, so a change can crossfade.
    private var drawnState: String?
    private var storyId: String?
    private weak var session: StoriesSession?
    private var watch: Watch?
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
        notice.tintColor = UIColor(Palette.textSecondary)
        notice.isHidden = true
        placeholder.addSubview(notice)
        ring.isHidden = true
        addSubview(ring)
        postSpinner.hidesWhenStopped = true
        addSubview(postSpinner)
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
        // Another story, or none: nothing to crossfade from.
        drawnState = nil
        postSpinner.stopAnimating()
        if id == nil { spinner.stopAnimating() }
        attach()
        if watch == nil { render(nil) }
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
        notice.isHidden = message.text == nil
        let isDraft = shown?.status == .draft
        let mayPost = isDraft && isAuthor
        postButton.isHidden = !mayPost || posting
        editButton.isHidden = !mayPost
        editButton.isEnabled = !posting
        if mayPost, posting { postSpinner.startAnimating() } else { postSpinner.stopAnimating() }
        status.isHidden = mayPost
        status.text = switch shown?.status {
        case .posted: Strings.Stories.posted
        case .draft: Strings.Stories.draft
        default: nil
        }
        ring.isHidden = shown?.status != .posted
        // A story that changes state while in sight crossfades to it; the
        // placeholder drawn before the first snapshot is no state to leave.
        let state = mayPost && posting ? "posting" : shown.map(\.status.rawValue) ?? message.text ?? "loading"
        if let drawnState, drawnState != state, window != nil {
            UIView.transition(with: self, duration: 0.2, options: [.transitionCrossDissolve, .allowUserInteraction], animations: nil)
        }
        if snapshot != nil { drawnState = state }
        accessibilityValue = shown.map { "\($0.status.rawValue)#\($0.artifactVersion)" } ?? (story?.status == .deleted && !off ? "deleted" : gone ? "gone" : "loading")
        accessibilityLabel = shown?.caption
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = StoryCardLayout(width: bounds.width)
        canvas.frame = layout.canvas
        placeholder.frame = layout.canvas
        notice.frame = layout.notice
        if notice.isHidden {
            message.frame = placeholder.bounds.insetBy(dx: StoryCardLayout.Metrics.noticeInset, dy: 0)
        } else {
            let fits = message.sizeThatFits(CGSize(width: layout.noticeText.width, height: .greatestFiniteMagnitude))
            message.frame = CGRect(x: layout.noticeText.minX, y: layout.noticeText.minY, width: layout.noticeText.width, height: min(layout.noticeText.height, ceil(fits.height)))
        }
        spinner.center = CGPoint(x: placeholder.bounds.midX, y: placeholder.bounds.midY)
        postButton.frame = layout.post
        postSpinner.center = CGPoint(x: layout.post.minX + postSpinner.bounds.width / 2, y: layout.post.midY)
        editButton.frame = layout.edit
        ring.frame = layout.ring
        status.frame = ring.isHidden ? layout.label : layout.postedLabel
    }

    // MARK: Marks

    /// The row's unseen ring, small: a posted story's.
    static let ringImage: UIImage = {
        let size = StoryCardLayout.Metrics.ring
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { context in
            let cg = context.cgContext
            let width: CGFloat = 2
            cg.addEllipse(in: CGRect(x: 0, y: 0, width: size, height: size).insetBy(dx: width / 2, dy: width / 2))
            cg.setLineWidth(width)
            cg.replacePathWithStrokedPath()
            cg.clip()
            let colors = [UIColor(Palette.storiesUnseenTop).cgColor, UIColor(Palette.storiesUnseenBottom).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: nil, colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size), options: [])
            }
        }
    }()

    /// A story no longer there: a seen ring broken into dashes, struck through.
    static let goneImage: UIImage = {
        let size = StoryCardLayout.Metrics.notice
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { context in
            let cg = context.cgContext
            cg.setStrokeColor(UIColor.black.cgColor)
            cg.setLineCap(.round)
            cg.setLineWidth(2)
            let circle = CGRect(x: 0, y: 0, width: size, height: size).insetBy(dx: 3, dy: 3)
            let circumference = .pi * circle.width
            cg.setLineDash(phase: 0, lengths: [circumference / 12 - 4, 4])
            cg.strokeEllipse(in: circle)
            cg.setLineDash(phase: 0, lengths: [])
            cg.move(to: CGPoint(x: size * 0.28, y: size * 0.28))
            cg.addLine(to: CGPoint(x: size * 0.72, y: size * 0.72))
            cg.strokePath()
        }
    }()

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
