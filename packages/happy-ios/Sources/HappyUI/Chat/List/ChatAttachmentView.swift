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

/// useAttachmentImage: a session's pictures, downloaded and decrypted by
/// `load`, decoded off the main thread at no more than FileView shows, the
/// last 50 kept so scrolling back doesn't load them again, and one request
/// per picture at a time.
@MainActor
final class ChatAttachmentImages {
    /// `MAX_CACHE_ENTRIES`.
    static let maxCached = 50

    private static var cache: [String: UIImage] = [:]
    private static var order: [String] = []
    private var inFlight: [String: Task<UIImage?, Never>] = [:]
    private let load: @Sendable (_ ref: String) async throws -> Data

    init(load: @escaping @Sendable (_ ref: String) async throws -> Data) {
        self.load = load
    }

    static func cached(_ ref: String) -> UIImage? {
        cache[ref]
    }

    /// The picture, or nil when it couldn't be downloaded, decrypted or
    /// read.
    func image(_ ref: String) async -> UIImage? {
        if let image = Self.cache[ref] { return image }
        if let task = inFlight[ref] { return await task.value }
        let load = self.load
        let task = Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let data = try? await load(ref), let image = UIImage(data: data) else { return nil }
            return image.preparingThumbnail(of: FileViewLayout.decodedSize(image.size)) ?? image
        }
        inFlight[ref] = task
        let image = await task.value
        inFlight[ref] = nil
        if let image { Self.remember(ref, image) }
        return image
    }

    private static func remember(_ ref: String, _ image: UIImage) {
        if cache.updateValue(image, forKey: ref) != nil { order.removeAll { $0 == ref } }
        order.append(ref)
        while order.count > maxCached { cache[order.removeFirst()] = nil }
    }
}

/// FileView's picture: the thumbhash, then the picture faded in over it
/// (expo-image's `transition={150}`, `contentFit="cover"`), rounded 8. One
/// that couldn't be loaded keeps its thumbhash under an alert badge. It
/// loads once it is on screen, from the screen up its responder chain.
final class ChatAttachmentView: UIView {
    private let placeholder = UIImageView()
    private let picture = UIImageView()
    private let badge = UIView()
    private let badgeIcon = UIImageView()
    private var attachment: ChatAttachment?
    private var task: Task<Void, Never>?

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
        self.attachment = attachment
        placeholder.image = attachment?.thumbhash.flatMap(ThumbHashImages.image(base64:))
        picture.image = attachment.flatMap { ChatAttachmentImages.cached($0.ref) }
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
        guard task == nil, window != nil, let attachment, picture.image == nil, badge.isHidden, let images = source() else { return }
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
