#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The screen that can load a session's pictures, found up the responder
/// chain from the view that shows one.
@MainActor
protocol ChatAttachmentProviding: AnyObject {
    var chatAttachments: ChatAttachmentImages? { get }
}

/// useAttachmentImage for one session of one account: its pictures, read
/// into the account's `MediaLibrary` once and kept there for good (sealed
/// on the server, opened as they arrive and kept only once their MAC
/// checks), decoded off the main thread at no more than FileView draws,
/// and kept decoded in the account's own `AttachmentPictures`, never
/// another account's. A picture reads itself when automatic download
/// allows it (`MediaAutoDownload`), else on a tap on its ring. Their
/// thumbhashes are `ThumbHashImages`', which the view sets while it is
/// configured.
@MainActor
final class ChatAttachmentImages: NSObject {
    typealias Source = @Sendable (_ ref: String, _ size: Int?) async throws -> MediaSource

    private let pictures: AttachmentPictures
    private let sessionId: String
    private let load: (@Sendable (_ ref: String) async throws -> Data)?
    /// The account's outbox files, where a picture not yet sent is kept.
    private let files: URL?
    private let library: MediaLibrary?
    private let source: Source?
    private var sources: [String: MediaSource] = [:]
    /// Pictures a person tapped, read whatever the rules say.
    private var requested: Set<String> = []
    private var rules = MediaAutoDownload.load()
    /// Recordings' streams and lengths, by ref.
    private var streams: [String: MediaStream] = [:]
    private var durations: [String: Double] = [:]

    /// Whole pictures from `load`, with no library: tests and fixtures.
    init(
        pictures: AttachmentPictures,
        sessionId: String,
        files: URL? = nil,
        load: @escaping @Sendable (_ ref: String) async throws -> Data
    ) {
        self.pictures = pictures
        self.sessionId = sessionId
        self.files = files
        self.load = load
        library = nil
        source = nil
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }

