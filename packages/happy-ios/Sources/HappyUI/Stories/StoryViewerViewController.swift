#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// The full-screen story viewer, as Telegram's: one author at a time, one
/// progress segment per frame of their stories, a tap on the left third
/// back and elsewhere forward, a hold pausing it with the chrome hidden, a
/// sideways drag turning a cube to the next or previous author, and a drag
/// down closing it. Seeing a story's first frame marks it seen at once.
final class StoryViewerViewController: UIViewController, UIGestureRecognizerDelegate {
    /// The person asked for a story's conversation (their own).
    var onOpenConversation: ((StorySource) -> Void)?
    /// The viewer went away.
    var onClose: (() -> Void)?
    /// The viewer starts going away, back into what it opened from.
    var onClosing: (() -> Void)?
    /// The circle the viewer opened from.
    weak var origin: UIView?
    /// The circle of an author by key, in the row it opened from: it closes
    /// into the one of whoever it shows then, or falls away without one.
    var originFor: ((String) -> UIView?)?

    var closingOrigin: UIView? {
        guard let originFor else { return origin }
        return authors.indices.contains(authorIndex) ? originFor(authors[authorIndex].key) : nil
    }

    private let session: StoriesSession
    private var authors: [StoryFeedAuthor]
    private var stories: [String: Story]
    private(set) var authorIndex: Int
    private(set) var position = 0
    private var page = StoryViewerPageView()
    private var neighbor = StoryViewerPageView()
    private var watch: StemCellsWatch?
    private var link: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private var elapsedMs: Double = 0
    private var pauses: Set<Pause> = []
    private var pressStart: CFTimeInterval = 0
    private var pressMoved = false
    private var pressHolding = false
    private var holdTimer: Timer?
    private var drag: Drag = .none {
        didSet { if case .none = drag { applyPending() } }
    }
    /// A change that arrived mid-turn, shown once the cube settles.
    private var pendingSnapshot: StoriesSnapshot?
    private var cube: CubeAnimation?
    private let picker = StoryReactionPicker()
    private var observers: [NSObjectProtocol] = []
    private var held = false
    /// The story asked for, kept among its author's while the viewer is
    /// open: one opened from a conversation may be out of the feed.
    private let opened: String?

    private enum Pause: Hashable { case hold, drag, sheet, background, picker, appearing, caption, tooltip }
    /// A recording's sound, as Telegram's viewer keeps it while open: at
    /// first as the phone's ringer switch has it (and with other audio),
    /// then off or on, past the switch, by the sound button or a volume
    /// button.
    enum Audio { case ambient, off, on }
    private(set) var audio = Audio.ambient
    private var volume: NSKeyValueObservation?
    private var restoreCategory: AVAudioSession.Category?
    private weak var tooltip: StoriesTooltipView?
    private enum Drag { case none, sideways(next: Int), down }

    /// The turn between two authors, run a frame at a time.
    private struct CubeAnimation {
        var from: CGFloat
        var to: CGFloat
        var start: CFTimeInterval
        var duration: CFTimeInterval
        var target: Int
        var acted: Bool
    }

