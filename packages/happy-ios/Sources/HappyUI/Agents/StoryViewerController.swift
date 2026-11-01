#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// Stories by poster, oldest first. Media pauses while replying or reading replies.
@MainActor
final class StoryViewerController: UIViewController, UITextFieldDelegate, UIGestureRecognizerDelegate {
    private let engine: SyncEngine
    private let library: MediaLibrary?
    private let images: Images?
    private let seen: @MainActor (String) -> Void
    private let posters: [StoryPoster]
    private var pages: [(poster: Int, story: Story)]
    /// Names by ID: members who replied, agents whose stories were reposted.
    var names: [String: String] {
        didSet { if let drawer { drawer.attributedText = transcript(drawerReplies, color: .label) } }
    }
    var me: String?
    private(set) var index: Int
    private let picture = UIImageView()
    private let video = StoryPlayerView()
    private let roundVideo = StoryPlayerView()
    private var player: AVPlayer?
    private var roundPlayer: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var failure: NSKeyValueObservation?
    /// The open replies sheet, and what it lists.
    private weak var drawer: UITextView?
    private var drawerReplies: [Story.Reply] = []
    /// The videos' bytes; their assets hold them only weakly.
    private var streams: [MediaStream] = []
    private var segments: [UIProgressView] = []
    private var shownPoster: Int?
    private let topShade = CAGradientLayer(), bottomShade = CAGradientLayer()
    private let mark = StoryMarkView()
    private let name = UILabel()
    private let mute = UIButton(type: .system), more = MenuButton(type: .system), close = UIButton(type: .system)
    private let chip = UILabel()
    private let caption = UILabel()
    private let replies = UILabel()
    private let reply = UITextField()
    private var loading: Task<Void, Never>?
    /// How long the shown picture has been on screen; nil until it is.
    private var elapsed: Double?
    private var clock: CADisplayLink?
    private var held = false
    private var keyboard: CGFloat = 0
    private static var muted = false

