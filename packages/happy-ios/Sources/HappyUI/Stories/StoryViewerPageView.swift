#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// One author in the viewer, as Telegram's story item set lays it out: the
/// canvas with its corners rounded, the progress strip and the author over
/// its top, close and more beside them, and the bar under it with the heart,
/// or on one's own story how many have seen it. On an agent's story the bar
/// is the design's: a field to tell the agent what to change, the heart,
/// and repost at the far right.
final class StoryViewerPageView: UIView {
    let canvas = StoryCanvasView()
    let closeButton = UIButton(type: .system)
    let moreButton = UIButton(type: .system)
    let heartButton = UIButton(type: .custom)
    let viewsButton = UIButton(type: .system)
    /// A recording's sound, on or off, at the top beside the more button.
    let soundButton = UIButton(type: .custom)
    /// An agent's story: what to tell the agent, and making it one's own.
    let feedbackField = UITextField()
    let repostButton = UIButton(type: .system)
    /// How far a keyboard lifts the agent's bar.
    var keyboardLift: CGFloat = 0 { didSet { if keyboardLift != oldValue { setNeedsLayout() } } }
    /// An agent's row icon, drawn as its avatar.
    var authorImage: UIImage?
    private let topFade = CAGradientLayer()
    private let strip = UIView()
    private var segments: [StoryProgressSegment] = []
    private let avatar = UIImageView()
    private let initials = UILabel()
    private let nameLabel = UILabel()
    private let timeLabel = UILabel()
    /// Shades the side of the cube turned away.
    let shade = UIView()
    private var chrome: [UIView] { [strip, avatar, nameLabel, timeLabel, closeButton, moreButton, soundButton, heartButton, viewsButton, feedbackField, repostButton] }
    /// The story shown is an agent's.
    private(set) var isAgents = false