    /// Opens on `authorIndex`'s first unseen story, or on `storyId`.
    init(session: StoriesSession, feed: StoryFeed, authorIndex: Int, storyId: String? = nil) {
        opened = storyId
        self.session = session
        authors = feed.authors.filter { !$0.storyIds.isEmpty }
        stories = session.snapshot.stories.merging(feed.stories) { held, _ in held }
        let key = feed.authors.indices.contains(authorIndex) ? feed.authors[authorIndex].key : nil
        self.authorIndex = authors.firstIndex { $0.key == key } ?? 0
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
        if authors.indices.contains(self.authorIndex) {
            position = startPosition(authors[self.authorIndex])
            if let storyId, let index = frames(authors[self.authorIndex]).firstIndex(where: { $0.story.id == storyId }) { position = index }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { traitCollection.userInterfaceIdiom == .pad ? .all : .portrait }

    var currentPage: StoryViewerPageView { page }
    var isPaused: Bool { !pauses.isEmpty }
    /// How long frames show, times their own length (the harness slows them).
    static var showScale: Double = 1
    /// The last few things the viewer did, for the harness to report.
    private(set) var trail: [String] = []
    /// The reaction effect playing, over everything.
    private weak var burst: StoryReactionBurstView?

    private func note(_ step: String) {
        trail.append(step)
        if trail.count > 8 { trail.removeFirst() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.storiesViewerGround)
        view.accessibilityIdentifier = "story-viewer"
        for page in [neighbor, page] {
            view.addSubview(page)
            wire(page)
        }
        neighbor.isHidden = true
        picker.isHidden = true
        picker.onPick = { [weak self] emoji in self?.pickReaction(emoji) }
        view.addSubview(picker)

        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0
        press.delegate = self
        press.cancelsTouchesInView = false
        view.addGestureRecognizer(press)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)

        let store = session.store
        Task { await store.hold(true) }
        held = true
        watch = session.watch { [weak self] snapshot in self?.apply(snapshot) }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pause(.background, true) }
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.pause(.background, false) }
        })
        StoriesHaptics.prepare(.advance, .react)
        // Sized first, so the first frame is read at the size it is drawn.
        page.frame = view.bounds
        page.layoutIfNeeded()
        showCurrent()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startTicking()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        // However it goes, its sound stops as it starts to.
        page.canvas.pause()
        neighbor.canvas.pause()
        tooltip?.dismiss()
        onClosing?()
        onClosing = nil
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        finish()
        onClose?()
        onClose = nil
    }

    private func finish() {
        link?.invalidate(); link = nil
        volume?.invalidate(); volume = nil
        holdTimer?.invalidate(); holdTimer = nil
        page.canvas.stop()
        neighbor.canvas.stop()
        // The players gone, the session goes back to what it was and lets
        // other audio back; ambient for the default solo ambient, which
        // would stop other apps' audio again.
        if let restoreCategory {
            self.restoreCategory = nil
            let session = AVAudioSession.sharedInstance()
            if ![.playAndRecord, .record].contains(session.category) {
                try? session.setCategory(restoreCategory == .soloAmbient ? .ambient : restoreCategory)
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
        watch?.invalidate(); watch = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        if held {
            held = false
            let store = session.store
            Task { await store.hold(false) }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        for page in [page, neighbor] where page.transform == .identity && page.layer.transform.m34 == 0 {
            page.frame = view.bounds
        }
        if !picker.isHidden { placePicker() }
    }

    private func wire(_ page: StoryViewerPageView) {
        // The caption opened in full holds the story still, as Telegram's.
        page.canvas.onCaptionExpanded = { [weak self] open in self?.pause(.caption, open) }
        page.closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        page.moreButton.addTarget(self, action: #selector(moreTapped), for: .touchUpInside)
        page.viewsButton.addTarget(self, action: #selector(viewsTapped), for: .touchUpInside)
        page.heartButton.addTarget(self, action: #selector(heartTapped), for: .touchUpInside)
        page.soundButton.addTarget(self, action: #selector(soundTapped), for: .touchUpInside)
        page.canvas.onAudioKnown = { [weak self] _ in self?.updateSound() }
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(heartHeld(_:)))
        hold.minimumPressDuration = 0.35
        page.heartButton.addGestureRecognizer(hold)
        page.canvas.onReady = { [weak self, weak page] in
            guard let self, page === self.page else { return }
            lastTick = CACurrentMediaTime()
            if pauses.isEmpty { page?.canvas.play() }
        }
        page.canvas.onVideoEnd = { [weak self, weak page] in
            guard let self, page === self.page else { return }
            forward(acted: false)
        }
    }

    // MARK: What is shown

    private func frames(_ author: StoryFeedAuthor) -> [(story: Story, frame: StoryFrame)] {
        author.storyIds.compactMap { stories[$0] }.filter { $0.status == .posted }.flatMap { story in story.frames.map { (story, $0) } }
    }

    private func startPosition(_ author: StoryFeedAuthor) -> Int {
        let start = StoriesRow.start(author, stories: stories)
        let earlier = author.storyIds.prefix(start).compactMap { stories[$0] }.filter { $0.status == .posted }
        return earlier.reduce(0) { $0 + $1.frames.count }
    }

    private var currentFrames: [(story: Story, frame: StoryFrame)] {
        authors.indices.contains(authorIndex) ? frames(authors[authorIndex]) : []
    }

    var current: (story: Story, frame: StoryFrame)? {
        let frames = currentFrames
        return frames.indices.contains(position) ? frames[position] : nil
    }

    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private func showCurrent() {
        burst?.removeFromSuperview()
        tooltip?.dismiss()
        guard authors.indices.contains(authorIndex) else { return }
        let author = authors[authorIndex]
        let frames = frames(author)
        guard !frames.isEmpty else { return }
        position = min(max(0, position), frames.count - 1)
        page.show(author: author, frames: frames, position: position, media: session.media, images: session.images, now: now)
        began()
    }

    /// The page now shows `position`: its time starts, it is seen, and the
    /// next is read.
    private func began() {
        guard authors.indices.contains(authorIndex) else { return }
        let author = authors[authorIndex]
        let frames = frames(author)
        guard frames.indices.contains(position) else { return }
        elapsedMs = 0
        lastTick = CACurrentMediaTime()
        let story = frames[position].story
        let store = session.store
        if author.isSelf {
            // The view count moves without an event.
            if frames.firstIndex(where: { $0.story.id == story.id }) == position { Task { await store.refresh(story.id) } }
        } else {
            Task { await store.seen(story.id) }
        }
        if pauses.isEmpty { page.canvas.play() }
        preload(after: frames, position: position)
        updateSound()
    }

    // MARK: Sound

    /// The button and the players as the frame shown and `audio` have them.
    private func updateSound() {
        for page in [page, neighbor] {
            page.canvas.isMuted = audio == .off
            let video = page.canvas.shownFrame?.kind == .video
            page.setSound(!video ? .none : page.canvas.hasAudio == false ? .silent : audio == .off ? .off : .on)
        }
        guard current?.frame.kind == .video else { return }
        applyAudioSession()
        // A volume button press turns the sound on, as Telegram's does.
        if volume == nil {
            volume = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.volumeChanged() }
            }
        }
    }

    private func volumeChanged() {
        guard audio != .on, !pauses.contains(.background), !isBeingDismissed, presentingViewController != nil,
              current?.frame.kind == .video, page.canvas.hasAudio != false else { return }
        audio = .on
        note("sound:on")
        updateSound()
    }

    /// Ambient follows the ringer switch and plays alongside other audio;
    /// on plays past it. A call or a recording in progress is left alone.
    private func applyAudioSession() {
        let session = AVAudioSession.sharedInstance()
        guard ![.playAndRecord, .record].contains(session.category) else { return }
        let category: AVAudioSession.Category = audio == .on ? .playback : .ambient
        guard session.category != category else { return }
        if restoreCategory == nil { restoreCategory = session.category }
        try? session.setCategory(category)
        try? session.setActive(true)
    }

    @objc private func soundTapped() {
        guard tooltip == nil else { return }
        if page.canvas.hasAudio == false {
            showNoSound()
            return
        }
        audio = audio == .off ? .on : .off
        note("sound:\(audio == .on ? "on" : "off")")
        updateSound()
    }

    /// Telegram's "This video has no sound" under the button, holding the
    /// story until a touch, which it takes.
    private func showNoSound() {
        let button = page.soundButton
        let tooltip = StoriesTooltipView(text: Strings.Stories.videoHasNoSound, takesTouch: true)
        tooltip.overrideUserInterfaceStyle = .dark
        tooltip.frame = view.bounds
        tooltip.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tooltip.point(at: button.convert(CGPoint(x: button.bounds.midX + 1, y: button.bounds.maxY - 10), to: view))
        tooltip.onDismiss = { [weak self] in
            self?.tooltip = nil
            self?.pause(.tooltip, false)
        }
        view.addSubview(tooltip)
        tooltip.show()
        self.tooltip = tooltip
        pause(.tooltip, true)
        note("sound:silent")
    }

    /// The next frame's picture, read while this one shows.
    private func preload(after frames: [(story: Story, frame: StoryFrame)], position: Int) {
        let media = session.media
        let pixels = StoryCanvasView.pixels(page.canvas.bounds.size, scale: traitCollection.displayScale)
        var next: (Story, StoryFrame)?
        if frames.indices.contains(position + 1) { next = frames[position + 1] }
        else if authors.indices.contains(authorIndex + 1), let first = self.frames(authors[authorIndex + 1]).first { next = first }
        guard let (story, frame) = next, frame.kind == .image, frame.available else { return }
        Task { _ = await media.frame(story.id, frame, pixels: pixels) }
    }

    private func applyPending() {
        guard cube == nil, case .none = drag, let pending = pendingSnapshot else { return }
        pendingSnapshot = nil
        apply(pending)
    }

    private func apply(_ snapshot: StoriesSnapshot) {
        guard snapshot.isOn else { return dismissViewer() }
        // Authors don't change under a turning cube.
        if cube != nil || { if case .none = drag { return false } else { return true } }() {
            pendingSnapshot = snapshot
            return
        }
        let shown = current
        for (id, story) in snapshot.stories { stories[id] = story }
        // Authors keep their order while the viewer is open; their stories follow.
        if let feed = snapshot.feed {
            for (index, author) in authors.enumerated() {
                guard let fresh = feed.authors.first(where: { $0.key == author.key }) else { continue }
                var merged = fresh
                // The story opened stays, even one that left the feed.
                merged.storyIds = author.storyIds.filter { fresh.storyIds.contains($0) || $0 == opened } + fresh.storyIds.filter { !author.storyIds.contains($0) }
                authors[index] = merged
            }
        }
        for (index, author) in authors.enumerated() {
            authors[index].storyIds = author.storyIds.filter { stories[$0]?.status != .deleted && !snapshot.gone.contains($0) }
        }
        guard authors.indices.contains(authorIndex) else { return dismissViewer() }
        let frames = currentFrames
        if frames.isEmpty {
            // The author's last story went: on to the next, or close.
            authors.remove(at: authorIndex)
            guard authors.indices.contains(authorIndex) else { return dismissViewer() }
            position = startPosition(authors[authorIndex])
            return showCurrent()
        }
        if let shown, let index = frames.firstIndex(where: { $0.story.id == shown.story.id && $0.frame.id == shown.frame.id }) {
            let restart = index != position
            position = index
            let elapsed = elapsedMs
            page.show(author: authors[authorIndex], frames: frames, position: position, media: session.media, images: session.images, now: now)
            if !restart { elapsedMs = elapsed }
        } else {
            showCurrent()
        }
    }

    // MARK: Time

    private func startTicking() {
        guard link == nil else { return }
        let link = CADisplayLink(target: StoryViewerTicker(self), selector: #selector(StoryViewerTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        lastTick = CACurrentMediaTime()
    }

    fileprivate func tick(_ link: CADisplayLink) {
        let time = link.timestamp
        let dt = max(0, time - lastTick)
        lastTick = time
        if let cube { return stepCube(cube, at: time) }
        guard pauses.isEmpty, page.canvas.isReady, let (_, frame) = current else { return }
        let progress: Double
        if let video = page.canvas.videoProgress {
            progress = video
        } else {
            // A picture, or a recording that couldn't play: its own clock.
            elapsedMs += dt * 1000
            progress = elapsedMs / (Double(frame.showMs) * Self.showScale)
        }
        page.setProgress(progress, at: position)
        if progress >= 1 { forward(acted: false) }
    }

    private func pause(_ reason: Pause, _ on: Bool) {
        let was = pauses.isEmpty
        if on { pauses.insert(reason) } else { pauses.remove(reason) }
        if was, !pauses.isEmpty { page.canvas.pause() }
        if !was, pauses.isEmpty {
            lastTick = CACurrentMediaTime()
            page.canvas.play()
        }
    }

    // MARK: Moving

    private func forward(acted: Bool) {
        note(acted ? "forward" : "timeout")
        let count = currentFrames.count
        if position + 1 < count {
            position += 1
            if acted { StoriesHaptics.play(.advance) }
            showCurrent()
        } else if authorIndex + 1 < authors.count {
            turn(to: authorIndex + 1, acted: acted)
        } else {
            dismissViewer()
        }
    }

    private func back(acted: Bool) {
        note("back")
        if position > 0 {
            position -= 1
            if acted { StoriesHaptics.play(.advance) }
            showCurrent()
        } else if authorIndex > 0 {
            turn(to: authorIndex - 1, acted: acted)
        } else {
            // The first frame of all starts again.
            page.setProgress(0, at: position)
            elapsedMs = 0
            page.canvas.restart()
        }
    }

    /// Turns the cube to another author, from a tap or the end of a frame.
    private func turn(to index: Int, acted: Bool) {
        note("turn")
        burst?.removeFromSuperview()
        tooltip?.dismiss()
        page.canvas.setCaptionExpanded(false, animated: false)
        guard cube == nil, authors.indices.contains(index) else { return }
        prepareNeighbor(index)
        let direction: CGFloat = index > authorIndex ? -1 : 1
        cube = CubeAnimation(from: 0, to: direction, start: CACurrentMediaTime(), duration: 0.35, target: index, acted: acted)
        pause(.drag, true)
    }

    private func prepareNeighbor(_ index: Int) {
        let author = authors[index]
        neighbor.isHidden = false
        neighbor.frame = view.bounds
        neighbor.layoutIfNeeded()
        neighbor.show(author: author, frames: frames(author), position: startPosition(author), media: session.media, images: session.images, now: now)
        neighbor.canvas.pause()
        updateSound()
        drag = .sideways(next: index)
    }

    /// `offset` is how far the current author has turned, -1…1 (negative:
    /// towards the next).
    private func placeCube(_ offset: CGFloat, target: Int) {
        let width = view.bounds.width
        let side: CGFloat = target > authorIndex ? 1 : -1
        Self.cube(page, offset, width: width)
        Self.cube(neighbor, offset + side, width: width)
    }

    static func cube(_ view: UIView, _ s: CGFloat, width: CGFloat) {
        let s = max(-1, min(1, s))
        let edge = s <= 0 ? width / 2 : -width / 2
        var t = CATransform3DIdentity
        t.m34 = -1 / StoryCube.perspective
        t = CATransform3DTranslate(t, s * width + edge, 0, 0)
        t = CATransform3DRotate(t, StoryCube.angle(s), 0, 1, 0)
        t = CATransform3DTranslate(t, -edge, 0, 0)
        view.layer.transform = t
        (view as? StoryViewerPageView)?.shade.alpha = abs(s) * 0.5
    }

    private func stepCube(_ animation: CubeAnimation, at time: CFTimeInterval) {
        let t = min(1, (time - animation.start) / animation.duration)
        let eased = 1 - pow(1 - t, 3)
        let offset = animation.from + (animation.to - animation.from) * CGFloat(eased)
        placeCube(offset, target: animation.target)
        guard t >= 1 else { return }
        cube = nil
        if animation.to == 0 {
            settleCube(turned: false)
        } else {
            authorIndex = animation.target
            swap(&page, &neighbor)
            view.bringSubviewToFront(page)
            view.bringSubviewToFront(picker)
            // The page turned to already shows the author's first frame.
            position = startPosition(authors[authorIndex])
            settleCube(turned: true)
            if animation.acted { StoriesHaptics.play(.advance) }
            began()
        }
    }

    private func settleCube(turned: Bool) {
        for page in [page, neighbor] {
            page.layer.transform = CATransform3DIdentity
            page.shade.alpha = 0
            page.frame = view.bounds
        }
        neighbor.canvas.stop()
        neighbor.isHidden = true
        drag = .none
        pause(.drag, false)
    }

    // MARK: Gestures

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // A tooltip takes the touch that puts it away.
        if let tooltip, touch.view?.isDescendant(of: tooltip) == true { return false }
        if gestureRecognizer is UIPanGestureRecognizer, page.canvas.passesDrag(touch) {
            return cube == nil && presentedViewController == nil && !isBeingDismissed
        }
        var view = touch.view
        while let current = view, current !== self.view {
            if current is UIControl || current === picker { return false }
            view = current.superview
        }
        return cube == nil && presentedViewController == nil && !isBeingDismissed
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other.view === view
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: view)
        if abs(velocity.x) > abs(velocity.y) { return authors.count > 1 }
        // Down closes; up, on one's own story, shows who has seen it.
        return velocity.y > 0 || (authors.indices.contains(authorIndex) && authors[authorIndex].isSelf)
    }

    /// Down, up: a tap by thirds or on an overlay; held past a moment, a pause.
    @objc private func pressed(_ press: UILongPressGestureRecognizer) {
        switch press.state {
        case .began:
            if !picker.isHidden { hidePicker(); pressMoved = true; return }
            pressStart = CACurrentMediaTime()
            pressMoved = false
            pressHolding = false
            pause(.hold, true)
            holdTimer?.invalidate()
            holdTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, !self.pressMoved else { return }
                    self.pressHolding = true
                    self.page.chromeHidden = true
                }
            }
        case .changed:
            break
        case .ended:
            holdTimer?.invalidate()
            page.chromeHidden = false
            pause(.hold, false)
            guard !pressMoved, !pressHolding else { return }
            tap(at: press.location(in: page.canvas), in: press.location(in: view))
        default:
            holdTimer?.invalidate()
            page.chromeHidden = false
            pause(.hold, false)
        }
    }

    private func tap(at canvasPoint: CGPoint, in viewPoint: CGPoint) {
        if page.canvas.bounds.contains(canvasPoint), let overlay = page.canvas.tappable(at: canvasPoint) {
            switch overlay {
            case .link(let id, let url, _, _, _, _): return openLink(url, from: page.canvas.overlayView(id))
            case .reaction(let id, let emoji, _, _, _):
                guard authors.indices.contains(authorIndex), !authors[authorIndex].isSelf else { break }
                return react(emoji, from: page.canvas.overlayView(id))
            default: break
            }
        }
        switch page.layout.tap(at: viewPoint.x) {
        case .back: back(acted: true)
        case .forward: forward(acted: true)
        }
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: view)
        let velocity = pan.velocity(in: view)
        switch pan.state {
        case .began:
            pressMoved = true
            holdTimer?.invalidate()
            page.chromeHidden = false
            pause(.drag, true)
            // Any drag folds the caption, so no fold is left holding the
            // next author still.
            page.canvas.setCaptionExpanded(false)
            if abs(velocity.x) > abs(velocity.y) {
                drag = .sideways(next: -1)
            } else {
                drag = .down
                // Only the canvas shrinks away; the page's own black goes
                // with the ground behind it.
                page.backgroundColor = .clear
            }
        case .changed:
            switch drag {
            case .down:
                // With the finger, shrinking towards 0.6 by a screen, as
                // Telegram's: let go, it closes from here into its circle.
                let state = StoryViewerDrag.state(translation: translation.y, height: view.bounds.height)
                page.transform = CGAffineTransform(translationX: 0, y: state.offset).scaledBy(x: state.scale, y: state.scale)
                view.backgroundColor = UIColor(Palette.storiesViewerGround).withAlphaComponent(state.groundAlpha)
            case .sideways(let next):
                let offset = translation.x / max(1, view.bounds.width)
                let wanted = offset < 0 ? authorIndex + 1 : authorIndex - 1
                guard authors.indices.contains(wanted) else {
                    // Turned back past the start towards nothing: the
                    // neighbor goes, and the page gives a little.
                    if authors.indices.contains(next) {
                        neighbor.isHidden = true
                        neighbor.layer.transform = CATransform3DIdentity
                        neighbor.canvas.stop()
                        drag = .sideways(next: wanted)
                    }
                    Self.cube(page, offset * 0.15, width: view.bounds.width)
                    return
                }
                if next != wanted { prepareNeighbor(wanted) }
                placeCube(offset, target: wanted)
            case .none:
                break
            }
        case .ended, .cancelled, .failed:
            switch drag {
            case .down:
                let own = authors.indices.contains(authorIndex) && authors[authorIndex].isSelf
                let release = pan.state == .ended ? StoryViewerDrag.release(translation: translation.y, velocity: velocity.y, canShowViewers: own) : .stay
                if release == .close {
                    note("drag-close")
                    dismissViewer()
                } else if page.transform == .identity {
                    // Up only: nothing moved, nothing to spring back.
                    page.backgroundColor = UIColor(Palette.storiesViewerGround)
                    view.backgroundColor = UIColor(Palette.storiesViewerGround)
                    drag = .none
                    pause(.drag, false)
                    if release == .viewers { viewsTapped() }
                } else {
                    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
                        self.page.transform = .identity
                        self.view.backgroundColor = UIColor(Palette.storiesViewerGround)
                    } completion: { _ in
                        self.page.backgroundColor = UIColor(Palette.storiesViewerGround)
                        self.drag = .none
                        self.pause(.drag, false)
                    }
                    if release == .viewers { viewsTapped() }
                }
            case .sideways(let next):
                let width = max(1, view.bounds.width)
                let offset = max(-1, min(1, translation.x / width))
                guard authors.indices.contains(next) else {
                    UIView.animate(withDuration: 0.25) { self.page.layer.transform = CATransform3DIdentity; self.page.shade.alpha = 0 }
                    drag = .none
                    pause(.drag, false)
                    return
                }
                let goes = pan.state == .ended && (abs(offset) > 0.3 || abs(velocity.x) > 600) && (offset < 0) == (next > authorIndex)
                let to: CGFloat = goes ? (next > authorIndex ? -1 : 1) : 0
                cube = CubeAnimation(from: offset, to: to, start: CACurrentMediaTime(), duration: 0.3 * Double(max(0.3, abs(to - offset))), target: next, acted: true)
            case .none:
                pause(.drag, false)
            }
        default:
            break
        }
    }

    // MARK: Acts

    @objc private func closeTapped() { dismissViewer() }

    func dismissViewer() {
        guard presentingViewController != nil, !isBeingDismissed else { return }
        link?.invalidate(); link = nil
        burst?.removeFromSuperview()
        tooltip?.dismiss()
        page.canvas.pause()
        // From whatever it presents too: a sheet up mustn't keep it here.
        presentingViewController?.dismiss(animated: true)
    }

    /// Reacts with `emoji`, or takes it back when it's the reaction already.
    /// Reacting throws the emoji out around `source` (the bubble tapped, or
    /// the heart), as Telegram's reaction effect does.
    private func react(_ emoji: String, from source: UIView? = nil) {
        note("react")
        guard let (story, _) = current else { return }
        let next = story.myReaction == emoji ? nil : emoji
        page.setHeart(next)
        StoriesHaptics.play(.react)
        if let next, let reaction = page.canvas.overlayViewMatching(emoji: next) { Self.bounce(reaction) }
        Self.bounce(page.heartButton)
        burst?.removeFromSuperview()
        // On the page, so it goes with it as it turns, shrinks or closes.
        if let next, !isBeingDismissed {
            let around = source ?? page.heartButton
            let shown = StoryReactionBurstView(emoji: next, burst: StoryReactionBurst(target: around.convert(around.bounds, to: page)))
            page.addSubview(shown)
            shown.play()
            burst = shown
            note("burst")
        }
        let store = session.store
        Task { await store.react(story.id, emoji: next) }
    }

    static func bounce(_ view: UIView) {
        let base = view.transform
        UIView.animate(withDuration: 0.12, animations: { view.transform = base.scaledBy(x: 1.25, y: 1.25) }) { _ in
            UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 0) { view.transform = base }
        }
    }

    @objc private func heartTapped() {
        guard picker.isHidden else { return hidePicker() }
        guard let (story, _) = current else { return }
        react(story.myReaction ?? Strings.Stories.heart)
    }

    @objc private func heartHeld(_ hold: UILongPressGestureRecognizer) {
        guard hold.state == .began else { return }
        StoriesHaptics.play(.react)
        showPicker()
    }

    private func showPicker() {
        picker.chosen = current?.story.myReaction
        picker.isHidden = false
        placePicker()
        picker.alpha = 0
        picker.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
        pause(.picker, true)
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0) {
            self.picker.alpha = 1
            self.picker.transform = .identity
        }
    }

    private func placePicker() {
        let heart = page.heartButton.convert(page.heartButton.bounds, to: view)
        let size = picker.sizeThatFits(view.bounds.size)
        let x = min(view.bounds.width - size.width - 8, max(8, heart.maxX - size.width))
        picker.transform = .identity
        picker.frame = CGRect(x: x, y: heart.minY - size.height - 8, width: size.width, height: size.height)
    }

    private func hidePicker() {
        pause(.picker, false)
        UIView.animate(withDuration: 0.15, animations: { self.picker.alpha = 0 }) { _ in self.picker.isHidden = true }
    }

    private func pickReaction(_ emoji: String) {
        hidePicker()
        guard let (story, _) = current else { return }
        if story.myReaction == emoji { return react(emoji) }
        react(emoji)
    }

    private func openLink(_ url: String, from pill: UIView?) {
        note("link")
        guard let target = URL(string: url) else { return }
        pause(.sheet, true)
        let sheet = UIAlertController(title: url, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: Strings.Stories.open, style: .default) { [weak self] _ in
            self?.pause(.sheet, false)
            UIApplication.shared.open(target)
        })
        sheet.addAction(UIAlertAction(title: Strings.Stories.copyLink, style: .default) { [weak self] _ in
            UIPasteboard.general.url = target
            self?.pause(.sheet, false)
        })
        sheet.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel) { [weak self] _ in self?.pause(.sheet, false) })
        sheet.view.accessibilityIdentifier = "story-link-sheet"
        let anchor = pill ?? page.canvas
        sheet.popoverPresentationController?.sourceView = anchor
        sheet.popoverPresentationController?.sourceRect = anchor.bounds
        present(sheet, animated: true)
    }

    @objc private func moreTapped() {
        guard let (story, _) = current else { return }
        pause(.sheet, true)
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        if let source = story.source, onOpenConversation != nil {
            sheet.addAction(UIAlertAction(title: Strings.Stories.openConversation, style: .default) { [weak self] _ in
                guard let self else { return }
                let open = onOpenConversation
                pause(.sheet, false)
                dismiss(animated: true) { open?(source) }
            })
        }
        if authors.indices.contains(authorIndex), authors[authorIndex].isSelf {
            sheet.addAction(UIAlertAction(title: Strings.Stories.delete, style: .destructive) { [weak self] _ in self?.confirmDelete(story) })
        }
        sheet.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel) { [weak self] _ in self?.pause(.sheet, false) })
        sheet.popoverPresentationController?.sourceView = page.moreButton
        sheet.popoverPresentationController?.sourceRect = page.moreButton.bounds
        present(sheet, animated: true)
    }

    private func confirmDelete(_ story: Story) {
        let alert = UIAlertController(title: Strings.Stories.deleteStory, message: Strings.Stories.deleteDetail, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel) { [weak self] _ in self?.pause(.sheet, false) })
        alert.addAction(UIAlertAction(title: Strings.Stories.delete, style: .destructive) { [weak self] _ in
            guard let self else { return }
            // Still while the deletion is under way; the viewer then moves on.
            let store = session.store
            Task { [weak self] in
                do {
                    try await store.delete(story.id)
                    StoriesHaptics.play(.delete)
                    self?.pause(.sheet, false)
                } catch {
                    StoriesHaptics.play(.refused)
                    self?.showRefusal()
                }
            }
        })
        present(alert, animated: true)
    }

    private func showRefusal() {
        let alert = UIAlertController(title: Strings.Stories.deleteFailed, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default) { [weak self] _ in self?.pause(.sheet, false) })
        present(alert, animated: true)
    }

    @objc private func viewsTapped() {
        guard presentedViewController == nil, let (story, _) = current else { return }
        note("viewers")
        pause(.sheet, true)
        let list = StoriesViewersViewController(session: session, story: story)
        list.onClose = { [weak self] in self?.pause(.sheet, false) }
        // It presents itself as Telegram's sheet.
        present(list, animated: true)
    }
}