    init(engine: SyncEngine, library: MediaLibrary?, images: Images?, posters: [StoryPoster], start: Int, names: [String: String], seen: (@MainActor (String) -> Void)? = nil) {
        (self.engine, self.library, self.images, self.posters, self.names) = (engine, library, images, posters, names)
        self.seen = seen ?? { id in Task { await engine.markStorySeen(id) } }
        pages = posters.enumerated().flatMap { offset, poster in poster.stories.map { (offset, $0) } }
        index = pages.firstIndex { $0.poster == start && !$0.story.seen } ?? pages.firstIndex { $0.poster == start } ?? 0
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        (picture.contentMode, picture.clipsToBounds, roundVideo.clipsToBounds) = (.scaleAspectFill, true, true)
        (video.playerLayer.videoGravity, roundVideo.playerLayer.videoGravity) = (.resizeAspectFill, .resizeAspectFill)
        (roundVideo.layer.cornerRadius, roundVideo.layer.borderWidth, roundVideo.layer.borderColor) = (StoryLayout.Metrics.round / 2, 2, UIColor.white.cgColor)
        topShade.colors = [UIColor.black.withAlphaComponent(0.55).cgColor, UIColor.clear.cgColor]
        bottomShade.colors = [UIColor.clear.cgColor, UIColor.black.withAlphaComponent(0.6).cgColor]
        (name.font, caption.font, caption.numberOfLines, chip.font) = (.systemFont(ofSize: 15, weight: .semibold), .systemFont(ofSize: 16), 0, .systemFont(ofSize: 13, weight: .medium))
        (chip.backgroundColor, chip.textAlignment, chip.clipsToBounds, chip.layer.cornerRadius) = (UIColor.black.withAlphaComponent(0.45), .center, true, StoryLayout.Metrics.chip / 2)
        for label in [name, caption, chip] { label.textColor = .white }
        for label in [name, caption] { (label.layer.shadowOpacity, label.layer.shadowRadius, label.layer.shadowOffset) = (0.5, 3, .zero) }
        close.setImage(Glyphs.image("close", size: 24), for: .normal)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.accessibilityLabel = Strings.close
        more.setImage(UIImage(systemName: "ellipsis"), for: .normal)
        more.showsMenuAsPrimaryAction = true
        mute.addTarget(self, action: #selector(muteTapped), for: .touchUpInside)
        for button in [close, more, mute] { button.tintColor = .white }
        (replies.numberOfLines, replies.isUserInteractionEnabled, replies.accessibilityTraits) = (0, true, .button)
        replies.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openReplies)))
        reply.delegate = self
        (reply.returnKeyType, reply.textColor, reply.font) = (.send, .white, .systemFont(ofSize: 16))
        (reply.layer.cornerRadius, reply.layer.borderWidth, reply.layer.borderColor) = (StoryLayout.Metrics.bar / 2, 1, UIColor.white.withAlphaComponent(0.5).cgColor)
        (reply.leftView, reply.leftViewMode) = (UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 1)), .always)
        for view in [picture, video, mark, name, mute, more, close, chip, roundVideo, caption, replies, reply] { self.view.addSubview(view) }
        // The shades go over the media and under the words.
        for shade in [topShade, bottomShade] { view.layer.insertSublayer(shade, above: video.layer) }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        view.addGestureRecognizer(tap)
        for name in [AVPlayerItem.didPlayToEndTimeNotification, AVPlayerItem.failedToPlayToEndTimeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(playerItemEnded(_:)), name: name, object: nil)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        show(index)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard showing else { return }
        clock?.invalidate()
        clock = CADisplayLink(target: self, selector: #selector(tick))
        clock?.add(to: .main, forMode: .common)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed { stop() }
    }

    private func stop() {
        clock?.invalidate()
        clock = nil
        loading?.cancel()
        for player in [player, roundPlayer] { player?.pause() }
    }

    func leave() {
        stop()
        (presentingViewController ?? self).dismiss(animated: true)
    }

    private var showing: Bool { pages.indices.contains(index) }
    var ticking: Bool { clock != nil }
    var playing: Bool { [player, roundPlayer].contains { ($0?.rate ?? 0) > 0 } }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard showing else { return }
        let width = view.bounds.width - 2 * StoryLayout.Metrics.captionInset
        let fits = { (label: UIView) in label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height.rounded(.up) }
        let story = pages[index].story
        let layout = StoryLayout.viewer(
            size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), count: segments.count,
            nameHeight: name.font.lineHeight.rounded(.up), captionHeight: caption.text == nil ? 0 : fits(caption),
            repliesHeight: replies.isHidden ? 0 : fits(replies),
            chipWidth: chip.text == nil ? 0 : chip.intrinsicContentSize.width + 20, round: story.round != nil, keyboard: keyboard
        )
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        (topShade.frame, bottomShade.frame) = (layout.topShade, layout.bottomShade)
        CATransaction.commit()
        (picture.frame, video.frame, mark.frame, name.frame) = (view.bounds, view.bounds, layout.mark, layout.name)
        (mute.frame, more.frame, close.frame, chip.frame, roundVideo.frame) = (layout.mute, layout.more, layout.close, layout.chip, layout.round)
        (caption.frame, replies.frame, reply.frame) = (layout.caption, layout.replies, layout.bar)
        mark.layer.cornerRadius = posters[pages[index].poster].person ? layout.mark.width / 2 : StoryLayout.Metrics.markRadius
        for (segment, frame) in zip(segments, layout.segments) { segment.frame = frame }
    }

    // MARK: Showing

    private func show(_ next: Int) {
        index = next
        applySegments()
        let story = pages[next].story
        loading?.cancel()
        player?.pause()
        roundPlayer?.pause()
        (player, roundPlayer, looper, streams, failure, video.playerLayer.player, roundVideo.playerLayer.player, picture.image, elapsed) = (nil, nil, nil, [], nil, nil, nil, nil, nil)
        reply.text = nil
        applyWords()
        seen(story.id)
        if story.isVideo, let library {
            let item = AVPlayerItem(asset: stream(story, round: false, library).asset())
            failure = item.observe(\.status) { item, _ in
                if item.status == .failed { NotificationCenter.default.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: item) }
            }
            player = AVPlayer(playerItem: item)
            video.playerLayer.player = player
        } else {
            loading = Task { [weak self, client = engine.client] in
                let body = story.isVideo ? nil : try? await client.storyMedia(story.id).body
                guard !Task.isCancelled else { return }
                self?.picture.image = body.flatMap(UIImage.init(data:))
                self?.elapsed = 0
            }
        }
        if story.round != nil, let library {
            let queue = AVQueuePlayer()
            looper = AVPlayerLooper(player: queue, templateItem: AVPlayerItem(asset: stream(story, round: true, library).asset()))
            roundPlayer = queue
            roundVideo.playerLayer.player = queue
        }
        roundVideo.isHidden = roundPlayer == nil
        mute.isHidden = player == nil && roundPlayer == nil
        applyMute()
        if !held { player?.play(); roundPlayer?.play() }
    }

    private func stream(_ story: Story, round: Bool, _ library: MediaLibrary) -> MediaStream {
        let stream = MediaStream(downloads: library.downloads, id: "story/\(story.id)\(round ? "/round" : "")", source: engine.client.storySource(story, round: round), name: "story.mp4", mimeType: round ? "video/mp4" : story.media.mimeType)
        streams.append(stream)
        return stream
    }

    private func applySegments() {
        let poster = pages[index].poster, count = pages.filter { $0.poster == poster }.count
        guard poster != shownPoster || count != segments.count else { return }
        if poster != shownPoster { mark.show(posters[poster].mark, images: images) }
        shownPoster = poster
        segments.forEach { $0.removeFromSuperview() }
        segments = (0..<count).map { _ in UIProgressView(progressViewStyle: .bar) }
        for segment in segments { (segment.trackTintColor, segment.progressTintColor) = (UIColor.white.withAlphaComponent(0.35), .white); view.addSubview(segment) }
    }

    private func applyWords() {
        let story = pages[index].story, poster = posters[pages[index].poster]
        let title = NSMutableAttributedString(string: poster.me ? Strings.Stories.you : poster.name)
        title.append(NSAttributedString(string: "  " + Strings.Stories.age(story.postedAt, now: Date()), attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.7), .font: UIFont.systemFont(ofSize: 14)]))
        name.attributedText = title
        caption.text = story.caption?.isEmpty == false ? story.caption : nil
        chip.text = story.isRepost ? Strings.Stories.repostedFrom(story.agentId.flatMap { names[$0] } ?? "") : nil
        chip.isHidden = chip.text == nil
        reply.attributedPlaceholder = NSAttributedString(string: Strings.Stories.replyTo(poster.me ? (story.agentId.flatMap { names[$0] } ?? "") : poster.name), attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.7)])
        let count = story.replyCount ?? 0, shown = transcript(story.replies ?? [], color: .white)
        shown.append(NSAttributedString(string: Strings.Stories.viewAll(count), attributes: [.font: UIFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: UIColor.white.withAlphaComponent(0.75)]))
        replies.attributedText = shown
        replies.isHidden = count == 0
        var actions: [UIAction] = []
        if !story.isRepost { actions.append(UIAction(title: Strings.Stories.repost, image: UIImage(systemName: "arrow.2.squarepath")) { [weak self] _ in self?.repost(story) }) }
        if story.canDelete == true {
            actions.append(UIAction(title: Strings.Stories.delete, image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self, engine] _ in
                Task { do { try await engine.deleteStory(story.id) } catch { self?.failed() } }
            })
        }
        more.menu = UIMenu(children: actions)
        more.isHidden = actions.isEmpty
        view.setNeedsLayout()
    }

    private func transcript(_ replies: [Story.Reply], color: UIColor) -> NSMutableAttributedString {
        let text = NSMutableAttributedString()
        for answer in replies {
            let who = answer.userId == nil || answer.userId == me ? Strings.Stories.you : names[answer.userId!] ?? Strings.Stories.someone
            text.append(NSAttributedString(string: who + "  ", attributes: [.font: UIFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: color]))
            text.append(NSAttributedString(string: answer.text + "\n", attributes: [.font: UIFont.systemFont(ofSize: 14), .foregroundColor: color]))
        }
        return text
    }

    /// Refreshes replies and removes deleted or expired stories without restarting playback.
    func refresh(_ live: [Story]) {
        guard showing else { return }
        let byId = Dictionary(live.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let current = pages[index].story.id
        pages = pages.compactMap { page in byId[page.story.id].map { (page.poster, $0) } }
        guard let at = pages.firstIndex(where: { $0.story.id == current }) else {
            return pages.isEmpty ? leave() : show(min(index, pages.count - 1))
        }
        index = at
        applySegments()
        applyWords()
    }

    /// A video played to its end, or failed: the next story.
    @objc private nonisolated func playerItemEnded(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem else { return }
        let id = ObjectIdentifier(item)
        DispatchQueue.main.async { MainActor.assumeIsolated { if self.playerItem.map(ObjectIdentifier.init) == id { self.step(1) } } }
    }

    var playerItem: AVPlayerItem? { player?.currentItem }

    /// How far the shown story is, 0 to 1: a video by its time, a picture by its clock.
    private var progress: Double {
        if let item = player?.currentItem {
            let duration = item.duration.seconds
            return duration.isFinite && duration > 0 ? item.currentTime().seconds / duration : 0
        }
        return (elapsed ?? 0) / StoryLayout.Metrics.imageDuration
    }

    @objc func tick(_ link: CADisplayLink) {
        guard showing else { return }
        let hold = presentedViewController != nil || reply.isFirstResponder || more.open
        if hold != held {
            held = hold
            for player in [player, roundPlayer] { hold ? player?.pause() : player?.play() }
        }
        if !held, elapsed != nil { elapsed! += link.duration }
        let current = progress
        let first = pages.firstIndex { $0.poster == pages[index].poster } ?? 0
        for (offset, segment) in segments.enumerated() {
            segment.progress = first + offset < index ? 1 : first + offset > index ? 0 : Float(min(current, 1))
        }
        if player == nil, current >= 1 { step(1) }
    }

    private func step(_ by: Int) {
        guard showing else { return }
        if pages.indices.contains(index + by) { return show(index + by) }
        if by > 0 { leave() } else { show(index) }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard showing else { return }
        if reply.isFirstResponder { view.endEditing(true); return }
        step(StoryLayout.step(atX: gesture.location(in: view).x, width: view.bounds.width))
    }

    /// Only the media steps; the bar, the replies and the buttons are their own.
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        [view, picture, video, roundVideo].contains { $0 === touch.view }
    }

    @objc private func closeTapped() { leave() }

    @objc private func muteTapped() { Self.muted.toggle(); applyMute() }

    private func applyMute() {
        player?.isMuted = Self.muted
        roundPlayer?.isMuted = Self.muted
        mute.setImage(UIImage(systemName: Self.muted ? "speaker.slash.fill" : "speaker.wave.2.fill"), for: .normal)
    }

    // MARK: Replies, reposts

    func textFieldShouldReturn(_ field: UITextField) -> Bool {
        let text = field.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard showing, !text.isEmpty else { return false }
        let id = pages[index].story.id
        field.text = nil
        view.endEditing(true)
        Task { [weak self, engine] in
            do { await engine.replied(try await engine.client.replyToStory(id, text: text), to: id) } catch { self?.failed() }
        }
        return true
    }

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        keyboard = max(0, view.bounds.maxY - view.convert(end, from: nil).minY)
        UIView.animate(withDuration: 0.25) { self.view.setNeedsLayout(); self.view.layoutIfNeeded() }
    }

    /// Every reply, oldest first, in a sheet dragged down to close.
    @objc private func openReplies() {
        guard showing else { return }
        let id = pages[index].story.id, sheet = UIViewController(), text = UITextView()
        (text.isEditable, text.backgroundColor, text.textContainerInset) = (false, .systemBackground, UIEdgeInsets(top: 28, left: 16, bottom: 16, right: 16))
        sheet.view = text
        sheet.sheetPresentationController?.detents = [.medium(), .large()]
        sheet.sheetPresentationController?.prefersGrabberVisible = true
        present(sheet, animated: true)
        Task { [weak self, client = engine.client] in
            guard let replies = try? await client.storyReplies(id), let self else { return }
            (self.drawer, drawerReplies) = (text, replies)
            text.attributedText = transcript(replies, color: .label)
            await engine.lookUp(Set(replies.compactMap(\.userId)).subtracting(names.keys).subtracting([me ?? ""]))
        }
    }

    private func repost(_ story: Story) {
        present(StoryRepostController(client: engine.client, storyId: story.id) { [weak self] ok in if !ok { self?.failed() } }, animated: true)
    }

    private func failed() {
        // Mid-transition a presentation is dropped: it waits for the transition to end.
        if let coordinator = (presentedViewController ?? self).transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.failed() }
            return
        }
        let alert = UIAlertController(title: Strings.Stories.failed, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        (presentedViewController ?? self).present(alert, animated: true)
    }
}

/// A ⋯ that knows while its menu is open, for the story to hold still.
private final class MenuButton: UIButton {
    private(set) var open = false
    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        open = true
    }
    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        open = false
    }
}

final class StoryPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
#endif