    init(pictures: AttachmentPictures, sessionId: String, files: URL? = nil, library: MediaLibrary, source: @escaping Source) {
        self.pictures = pictures
        self.sessionId = sessionId
        self.files = files
        self.library = library
        self.source = source
        load = nil
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(rulesChanged), name: MediaAutoDownload.didChange, object: nil)
    }

    @objc private func memoryWarning() {
        pictures.removeAll()
    }

    @objc private func rulesChanged() {
        rules = MediaAutoDownload.load()
    }

    func cached(_ ref: String) -> UIImage? {
        pictures.cached(key(ref)) as? UIImage
    }

    // MARK: Kept files

    /// The download behind an attachment, where the library keeps it.
    func download(_ ref: String) -> ChatDownload? {
        library.map { ChatDownload(boardKey: $0.key(ref), duration: durations[ref]) }
    }

    private func mediaSource(_ ref: String, size: Int?) async -> MediaSource? {
        if let kept = sources[ref] { return kept }
        guard let source, let made = try? await source(ref, size) else { return nil }
        sources[ref] = made
        return made
    }

    /// Puts where the attachment is on the board, read off the main thread.
    func publish(_ ref: String, size: Int?) {
        guard let library else { return }
        Task {
            guard let source = await mediaSource(ref, size: size) else { return }
            await library.downloads.phase(ref, source: source)
        }
    }

    /// A tap on its ring: pause what is going, else read it.
    func toggle(_ ref: String, size: Int? = nil) {
        guard let library else { return }
        requested.insert(ref)
        Task {
            guard let source = await mediaSource(ref, size: size) else { return }
            await library.downloads.toggle(ref, source: source)
        }
    }

    /// The picture, or nil when it couldn't be downloaded, decrypted or
    /// read, or waits for a tap.
    func image(_ ref: String, size: Int? = nil) async -> UIImage? {
        let bytes: @Sendable () async -> Data?
        if let library {
            guard let source = await mediaSource(ref, size: size) else { return nil }
            let allowed = requested.contains(ref) || rules.allows(.photos, size: size)
            if !allowed, !(await library.downloads.phase(ref, source: source).isComplete) { return nil }
            bytes = { try? await library.downloads.data(ref, source: source, priority: .user) }
        } else if let load {
            bytes = { try? await load(ref) }
        } else {
            return nil
        }
        let picture = await pictures.picture(key(ref)) {
            guard let data = await bytes(), let image = UIImage(data: data) else { return nil }
            let decoded = image.preparingThumbnail(of: FileViewLayout.decodedSize(image.size)) ?? image
            return (picture: decoded as AttachmentPictures.Picture, cost: ChatAttachmentImages.cost(decoded))
        }
        return picture as? UIImage
    }

    private func key(_ ref: String) -> AttachmentPictures.Key {
        AttachmentPictures.Key(sessionId: sessionId, ref: ref)
    }

    // MARK: Recordings

    /// A recording's stream: what is here, and the rest a range at a time,
    /// opened on the way (`MediaSeal`).
    private func stream(_ attachment: ChatAttachment, library: MediaLibrary) -> MediaStream {
        if let stream = streams[attachment.ref] { return stream }
        let (ref, size) = (attachment.ref, attachment.size)
        let made = MediaStream(downloads: library.downloads, id: ref, name: attachment.name, mimeType: attachment.mimeType ?? "") { [weak self] in
            guard let source = await self?.mediaSource(ref, size: size) else { throw MediaError.stopped }
            return source
        }
        streams[ref] = made
        return made
    }

    /// A player for a recording, streaming as it plays; the rest of the
    /// file reads on behind it, so it is kept once played. Nil with no
    /// library to keep it in.
    func player(_ attachment: ChatAttachment) -> AVPlayer? {
        guard attachment.isVideo, let library else { return nil }
        let ref = attachment.ref
        requested.insert(ref)
        let stream = stream(attachment, library: library)
        Task {
            guard let source = await mediaSource(ref, size: attachment.size) else { return }
            await library.downloads.download(ref, source: source, priority: .user)
        }
        return AVPlayer(playerItem: AVPlayerItem(asset: stream.asset()))
    }

    /// A recording's first frame and length, read through its stream: the
    /// few ranges they take, kept for when it plays.
    func poster(_ attachment: ChatAttachment) async -> UIImage? {
        guard let library else { return nil }
        let ref = attachment.ref
        let asset = stream(attachment, library: library).asset()
        let picture = await pictures.picture(key(ref)) {
            let frames = AVAssetImageGenerator(asset: asset)
            frames.appliesPreferredTrackTransform = true
            frames.maximumSize = CGSize(width: 3 * FileViewLayout.Metrics.maxImageWidth, height: 3 * FileViewLayout.Metrics.maxImageHeight)
            guard let (frame, _) = try? await frames.image(at: .zero) else { return nil }
            let image = UIImage(cgImage: frame)
            return (picture: image as AttachmentPictures.Picture, cost: ChatAttachmentImages.cost(image))
        }
        if durations[ref] == nil, let duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds), duration.isFinite, duration > 0 {
            durations[ref] = duration
        }
        return picture as? UIImage
    }

    // MARK: Outbox

    func cachedLocal(_ localId: String) -> UIImage? {
        pictures.cached(key(UploadProgressBoard.outboxKey(localId))) as? UIImage
    }

    /// A picture still in the outbox, from this device's copy: decoded off
    /// the main thread at no more than FileView draws, a recording by its
    /// first frame. Nil when there is no copy or nothing in it can be drawn.
    func local(_ localId: String) async -> UIImage? {
        guard let files else { return nil }
        let file = files.appendingPathComponent(localId)
        let picture = await pictures.picture(key(UploadProgressBoard.outboxKey(localId))) {
            guard let image = await Self.drawable(file) else { return nil }
            let decoded = image.preparingThumbnail(of: FileViewLayout.decodedSize(image.size)) ?? image
            return (picture: decoded as AttachmentPictures.Picture, cost: ChatAttachmentImages.cost(decoded))
        }
        return picture as? UIImage
    }

    /// The outbox keeps its copies without an extension, so a recording is
    /// told apart only by failing to be a picture.
    private nonisolated static func drawable(_ file: URL) async -> UIImage? {
        if let image = UIImage(contentsOfFile: file.path) { return image }
        let asset = AVURLAsset(url: file, options: [AVURLAssetOverrideMIMETypeKey: "video/quicktime"])
        let frames = AVAssetImageGenerator(asset: asset)
        frames.appliesPreferredTrackTransform = true
        frames.maximumSize = CGSize(width: 3 * FileViewLayout.Metrics.maxImageWidth, height: 3 * FileViewLayout.Metrics.maxImageHeight)
        guard let (frame, _) = try? await frames.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame)
    }

    // MARK: Markdown images

    /// Fetched without cookies or a disk cache, so nothing of the account's
    /// is sent with it and nothing it fetches outlives the account's cache.
    private nonisolated static let web: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    func cachedWebImage(_ url: URL) -> UIImage? {
        pictures.cached(.web(url.absoluteString)) as? UIImage
    }

    /// RenderImageBlock's `<Image source={{ uri }}>`: an http(s) or base64
    /// `data:` picture, decoded off the main thread at no more than it is
    /// drawn; nil when it can't be had.
    func webImage(_ url: URL) async -> UIImage? {
        let picture = await pictures.picture(.web(url.absoluteString)) {
            guard let data = await Self.fetch(url), let image = UIImage(data: data) else { return nil }
            let decoded = image.preparingThumbnail(of: MarkdownLayout.decodedImageSize(image.size)) ?? image
            return (picture: decoded as AttachmentPictures.Picture, cost: ChatAttachmentImages.cost(decoded))
        }
        return picture as? UIImage
    }

    private nonisolated static func fetch(_ url: URL) async -> Data? {
        switch url.scheme?.lowercased() {
        case "http", "https":
            guard let (data, response) = try? await web.data(from: url) else { return nil }
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
            return data
        case "data":
            // data:[<type>][;base64],<payload>
            let string = url.absoluteString
            guard let comma = string.firstIndex(of: ","), string[..<comma].hasSuffix(";base64") else { return nil }
            return Data(base64Encoded: String(string[string.index(after: comma)...]), options: .ignoreUnknownCharacters)
        default:
            return nil
        }
    }

    /// The decoded bitmap's bytes.
    nonisolated static func cost(_ image: UIImage) -> Int {
        if let cgImage = image.cgImage { return cgImage.bytesPerRow * cgImage.height }
        return Int(image.size.width * image.scale * image.size.height * image.scale * 4)
    }
}