/// Holds the viewer weakly for its display link, which holds its target.
@MainActor
private final class StoryViewerTicker: NSObject {
    weak var viewer: StoryViewerViewController?
    init(_ viewer: StoryViewerViewController) { self.viewer = viewer }
    @objc func tick(_ link: CADisplayLink) {
        guard let viewer else { return link.invalidate() }
        viewer.tick(link)
    }
}

/// Telegram's reaction effect drawn from `StoryReactionBurst`: copies of
/// the emoji thrown out from what was tapped, rising and fading, once.
/// Touches go through it.
final class StoryReactionBurstView: UIView {
    private let emoji: String
    private let burst: StoryReactionBurst

    init(emoji: String, burst: StoryReactionBurst) {
        self.emoji = emoji
        self.burst = burst
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        accessibilityIdentifier = "story-reaction-burst"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        frame = superview?.bounds ?? .zero
    }

    func play() {
        let side = StoryReactionBurst.Metrics.particle
        let now = layer.convertTime(CACurrentMediaTime(), from: nil)
        // Drawn once, shared by every copy.
        let picture = StoryViewerPageView.emojiImage(emoji, size: side).cgImage
        var longest = 0.0
        for particle in burst.particles {
            let copy = CALayer()
            copy.contents = picture
            copy.contentsGravity = .resizeAspect
            copy.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            copy.position = particle.end
            copy.opacity = 0
            layer.addSublayer(copy)

            let move = CABasicAnimation(keyPath: "position")
            move.fromValue = particle.start
            move.toValue = particle.end
            move.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
            let grow = CAKeyframeAnimation(keyPath: "transform")
            grow.values = [0.2, particle.peakScale, particle.peakScale * 0.55].enumerated().map { index, scale in
                CATransform3DRotate(CATransform3DMakeScale(scale, scale, 1), particle.rotation * CGFloat(index), 0, 0, 1)
            }
            grow.keyTimes = [0, 0.3, 1]
            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [0, 1, 1, 0]
            fade.keyTimes = [0, 0.12, 0.6, 1]
            let group = CAAnimationGroup()
            group.animations = [move, grow, fade]
            group.duration = particle.duration
            group.beginTime = now + particle.delay
            group.fillMode = .backwards
            copy.add(group, forKey: "burst")
            longest = max(longest, particle.delay + particle.duration)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + longest) { [weak self] in self?.removeFromSuperview() }
    }
}

