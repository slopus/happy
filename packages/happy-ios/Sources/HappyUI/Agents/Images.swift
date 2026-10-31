#if canImport(UIKit)
import HappyCore
import ImageIO
import UIKit

/// Pictures the daemon serves (bot avatars, media), read once over the
/// tunnel and decoded off the main thread at the size they are drawn.
/// A row's picture is kept on disk with the computer's offline copy, by
/// its path and hash, and drawn from there before (or without) the tunnel.
@MainActor
final class Images {
    private let client: AgentClient
    private let offline: OfflineFile?
    private let cache = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]

    init(client: AgentClient, offline: OfflineFile? = nil) {
        self.client = client
        self.offline = offline
    }

    /// A row's picture: kept bytes at once, then the computer's.
    func picture(_ path: String, thumbhash: String?, pixels: Int) async -> UIImage? {
        let key = "\(pixels):\(path)#\(thumbhash ?? "")"
        if let cached = cache.object(forKey: key as NSString) { return cached }
        if let task = loading[key] { return await task.value }
        let client = client
        let offline = offline
        let task = Task<UIImage?, Never>.detached(priority: .userInitiated) {
            if let kept = offline?.picture(path, thumbhash: thumbhash), let image = Self.decode(kept, maxPixels: pixels) { return image }
            guard let data = try? await client.image(path) else { return nil }
            offline?.keepPicture(data, path: path, thumbhash: thumbhash)
            return Self.decode(data, maxPixels: pixels)
        }
        loading[key] = task
        let image = await task.value
        loading.removeValue(forKey: key)
        if let image { cache.setObject(image, forKey: key as NSString) }
        return image
    }

    func cachedPicture(_ path: String, thumbhash: String?, pixels: Int) -> UIImage? {
        cache.object(forKey: "\(pixels):\(path)#\(thumbhash ?? "")" as NSString)
    }

    /// The computer answers again: every picture that couldn't be read is
    /// asked for again (`MarkPicture`).
    func retryFailed() {
        NotificationCenter.default.post(name: Self.retry, object: self)
    }

    nonisolated static let retry = Notification.Name("Images.retry")

    nonisolated static func decode(_ data: Data, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// A mark's picture from the computer (a bot's, a project's, a member's):
/// its thumbhash at once, the picture faded in over it; one that couldn't
/// be read (the computer away, as a launch draws the kept rows before it
/// answers) is asked for again when it is back (`Images.retryFailed`),
/// not left on its thumbhash.
@MainActor
final class MarkPicture: NSObject {
    private var job: Task<Void, Never>?
    private var wanted: (path: String, thumbhash: String?, pixels: Int)?
    private weak var images: Images?
    private weak var view: UIImageView?
    private var missing = false
    private var failed: (@MainActor () -> Void)?
    private var shown: (@MainActor () -> Void)?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(retry(_:)), name: Images.retry, object: nil)
    }

    /// `failed` draws what stands in while it can't be read (a seed's
    /// placeholder where there is no thumbhash); `shown` runs once the
    /// picture is in, to take that away.
    func load(_ path: String, thumbhash: String?, pixels: Int, images: Images?, into view: UIImageView,
              failed: (@MainActor () -> Void)? = nil, shown: (@MainActor () -> Void)? = nil) {
        cancel()
        wanted = (path, thumbhash, pixels)
        self.images = images
        self.view = view
        self.failed = failed
        self.shown = shown
        if let cached = images?.cachedPicture(path, thumbhash: thumbhash, pixels: pixels) {
            view.image = cached
            shown?()
            return
        }
        view.image = ThumbHashImages.image(thumbhash)
        read(fade: true)
    }

    /// Lets go of what it was reading; the view shows something else.
    func cancel() {
        job?.cancel()
        job = nil
        wanted = nil
        missing = false
        failed = nil
        shown = nil
    }

    private func read(fade: Bool) {
        guard let wanted, let images else { return }
        missing = false
        job = Task { [weak self] in
            let image = await images.picture(wanted.path, thumbhash: wanted.thumbhash, pixels: wanted.pixels)
            guard !Task.isCancelled, let self else { return }
            job = nil
            guard let image, let view else {
                missing = true
                if view?.image == nil { failed?() }
                return
            }
            shown?()
            ImageFade.show(image, in: view, fade: fade)
        }
    }

    @objc private func retry(_ notification: Notification) {
        guard missing, job == nil, notification.object as AnyObject? === images else { return }
        read(fade: true)
    }

    deinit { job?.cancel() }
}
#endif