/// FileView's picture: the thumbhash from the first frame, then the picture
/// faded in over it (expo-image's `transition`, here the app's `ImageFade`;
/// `contentFit="cover"`), rounded 8. One that couldn't be loaded keeps its
/// thumbhash under an alert badge. It loads once it is on screen, from the
/// screen up its responder chain, which is also where it looks for a
/// picture already kept: it holds none of its own.
///
/// One still in the outbox is this device's copy, dimmed under Telegram's
/// ring, as the agent chat's sending picture is (`ChatMediaView`): the
/// share of its bytes written fills the ring a frame at a time
/// (`UploadRings`), and a failed one shows the ring's retry arrow. One
/// sent but not on this phone shows the same ring for its download (the
/// arrow, or how far it is) and its size in the corner.
final class ChatAttachmentView: UIView, UploadRingTile, DownloadShowing {
    private let placeholder = UIImageView()
    private let picture = UIImageView()
    private let badge = UIView()
    private let badgeIcon = UIImageView()
    /// Still going to the server: the picture dimmed under its ring.
    private let dim = UIView()
    /// The upload's or download's ring.
    private(set) var ring: MediaRingView?
    private(set) var sizeBadge: MediaBadgeView?
    private var attachment: ChatAttachment?
    private var task: Task<Void, Never>?
    /// The upload board key this tile shows the ring of, if any.
    private var following: String?
    /// The download board key it follows, and where that download is.
    private var boardKey: String?
    private(set) var downloadPhase: DownloadPhase?

    /// The thumbhash under the picture, for tests.
    var placeholderImage: UIImage? { placeholder.image }
    var pictureImage: UIImage? { picture.image }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        layer.cornerRadius = FileViewLayout.Metrics.radius
        layer.cornerCurve = .continuous
        isUserInteractionEnabled = false
        for view in [placeholder, picture] {
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            addSubview(view)
        }
        badge.backgroundColor = UIColor(Palette.surfaceHigh)
        badge.layer.cornerRadius = FileViewLayout.Metrics.badgeSize / 2
        badge.isHidden = true
        badgeIcon.contentMode = .center
        badgeIcon.image = .icon(.ionicons("alert-circle-outline"), size: FileViewLayout.Metrics.badgeIconSize)
        badgeIcon.tintColor = UIColor(Palette.textSecondary)
        badge.addSubview(badgeIcon)
        addSubview(badge)
        dim.isUserInteractionEnabled = false
        dim.backgroundColor = UIColor(Palette.uploadDim)
        dim.isHidden = true
        addSubview(dim)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Nil lets go of the picture.
    func apply(_ attachment: ChatAttachment?) {
        guard attachment != self.attachment else { return }
        // The same copy, only how it is sending (or the ref it was given)
        // changed: the picture stays as it is.
        if let attachment, let local = attachment.local, local == self.attachment?.local {
            self.attachment = attachment
            follow(attachment.upload)
            return
        }
        task?.cancel()
        task = nil
        self.attachment = attachment
        // Now, not once it is on screen: its first frame shows it.
        placeholder.image = ThumbHashImages.image(attachment?.thumbhash)
        picture.layer.removeAllAnimations()
        picture.image = nil
        picture.alpha = 1
        badge.isHidden = true
        follow(attachment?.upload)
        followDownload()
        loadIfNeeded()
    }