/// The heart's other emoji, in a capsule over the bar.
final class StoryReactionPicker: UIView {
    var onPick: ((String) -> Void)?
    var chosen: String? { didSet { for (button, emoji) in zip(buttons, Strings.Stories.reactions) { button.backgroundColor = emoji == chosen ? UIColor(white: 1, alpha: 0.2) : .clear } } }
    private var buttons: [UIButton] = []
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
    static let item: CGFloat = 44
    static let inset: CGFloat = 6

    override init(frame: CGRect) {
        super.init(frame: frame)
        blur.clipsToBounds = true
        addSubview(blur)
        for emoji in Strings.Stories.reactions {
            let button = UIButton(type: .custom)
            button.setImage(StoryViewerPageView.emojiImage(emoji, size: 30), for: .normal)
            button.accessibilityIdentifier = "story-reaction:\(emoji)"
            button.accessibilityLabel = emoji
            button.layer.cornerRadius = Self.item / 2
            button.addAction(UIAction { [weak self] _ in self?.onPick?(emoji) }, for: .touchUpInside)
            buttons.append(button)
            addSubview(button)
        }
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.3
        layer.shadowRadius = 12
        accessibilityIdentifier = "story-reaction-picker"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let count = CGFloat(buttons.count)
        return CGSize(width: min(size.width - 16, count * Self.item + 2 * Self.inset), height: Self.item + 2 * Self.inset)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        blur.frame = bounds
        blur.layer.cornerRadius = bounds.height / 2
        let item = min(Self.item, (bounds.width - 2 * Self.inset) / CGFloat(max(1, buttons.count)))
        for (index, button) in buttons.enumerated() {
            button.frame = CGRect(x: Self.inset + CGFloat(index) * item, y: Self.inset, width: item, height: Self.item)
        }
    }
}

extension StoryCanvasView {
    /// The reaction bubble showing `emoji`, to bounce as it's chosen.
    func overlayViewMatching(emoji: String) -> UIView? {
        guard let id = shownFrame?.overlays.first(where: { if case .reaction(_, let e, _, _, _) = $0 { e == emoji } else { false } })?.id else { return nil }
        return overlayView(id)
    }
}
#endif
