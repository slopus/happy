#if canImport(UIKit)
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

/// useAttachmentImage for one session of one account: its pictures,
/// downloaded and decrypted by `load`, decoded off the main thread at no
/// more than FileView draws, and kept in the account's own
/// `AttachmentPictures`, never another account's. Their thumbhashes are
/// decoded off the main thread too, and kept in the account's own
/// `AccountPictures`.
@MainActor
final class ChatAttachmentImages: NSObject {
    private let pictures: AttachmentPictures
    private let placeholders: AccountPictures?
    private let sessionId: String
    private let load: @Sendable (_ ref: String) async throws -> Data

    init(
        pictures: AttachmentPictures,
        placeholders: AccountPictures? = nil,
        sessionId: String,
        load: @escaping @Sendable (_ ref: String) async throws -> Data
    ) {
        self.pictures = pictures
        self.placeholders = placeholders
        self.sessionId = sessionId
        self.load = load
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }

    @objc private func memoryWarning() {
        pictures.removeAll()
        placeholders?.removeAll()
    }

    /// A thumbhash already decoded, or nil.
    func cachedPlaceholder(_ thumbhash: String) -> UIImage? {
        placeholders?.cachedPlaceholderImage(thumbhash)
    }

    /// The thumbhash as a picture, decoded off the main thread.
    func placeholder(_ thumbhash: String) async -> UIImage? {
        await placeholders?.placeholderImage(thumbhash)
    }

    func cached(_ ref: String) -> UIImage? {
        pictures.cached(key(ref)) as? UIImage
    }

    /// The picture, or nil when it couldn't be downloaded, decrypted or
    /// read.
    func image(_ ref: String) async -> UIImage? {
        let load = self.load
        let picture = await pictures.picture(key(ref)) {
            guard let data = try? await load(ref), let image = UIImage(data: data) else { return nil }
            let decoded = image.preparingThumbnail(of: FileViewLayout.decodedSize(image.size)) ?? image
            return (picture: decoded as AttachmentPictures.Picture, cost: ChatAttachmentImages.cost(decoded))
        }
        return picture as? UIImage
    }

    private func key(_ ref: String) -> AttachmentPictures.Key {
        AttachmentPictures.Key(sessionId: sessionId, ref: ref)
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

/// FileView's picture: the thumbhash, then the picture faded in over it
/// (expo-image's `transition={150}`, `contentFit="cover"`), rounded 8. One
/// that couldn't be loaded keeps its thumbhash under an alert badge. It
/// loads once it is on screen, from the screen up its responder chain,
/// which is also where it looks for a picture already kept: it holds none
/// of its own.
final class ChatAttachmentView: UIView {
    private let placeholder = UIImageView()
    private let picture = UIImageView()
    private let badge = UIView()
    private let badgeIcon = UIImageView()
    private var attachment: ChatAttachment?
    private var task: Task<Void, Never>?
    private var placeholderTask: Task<Void, Never>?

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
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Nil lets go of the picture.
    func apply(_ attachment: ChatAttachment?) {
        guard attachment != self.attachment else { return }
        task?.cancel()
        task = nil
        placeholderTask?.cancel()
        placeholderTask = nil
        self.attachment = attachment
        // Only one already decoded; any other is decoded off the main thread.
        placeholder.image = attachment?.thumbhash.flatMap { source()?.cachedPlaceholder($0) }
        picture.image = nil
        picture.alpha = 1
        badge.isHidden = true
        loadIfNeeded()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        loadIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholder.frame = bounds
        picture.frame = bounds
        let badgeFrame = FileViewLayout.badge(in: bounds.size)
        badge.frame = badgeFrame
        badgeIcon.frame = badge.bounds
    }

    private func loadIfNeeded() {
        guard window != nil, let attachment, let images = source() else { return }
        loadPlaceholderIfNeeded(attachment, from: images)
        guard task == nil, picture.image == nil, badge.isHidden else { return }
        // Before the first frame it is drawn in, so no fade.
        if let image = images.cached(attachment.ref) {
            picture.image = image
            return
        }
        task = Task { @MainActor [weak self] in
            let image = await images.image(attachment.ref)
            guard !Task.isCancelled, let self, self.attachment == attachment else { return }
            guard let image else {
                // `error && !uri`.
                self.badge.isHidden = false
                return
            }
            self.picture.image = image
            self.picture.alpha = 0
            UIView.animate(withDuration: FileViewLayout.Metrics.fadeIn) { self.picture.alpha = 1 }
        }
    }

    /// The thumbhash, under the picture and under the badge when the
    /// picture can't be had.
    private func loadPlaceholderIfNeeded(_ attachment: ChatAttachment, from images: ChatAttachmentImages) {
        guard placeholderTask == nil, placeholder.image == nil, let thumbhash = attachment.thumbhash else { return }
        if let image = images.cachedPlaceholder(thumbhash) {
            placeholder.image = image
            return
        }
        placeholderTask = Task { @MainActor [weak self] in
            let image = await images.placeholder(thumbhash)
            guard !Task.isCancelled, let self, self.attachment == attachment else { return }
            self.placeholder.image = image
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