    private func makeRing() -> MediaRingView {
        if let ring { return ring }
        let ring = MediaRingView()
        addSubview(ring)
        self.ring = ring
        setNeedsLayout()
        return ring
    }

    // MARK: Uploading

    /// Shows `upload`'s ring and asks `UploadRings` for its frames.
    private func follow(_ upload: ChatUpload?) {
        if let following, following != upload?.key { UploadRings.shared.forget(self, key: following) }
        following = upload?.key
        guard let upload else {
            dim.isHidden = true
            if boardKey == nil { ring?.isHidden = true }
            return
        }
        UploadRings.shared.show(self, key: upload.key)
        setUpload(UploadRings.shared.phase(upload.key), animated: false)
    }

    /// Frames `UploadRings` moved its ring in, for tests.
    private(set) var ringApplies = 0

    /// Where its bytes are: what `UploadRings` applies, a frame at a time.
    func setUpload(_ phase: UploadPhase?, animated: Bool) {
        guard let upload = attachment?.upload else { return }
        if animated { ringApplies += 1 }
        let ring = makeRing()
        let state: MediaRingView.State
        if upload.failed { state = .failed }
        else {
            switch phase {
            case nil, .preparing: state = .waiting
            case .uploading(let share): state = .progress(share)
            case .done: state = .done
            }
        }
        ring.set(state, animated: animated)
        sizeBadge?.setLines([])
        if state != .done { dim.isHidden = false; dim.alpha = 1 }
        else if animated, !dim.isHidden {
            UIView.animate(withDuration: 0.25) { self.dim.alpha = 0 } completion: { _ in
                if self.ring?.state == .done { self.dim.isHidden = true }
            }
        } else {
            dim.isHidden = true
        }
    }

    // MARK: Downloading

    /// Follows the download behind a sent picture; one still in the
    /// outbox is this device's own copy.
    private func followDownload() {
        let found = attachment.flatMap { attachment in attachment.local == nil ? source()?.download(attachment.ref) : nil }
        if let boardKey, boardKey != found?.boardKey { DownloadRings.shared.forget(self, key: boardKey) }
        boardKey = found?.boardKey
        guard let found, let attachment else {
            downloadPhase = nil
            sizeBadge?.setLines([])
            refreshRing(animated: false)
            return
        }
        DownloadRings.shared.show(self, key: found.boardKey)
        let phase = DownloadRings.shared.phase(found.boardKey)
        if phase == nil { source()?.publish(attachment.ref, size: attachment.size) }
        setDownload(phase, animated: false)
    }

    func setDownload(_ phase: DownloadPhase?, animated: Bool) {
        guard let attachment, attachment.upload == nil else { return }
        let was = downloadPhase
        downloadPhase = phase
        refreshRing(animated: animated)
        if phase.map({ !$0.isComplete }) == true { badge.isHidden = true }
        // Here now: the picture it waited for.
        if phase?.isComplete == true, was?.isComplete != true, picture.image == nil, !attachment.isVideo {
            task?.cancel()
            task = nil
            badge.isHidden = true
            loadIfNeeded()
        }
    }

    /// Its recording was tapped and waits for its first range: the spinner.
    func setStarting(_ starting: Bool) {
        refreshRing(animated: false)
    }

