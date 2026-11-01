#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// Stories by poster, oldest first. Media pauses while replying or reading replies.
@MainActor
final class StoryViewerController: UIViewController, UITextFieldDelegate, UIGestureRecognizerDelegate {
    var onChat: ((String) -> Void)?
    var agents: [Row] = []
    private let engine: SyncEngine
    private let library: MediaLibrary?
    private let images: Images?
    private let seen: @MainActor (String) -> Void
    private let posters: [StoryPoster]
    private var pages: [(poster: Int, story: Story)]
    /// Names by ID: members who replied, agents whose stories were reposted.
    var names: [String: String] {
        didSet { expanded.attributedText = transcript(allReplies, color: .white) }
    }
    var me: String?
    private(set) var index: Int
    private let picture = UIImageView()
    private let media = UIView()
    private let video = StoryPlayerView()
    private let roundVideo = StoryPlayerView()
    private var player: AVPlayer?
    private var roundPlayer: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var failure: NSKeyValueObservation?
    /// The open replies overlay, and what it lists.
    private let expanded = UITextView(), dim = UIControl()
    private var zoom: CGFloat = 1
    private var zoomOffset = CGPoint.zero
    private let repliesPan = UIPanGestureRecognizer(), pinch = UIPinchGestureRecognizer(), mediaPan = UIPanGestureRecognizer()
    private var allReplies: [Story.Reply] = []
    /// The videos' bytes; their assets hold them only weakly.
    private var streams: [MediaStream] = []
    private var segments: [UIProgressView] = []
    private var shownPoster: Int?
    private let topShade = CAGradientLayer(), bottomShade = CAGradientLayer()
    private let mark = StoryMarkView()
    private let name = UILabel()
    private let mute = UIButton(type: .system), more = MenuButton(type: .system), close = UIButton(type: .system)
    private let chip = UIControl(), sourceMark = StoryMarkView(), sourceName = UILabel()
    private let caption = UILabel()
    private let layerText = UITextView()
    private let replies = UILabel()
    private let reply = UITextField()
    private let replyMaterial = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private var loading: Task<Void, Never>?
    /// How long the shown picture has been on screen; nil until it is.
    private var elapsed: Double?
    private var clock: CADisplayLink?
    private var held = false
    private let press = UILongPressGestureRecognizer()
    private var pressing = false
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
        (name.font, caption.font, caption.numberOfLines, sourceName.font) = (.systemFont(ofSize: 15, weight: .semibold), .systemFont(ofSize: 16), 0, .systemFont(ofSize: 13, weight: .semibold))
        (chip.backgroundColor, chip.clipsToBounds, chip.layer.cornerRadius) = (UIColor.black.withAlphaComponent(0.45), true, 17)
        for label in [name, caption, sourceName] { label.textColor = .white }
        chip.addTarget(self, action: #selector(openChat), for: .touchUpInside); chip.accessibilityIdentifier = "storyAttribution"
        chip.isAccessibilityElement = true; chip.accessibilityTraits = .button
        for label in [name, caption] { (label.layer.shadowOpacity, label.layer.shadowRadius, label.layer.shadowOffset) = (0.5, 3, .zero) }
        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.accessibilityLabel = Strings.close
        more.setImage(UIImage(systemName: "ellipsis"), for: .normal)
        more.accessibilityLabel = Strings.more
        more.showsMenuAsPrimaryAction = true
        mute.addTarget(self, action: #selector(muteTapped), for: .touchUpInside)
        for button in [close, more, mute] { button.tintColor = .white; button.layer.shadowOpacity = 0.4; button.layer.shadowRadius = 3; button.layer.shadowOffset = CGSize(width: 0, height: 1) }
        for button in [close, more, mute] { button.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(pointSize: 24, weight: .light), forImageIn: .normal) }
        (replies.numberOfLines, replies.isUserInteractionEnabled, replies.accessibilityTraits) = (0, true, .button)
        replies.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openReplies)))
        reply.delegate = self
        (reply.returnKeyType, reply.textColor, reply.font) = (.send, .white, .systemFont(ofSize: 16))
        (replyMaterial.clipsToBounds, replyMaterial.layer.cornerRadius) = (true, StoryLayout.Metrics.bar / 2)
        reply.keyboardAppearance = .dark
        (reply.leftView, reply.leftViewMode) = (UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 1)), .always)
        (expanded.isEditable, expanded.isSelectable, expanded.backgroundColor, dim.backgroundColor) = (false, false, .clear, UIColor.black.withAlphaComponent(0.65))
        expanded.isOpaque = false; expanded.alwaysBounceVertical = true; expanded.textContainerInset = .zero; expanded.textContainer.lineFragmentPadding = 0
        expanded.topEdgeEffect.isHidden = true; expanded.bottomEdgeEffect.isHidden = true
        (layerText.isEditable, layerText.isSelectable, layerText.isScrollEnabled, layerText.isUserInteractionEnabled) = (false, false, false, false)
        (layerText.font, layerText.textColor, layerText.textAlignment, layerText.backgroundColor, layerText.layer.cornerRadius) = (.systemFont(ofSize: 24, weight: .semibold), .white, .center, UIColor.black.withAlphaComponent(0.35), 8)
        layerText.textContainerInset = UIEdgeInsets(top: 6, left: 10, bottom: 6, right: 10); layerText.textContainer.lineFragmentPadding = 0
        (roundVideo.isAccessibilityElement, roundVideo.accessibilityIdentifier, roundVideo.accessibilityLabel) = (true, "storyRoundLayer", "Round recording")
        (expanded.accessibilityIdentifier, dim.accessibilityIdentifier, replyMaterial.accessibilityIdentifier) = ("storyReplies", "storyRepliesDim", "storyReplyCapsule")
        dim.addTarget(self, action: #selector(closeReplies), for: .touchUpInside)
        repliesPan.addTarget(self, action: #selector(repliesDragged(_:))); repliesPan.delegate = self; expanded.addGestureRecognizer(repliesPan)
        for (gesture, action) in [(pinch, #selector(pinched(_:))), (mediaPan, #selector(mediaDragged(_:)))] { gesture.addTarget(self, action: action); gesture.delegate = self; media.addGestureRecognizer(gesture) }
        media.clipsToBounds = true; media.accessibilityIdentifier = "storyMediaStage"
        for item in [picture, video, layerText, roundVideo] { media.addSubview(item) }
        for item in [media, chip, sourceMark, sourceName, caption, replies, dim, expanded, mark, name, mute, more, replyMaterial, reply, close] { view.addSubview(item) }
        closeReplies()
        // The shades go over the media and under the words.
        for shade in [topShade, bottomShade] { media.layer.insertSublayer(shade, below: layerText.layer) }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        press.minimumPressDuration = 0.2; press.delegate = self; press.addTarget(self, action: #selector(pressed(_:)))
        view.addGestureRecognizer(press); tap.require(toFail: press)
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
            chipWidth: chip.isHidden ? 0 : sourceName.intrinsicContentSize.width + 48, round: story.round != nil, keyboard: keyboard
        )
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        (topShade.frame, bottomShade.frame) = (layout.topShade, layout.bottomShade)
        CATransaction.commit()
        (picture.frame, video.frame, mark.frame, name.frame) = (layout.media, layout.media, layout.mark, layout.name)
        (mute.frame, more.frame, close.frame, chip.frame, roundVideo.frame) = (layout.mute, layout.more, layout.close, layout.chip, layout.round)
        (caption.frame, replies.frame, reply.frame) = (layout.caption, layout.replies, layout.bar)
        replyMaterial.frame = layout.bar
        media.bounds = view.bounds; media.center = view.center
        dim.frame = view.bounds
        expanded.frame = StoryLayout.replies(bar: layout.bar, buttons: layout.close, measured: expanded.sizeThatFits(CGSize(width: layout.replies.width, height: .greatestFiniteMagnitude)).height)
        let attribution = StoryLayout.attribution(in: chip.frame)
        (sourceMark.frame, sourceName.frame, sourceMark.layer.cornerRadius) = (attribution.mark, attribution.name, 6)
        if let text = story.layers?.text {
            let width = StoryLayout.textWidth(in: view.bounds.size)
            let measured = layerText.attributedText.boundingRect(with: CGSize(width: width - 20, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, context: nil).size
            layerText.frame = StoryLayout.textFrame(size: view.bounds.size, center: CGPoint(x: text.x, y: text.y), measured: measured)
        }
        if let center = story.layers?.round { roundVideo.frame = StoryLayout.layer(size: view.bounds.size, center: CGPoint(x: center.x, y: center.y), measured: layout.round.size) }
        mark.layer.cornerRadius = posters[pages[index].poster].person ? layout.mark.width / 2 : StoryLayout.Metrics.markRadius
        for (segment, frame) in zip(segments, layout.segments) { segment.frame = frame }
    }

    // MARK: Showing

    private func show(_ next: Int) {
        closeReplies()
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
        (layerText.text, layerText.isHidden) = (story.layers?.text?.text, story.layers?.text == nil)
        let title = NSMutableAttributedString(string: poster.me ? Strings.Stories.you : poster.name)
        title.append(NSAttributedString(string: "  " + Strings.Stories.age(story.postedAt, now: Date()), attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.7), .font: UIFont.systemFont(ofSize: 14)]))
        name.attributedText = title
        caption.text = story.caption?.isEmpty == false ? story.caption : nil
        caption.isHidden = !expanded.isHidden || caption.text == nil
        let agent = agents.first { $0.agentId == story.agentId }
        sourceName.text = agent?.label ?? story.agentId.flatMap { names[$0] } ?? ""
        chip.accessibilityLabel = sourceName.text
        sourceMark.show(agent?.mark ?? .placeholder(seed: story.agentId ?? ""), images: images)
        for item in [chip, sourceMark, sourceName] { item.isHidden = !story.isRepost }
        reply.attributedPlaceholder = NSAttributedString(string: Strings.Stories.replyTo(story.agentId == nil ? (poster.me ? Strings.Stories.you : poster.name) : poster.me ? (story.agentId.flatMap { names[$0] } ?? "") : poster.name), attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.7)])
        let count = story.replyCount ?? 0, shown = transcript(story.replies ?? [], color: .white)
        shown.append(NSAttributedString(string: Strings.Stories.viewAll(count), attributes: [.font: UIFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: UIColor.white.withAlphaComponent(0.75)]))
        replies.attributedText = shown
        replies.isHidden = !expanded.isHidden || count == 0
        var actions: [UIAction] = []
        if !story.isPerson { actions.append(UIAction(title: Strings.Stories.repost, image: UIImage(systemName: "arrow.2.squarepath")) { [weak self] _ in self?.repost(story) }) }
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
        if !expanded.isHidden {
            let latest = pages[at].story.replies ?? []
            allReplies = (allReplies.filter { old in !latest.contains { $0.id == old.id } } + latest).sorted { $0.createdAt < $1.createdAt }
            expanded.attributedText = transcript(allReplies, color: .white)
        }
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

    private func updatePlayback() {
        let hold = pressing || !expanded.isHidden || presentedViewController != nil || reply.isFirstResponder || more.open
        if hold != held {
            held = hold
            for player in [player, roundPlayer] { hold ? player?.pause() : player?.play() }
        }
    }
    @objc func tick(_ link: CADisplayLink) {
        guard showing else { return }
        updatePlayback()
        if !held, elapsed != nil { elapsed! += link.duration }
        let current = progress
        let first = pages.firstIndex { $0.poster == pages[index].poster } ?? 0
        for (offset, segment) in segments.enumerated() {
            segment.progress = first + offset < index ? 1 : first + offset > index ? 0 : Float(min(current, 1))
        }
        if !held, player == nil, current >= 1 { step(1) }
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
        if gesture === repliesPan || gesture === pinch || gesture === mediaPan { return true }
        return zoom == 1 && [view, media, picture, video, roundVideo].contains { $0 === touch.view }
    }
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { gesture === pinch || other === pinch || gesture === repliesPan || other === repliesPan }
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool { gesture === press ? canHold && gesture.numberOfTouches == 1 : gesture !== repliesPan || expanded.contentOffset.y <= 0 && repliesPan.velocity(in: expanded).y > 0 }

    private var canHold: Bool { expanded.isHidden && presentedViewController == nil && !reply.isFirstResponder && !more.open && zoom == 1 && pinch.state != .began && pinch.state != .changed }
    @objc private func pressed(_ gesture: UILongPressGestureRecognizer) {
        hold(canHold && gesture.numberOfTouches == 1 && (gesture.state == .began || gesture.state == .changed))
    }
    private func hold(_ pause: Bool) {
        guard pressing != pause else { return }
        pressing = pause; updatePlayback()
        UIView.animate(withDuration: 0.15) { for item in [self.mark, self.name, self.mute, self.more, self.close, self.chip, self.sourceMark, self.sourceName, self.caption, self.replies, self.replyMaterial, self.reply] + self.segments { item.alpha = pause ? 0 : 1 } }
    }

    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
        hold(false)
        zoom = min(3, max(1, gesture.scale))
        media.transform = CGAffineTransform(translationX: zoomOffset.x, y: zoomOffset.y).scaledBy(x: zoom, y: zoom)
        if gesture.state == .ended || gesture.state == .cancelled { zoom = 1; zoomOffset = .zero; UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0) { self.media.transform = .identity } }
    }
    @objc private func mediaDragged(_ gesture: UIPanGestureRecognizer) {
        guard zoom > 1 else { return }
        let delta = gesture.translation(in: view); zoomOffset.x += delta.x; zoomOffset.y += delta.y
        media.transform = CGAffineTransform(translationX: zoomOffset.x, y: zoomOffset.y).scaledBy(x: zoom, y: zoom); gesture.setTranslation(.zero, in: view)
    }
    @objc private func repliesDragged(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .ended, expanded.contentOffset.y <= 0, gesture.translation(in: expanded).y > 40 { closeReplies() }
    }

    @objc private func closeTapped() { leave() }

    @objc private func muteTapped() { Self.muted.toggle(); applyMute() }

    private func applyMute() {
        player?.isMuted = Self.muted
        roundPlayer?.isMuted = Self.muted
        mute.setImage(UIImage(systemName: Self.muted ? "speaker.slash" : "speaker.wave.2"), for: .normal)
    }

    // MARK: Replies, reposts

    func textFieldShouldReturn(_ field: UITextField) -> Bool {
        let text = field.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard showing, !text.isEmpty else { return false }
        let id = pages[index].story.id
        held = true; player?.pause(); roundPlayer?.pause()
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

    /// Every reply, oldest first, over the paused story.
    @objc private func openReplies() {
        guard showing else { return }
        let id = pages[index].story.id
        allReplies = pages[index].story.replies ?? []
        (expanded.isHidden, dim.isHidden, expanded.contentOffset) = (false, false, .zero); updatePlayback()
        caption.isHidden = true; replies.isHidden = true
        expanded.attributedText = transcript(allReplies, color: .white)
        view.setNeedsLayout()
        Task { [weak self, client = engine.client] in
            guard let replies = try? await client.storyReplies(id), let self, showing, pages[index].story.id == id else { return }
            allReplies = replies
            expanded.attributedText = transcript(replies, color: .white)
            view.setNeedsLayout()
            await engine.lookUp(Set(replies.compactMap(\.userId)).subtracting(names.keys).subtracting([me ?? ""]))
        }
    }

    @objc private func closeReplies() {
        [dim, expanded].forEach { $0.isHidden = true }; updatePlayback()
        caption.isHidden = caption.text == nil
        replies.isHidden = !showing || (pages[index].story.replyCount ?? 0) == 0
        view.setNeedsLayout()
    }
    @objc private func openChat() {
        guard showing, let id = pages[index].story.agentId else { return }
        stop()
        let action = onChat
        dismiss(animated: true) { action?(id) }
    }

    private func repost(_ story: Story) {
        present(StoryRepostController(client: engine.client, source: .repost(story), library: library) { [weak self] ok in if !ok { self?.failed() } }, animated: true)
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
    /// An empty preview keeps UIKit from putting material behind the plain glyph.
    private func menuPreview() -> UITargetedPreview? {
        guard window != nil else { return nil }
        let parameters = UIPreviewParameters(); parameters.backgroundColor = .clear
        parameters.visiblePath = UIBezierPath(); parameters.shadowPath = UIBezierPath()
        return UITargetedPreview(view: UIView(), parameters: parameters, target: UIPreviewTarget(container: self, center: CGPoint(x: bounds.midX, y: bounds.midY)))
    }
    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? { menuPreview() }
    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration) -> UITargetedPreview? { menuPreview() }
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