    private(set) var author: StoryFeedAuthor?
    private var photoKey: String?
    private var loading: Task<Void, Never>?
    var layout = StoryViewerLayout(size: .zero, safeArea: LayoutInsets())

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.storiesViewerGround)
        canvas.layer.cornerRadius = StoryViewerLayout.Metrics.cornerRadius
        canvas.layer.cornerCurve = .continuous
        addSubview(canvas)
        topFade.colors = [UIColor(white: 0, alpha: 0.4).cgColor, UIColor(white: 0, alpha: 0).cgColor]
        canvas.layer.addSublayer(topFade)
        strip.isUserInteractionEnabled = false
        addSubview(strip)
        avatar.clipsToBounds = true
        avatar.contentMode = .scaleAspectFill
        avatar.backgroundColor = UIColor(Palette.storiesAvatarFill)
        avatar.layer.cornerRadius = StoryViewerLayout.Metrics.avatar / 2
        initials.font = .systemFont(ofSize: 13, weight: .semibold)
        initials.textColor = UIColor(Palette.storiesAvatarText)
        initials.textAlignment = .center
        avatar.addSubview(initials)
        addSubview(avatar)
        nameLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        nameLabel.textColor = UIColor(Palette.storiesViewerText)
        timeLabel.font = .systemFont(ofSize: 13)
        timeLabel.textColor = UIColor(Palette.storiesViewerText).withAlphaComponent(0.7)
        for label in [nameLabel, timeLabel] {
            label.layer.shadowColor = UIColor.black.cgColor
            label.layer.shadowOpacity = 0.25
            label.layer.shadowRadius = 2
            label.layer.shadowOffset = .zero
            addSubview(label)
        }
        closeButton.setImage(UIImage.icon(.ionicons("close"), size: 26).withRenderingMode(.alwaysTemplate), for: .normal)
        closeButton.accessibilityLabel = Strings.Stories.close
        closeButton.accessibilityIdentifier = "story-close"
        moreButton.setImage(UIImage.icon(.materialIcons("more-horiz"), size: 26).withRenderingMode(.alwaysTemplate), for: .normal)
        moreButton.accessibilityIdentifier = "story-more"
        for button in [closeButton, moreButton, viewsButton] {
            button.tintColor = .white
            addSubview(button)
        }
        soundButton.accessibilityIdentifier = "story-sound"
        soundButton.adjustsImageWhenHighlighted = false
        soundButton.isHidden = true
        addSubview(soundButton)
        heartButton.accessibilityIdentifier = "story-heart"
        heartButton.accessibilityLabel = Strings.Stories.react
        addSubview(heartButton)
        viewsButton.contentHorizontalAlignment = .leading
        viewsButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        viewsButton.setImage(UIImage.icon(.ionicons("eye-outline"), size: 20).withRenderingMode(.alwaysTemplate), for: .normal)
        viewsButton.configuration = nil
        viewsButton.imageEdgeInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 6)
        viewsButton.titleEdgeInsets = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: 0)
        viewsButton.accessibilityIdentifier = "story-views"
        feedbackField.attributedPlaceholder = NSAttributedString(string: Strings.Stories.feedbackPlaceholder, attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.7)])
        feedbackField.textColor = .white
        feedbackField.tintColor = .white
        feedbackField.font = .systemFont(ofSize: 15)
        feedbackField.keyboardAppearance = .dark
        feedbackField.returnKeyType = .send
        feedbackField.enablesReturnKeyAutomatically = true
        feedbackField.layer.borderColor = UIColor(white: 1, alpha: 0.3).cgColor
        feedbackField.layer.borderWidth = 1
        feedbackField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        feedbackField.leftViewMode = .always
        feedbackField.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
        feedbackField.rightViewMode = .always
        feedbackField.accessibilityIdentifier = "story-feedback"
        feedbackField.isHidden = true
        addSubview(feedbackField)
        repostButton.setImage(UIImage.icon(.ionicons("repeat"), size: 24).withRenderingMode(.alwaysTemplate), for: .normal)
        repostButton.tintColor = .white
        repostButton.accessibilityLabel = Strings.Stories.repost
        repostButton.accessibilityIdentifier = "story-repost"
        repostButton.isHidden = true
        addSubview(repostButton)
        shade.backgroundColor = .black
        shade.alpha = 0
        shade.isUserInteractionEnabled = false
        addSubview(shade)
        accessibilityIdentifier = "story-viewer-page"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit { loading?.cancel() }

    // MARK: Showing

    /// Draws `author` at frame `position` of `frames` (their stories' frames in order).
    func show(author: StoryFeedAuthor, frames: [(story: Story, frame: StoryFrame)], position: Int, media: StoriesMedia?, images: Images?, now: Int64) {
        let changedAuthor = self.author?.key != author.key
        self.author = author
        nameLabel.text = author.isSelf ? Strings.Stories.myStory : author.name
        initials.text = StoriesRow.initials(author.name)
        loadPhoto(author, images: images)
        if segments.count != frames.count || changedAuthor {
            segments.forEach { $0.removeFromSuperview() }
            segments = frames.indices.map { index in
                let segment = StoryProgressSegment()
                segment.accessibilityIdentifier = "story-segment:\(index)"
                strip.addSubview(segment)
                return segment
            }
        }
        for (index, segment) in segments.enumerated() { segment.progress = index < position ? 1 : 0 }
        guard frames.indices.contains(position) else { return }
        let (story, frame) = frames[position]
        canvas.show(story, frame: frame, media: media)
        timeLabel.text = story.postedAt.map { Strings.Stories.ago(now - $0) }
        isAgents = story.isAgents
        heartButton.isHidden = author.isSelf
        viewsButton.isHidden = !author.isSelf
        feedbackField.isHidden = !isAgents
        repostButton.isHidden = !isAgents
        // Others' stories offer only their conversation, when there is one.
        moreButton.isHidden = !author.isSelf && story.source == nil
        setHeart(story.myReaction)
        let views = story.viewCount ?? 0
        viewsButton.setTitle(views == 0 ? Strings.Stories.noViewers : Strings.Stories.views(views), for: .normal)
        accessibilityValue = "\(story.id)#\(position)"
        setNeedsLayout()
    }

    /// The current segment's fill, 0…1.
    func setProgress(_ progress: Double, at position: Int) {
        guard segments.indices.contains(position) else { return }
        segments[position].progress = CGFloat(progress)
    }

    /// What the sound button shows: nothing on a picture; on a recording
    /// its sound on or off, or, with no sound at all, off and dimmed.
    enum Sound: Equatable { case none, on, off, silent }

    func setSound(_ sound: Sound) {
        let hidden = sound == .none
        if soundButton.isHidden != hidden {
            soundButton.isHidden = hidden
            setNeedsLayout()
        }
        soundButton.setImage(StoryEditorIcons.sound(on: sound == .on).withRenderingMode(.alwaysTemplate), for: .normal)
        // Telegram's dims a recording without sound to half.
        soundButton.tintColor = UIColor(white: 1, alpha: sound == .silent ? 0.5 : 1)
        soundButton.accessibilityLabel = sound == .on ? Strings.Stories.mute : Strings.Stories.unmute
        soundButton.accessibilityValue = switch sound {
        case .none: nil
        case .on: "on"
        case .off: "off"
        case .silent: "silent"
        }
    }

    func setHeart(_ reaction: String?) {
        let image: UIImage
        if let reaction, reaction != Strings.Stories.heart {
            image = Self.emojiImage(reaction, size: 28)
        } else {
            image = UIImage.icon(.ionicons(reaction == nil ? "heart-outline" : "heart"), size: 28).withRenderingMode(.alwaysTemplate)
        }
        heartButton.setImage(image, for: .normal)
        heartButton.tintColor = reaction == nil ? .white : UIColor(red: 1, green: 0.23, blue: 0.33, alpha: 1)
        heartButton.accessibilityValue = reaction
    }

    static func emojiImage(_ emoji: String, size: CGFloat) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
            StoryEmojiOverlayView.drawEmoji(emoji, in: CGRect(x: 0, y: 0, width: size, height: size))
        }
    }

    /// Holding the frame hides everything over it but the frame.
    var chromeHidden = false {
        didSet {
            guard chromeHidden != oldValue else { return }
            canvas.chromeHidden = chromeHidden
            UIView.animate(withDuration: 0.2) { for view in self.chrome { view.alpha = self.chromeHidden ? 0 : 1 } }
            topFade.opacity = chromeHidden ? 0 : 1
        }
    }

    private func loadPhoto(_ author: StoryFeedAuthor, images: Images?) {
        if author.ringAgentId != nil, let authorImage {
            // An agent wears its row's icon.
            photoKey = nil
            loading?.cancel()
            avatar.image = authorImage
            avatar.contentMode = .scaleAspectFit
            initials.isHidden = true
            return
        }
        avatar.contentMode = .scaleAspectFill
        let key = images == nil ? nil : author.photo.map { "\($0)#\(author.thumbhash ?? "")" }
        guard key != photoKey else { return }
        photoKey = key
        loading?.cancel()
        avatar.image = nil
        initials.isHidden = false
        guard let path = author.photo, let images else { return }
        let pixels = Int(StoryViewerLayout.Metrics.avatar * 3)
        if let cached = images.cachedPicture(path, thumbhash: author.thumbhash, pixels: pixels) {
            avatar.image = cached
            initials.isHidden = true
            return
        }
        loading = Task { [weak self] in
            let image = await images.picture(path, thumbhash: author.thumbhash, pixels: pixels)
            guard let self, !Task.isCancelled, photoKey == key, let image else { return }
            avatar.image = image
            initials.isHidden = true
        }
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        let safe = safeAreaInsets
        layout = StoryViewerLayout(size: bounds.size, safeArea: LayoutInsets(top: safe.top, left: 0, bottom: safe.bottom, right: 0))
        // Placed by bounds and centre: opening and closing move them by
        // their transforms.
        place(canvas, layout.canvas)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        topFade.frame = CGRect(x: 0, y: 0, width: layout.canvas.width, height: 96)
        CATransaction.commit()
        strip.frame = bounds
        for (segment, frame) in zip(segments, StoryViewerLayout.segments(segments.count, in: layout.strip)) { segment.frame = frame }
        place(avatar, layout.avatar)
        initials.frame = avatar.bounds
        let lineHeight: CGFloat = 17
        // Without a more button the sound button takes its place.
        let titleWidth = layout.titleWidth(withSound: !soundButton.isHidden && !moreButton.isHidden)
        nameLabel.frame = CGRect(x: layout.titleOrigin.x, y: layout.titleOrigin.y, width: titleWidth, height: lineHeight)
        timeLabel.frame = CGRect(x: layout.titleOrigin.x, y: layout.titleOrigin.y + lineHeight, width: titleWidth, height: lineHeight)
        closeButton.frame = layout.close
        moreButton.frame = layout.more
        soundButton.frame = moreButton.isHidden ? layout.more : layout.sound
        if isAgents {
            let bar = AgentStoryLayout.bar(canvas: layout.canvas, bar: layout.bar, barHeight: StoryViewerLayout.Metrics.bar, lift: keyboardLift)
            place(heartButton, bar.heart)
            place(repostButton, bar.repost)
            place(feedbackField, bar.field)
            feedbackField.layer.cornerRadius = bar.field.height / 2
        } else {
            place(heartButton, layout.heart)
        }
        place(viewsButton, layout.views)
        shade.frame = bounds
        if let openingMask {
            openingMask.frame = bounds
            openingBar.frame = CGRect(x: 0, y: layout.canvas.maxY, width: bounds.width, height: max(0, bounds.height - layout.canvas.maxY))
        }
    }

    private func place(_ view: UIView, _ frame: CGRect) {
        view.bounds = CGRect(origin: view.bounds.origin, size: frame.size)
        view.center = CGPoint(x: frame.midX, y: frame.midY)
    }

    // MARK: Opening and closing

    private var openingMask: UIView?
    private let openingWindow = UIView()
    private let openingBar = UIView()

    /// From here until `endOpening`, the story shows only through a window
    /// (and the bar under it), as it opens out of what was tapped or
    /// closes back into it (`StoryOpeningLayout`).
    func beginOpening() {
        guard openingMask == nil else { return }
        let mask = UIView(frame: bounds)
        for view in [openingWindow, openingBar] {
            view.backgroundColor = .black
            mask.addSubview(view)
        }
        openingWindow.layer.cornerCurve = .continuous
        openingWindow.frame = layout.canvas
        openingWindow.layer.cornerRadius = StoryViewerLayout.Metrics.cornerRadius
        openingBar.frame = CGRect(x: 0, y: layout.canvas.maxY, width: bounds.width, height: max(0, bounds.height - layout.canvas.maxY))
        openingMask = mask
        self.mask = mask
    }

    func endOpening() {
        mask = nil
        openingMask = nil
        canvas.transform = .identity
        avatar.transform = .identity
    }

    /// The window, the story in it and the author's avatar: on the source
    /// (`atSource`) or in their places.
    func placeOpening(_ opening: StoryOpeningLayout, atSource: Bool) {
        openingWindow.frame = atSource ? opening.window : layout.canvas
        openingWindow.layer.cornerRadius = atSource ? opening.windowRadius : StoryViewerLayout.Metrics.cornerRadius
        canvas.transform = atSource ? opening.canvas.transform : .identity
        if let placement = opening.avatar { avatar.transform = atSource ? placement.transform : .identity }
    }

    /// The controls over the story, and the shade behind them, shown or
    /// not; the author's avatar too when it doesn't fly to the source.
    /// Called inside an animation block; the shade animates itself.
    func showOpeningControls(_ shown: Bool, opening: StoryOpeningLayout, duration: Double) {
        var views = [strip, closeButton, moreButton, soundButton, nameLabel, timeLabel]
        if opening.avatar == nil { views.append(avatar) }
        for view in views { view.alpha = shown ? 1 : 0 }
        let from = topFade.presentation()?.opacity ?? topFade.opacity
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        topFade.opacity = shown ? 1 : 0
        CATransaction.commit()
        guard duration > 0 else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = from
        fade.toValue = topFade.opacity
        fade.duration = duration
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        topFade.add(fade, forKey: "opening")
    }

    /// The bar under the story: in its place, or dropped below the screen.
    func placeOpeningBar(_ opening: StoryOpeningLayout, risen: Bool) {
        for view in [heartButton, viewsButton, feedbackField, repostButton] { view.transform = risen ? .identity : CGAffineTransform(translationX: 0, y: opening.barDrop) }
    }

    func showOpeningBar(_ shown: Bool) {
        for view in [heartButton, viewsButton, feedbackField, repostButton] { view.alpha = shown ? 1 : 0 }
    }
}

/// One frame's segment of the strip: a translucent track filled from the left.
final class StoryProgressSegment: UIView {
    private let fill = CALayer()

    var progress: CGFloat = 0 { didSet { if progress != oldValue { placeFill() } } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.storiesProgressTrack)
        fill.backgroundColor = UIColor(Palette.storiesProgressFill).cgColor
        layer.addSublayer(fill)
        clipsToBounds = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        placeFill()
    }

    private func placeFill() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fill.frame = CGRect(x: 0, y: 0, width: bounds.width * max(0, min(1, progress)), height: bounds.height)
        CATransaction.commit()
    }
}
#endif