    /// The ring and badge for a sent attachment: a picture's download, a
    /// recording's play button with its length and size.
    private func refreshRing(animated: Bool) {
        guard let attachment, attachment.upload == nil else { return }
        let video = attachment.isVideo && attachment.local == nil
        let state: MediaRingView.State
        if let boardKey {
            state = MediaRingView.state(downloadPhase, video: video, starting: DownloadRings.shared.isStarting(boardKey))
        } else {
            state = video ? .play : .done
        }
        if state == .done { ring?.set(.done, animated: animated) } else { makeRing().set(state, animated: animated) }
        var lines: [String] = []
        if video, let duration = duration { lines.append(MediaSizeText.duration(duration)) }
        if let phase = downloadPhase, !phase.isComplete || (video && lines.isEmpty), let size = MediaSizeText.text(phase) { lines.append(size) }
        if !lines.isEmpty, sizeBadge == nil {
            let made = MediaBadgeView()
            addSubview(made)
            sizeBadge = made
        }
        sizeBadge?.setLines(lines)
        setNeedsLayout()
    }

    /// A recording's length, once its first frame was read.
    private var duration: Double? {
        attachment.flatMap { source()?.download($0.ref)?.duration }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil, boardKey == nil { followDownload() }
        loadIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholder.frame = bounds
        picture.frame = bounds
        let badgeFrame = FileViewLayout.badge(in: bounds.size)
        badge.frame = badgeFrame
        badgeIcon.frame = badge.bounds
        dim.frame = bounds
        ring?.frame = UploadRingLayout.disc(in: bounds.size)
        if let sizeBadge, !sizeBadge.isHidden {
            sizeBadge.apply(MediaStatusLayout.badge(in: bounds.size, lines: sizeBadge.lineSizes()))
        }
    }

    private func loadIfNeeded() {
        guard window != nil, let attachment, let images = source() else { return }
        guard task == nil, picture.image == nil, badge.isHidden else { return }
        if let local = attachment.local {
            if let image = images.cachedLocal(local) {
                picture.image = image
                return
            }
            task = Task { @MainActor [weak self] in
                let image = await images.local(local)
                // No copy to draw: the thumbhash stays, with no alarm.
                guard !Task.isCancelled, let self, self.attachment?.local == local, let image else { return }
                self.picture.image = image
                ImageFade.fadeIn(self.picture)
            }
            return
        }
        // Before the first frame it is drawn in, so no fade.
        if let image = images.cached(attachment.ref) {
            picture.image = image
            return
        }
        task = Task { @MainActor [weak self] in
            // A recording's first frame, read through its stream.
            let image = attachment.isVideo ? await images.poster(attachment) : await images.image(attachment.ref, size: attachment.size)
            guard !Task.isCancelled, let self, self.attachment == attachment else { return }
            self.task = nil
            // Its length is known with its first frame.
            if attachment.isVideo { self.refreshRing(animated: false) }
            guard let image else {
                // Waiting for a tap, or saying how its download went: the
                // ring does. Otherwise `error && !uri`.
                if self.boardKey == nil || self.downloadPhase?.isComplete == true { self.badge.isHidden = false }
                return
            }
            self.picture.image = image
            ImageFade.fadeIn(self.picture)
        }
    }

    private func source() -> ChatAttachmentImages? {
        var responder: UIResponder? = self
        while let current = responder {
            if let provider = current as? ChatAttachmentProviding { return provider.chatAttachments }
            responder = current.next
        }
        return nil
    }
}
/// RenderImageBlock's picture: `resizeMode="contain"` in its box, which
/// the plan draws in `surfaceHighest` behind it and rounds 12. Nothing more
/// when it can't be loaded, as React Native's Image shows nothing. It
/// loads once it is on screen, from the screen up its responder chain.
final class ChatWebImageView: UIImageView {
    private var url: URL?
    private var task: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentMode = .scaleAspectFit
        clipsToBounds = true
        layer.cornerRadius = MarkdownLayout.Metrics.imageRadius
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Nil lets go of the picture.
    func apply(_ url: URL?, label: String?) {
        accessibilityLabel = label
        guard url != self.url else { return }
        task?.cancel()
        task = nil
        self.url = url
        image = nil
        loadIfNeeded()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        loadIfNeeded()
    }

    private func loadIfNeeded() {
        guard task == nil, window != nil, let url, image == nil, let images = source() else { return }
        if let cached = images.cachedWebImage(url) {
            image = cached
            return
        }
        task = Task { @MainActor [weak self] in
            let image = await images.webImage(url)
            guard !Task.isCancelled, let self, self.url == url else { return }
            self.image = image
        }
    }

    private func source() -> ChatAttachmentImages? {
        var responder: UIResponder? = self
        while let current = responder {
            if let provider = current as? ChatAttachmentProviding { return provider.chatAttachments }
            responder = current.next
        }
        return nil
    }
}
#endif
