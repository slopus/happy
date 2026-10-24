#if canImport(UIKit)
import HappyCore
import ImageIO
import UIKit

/// Pictures the daemon serves (bot avatars, media), read once over the
/// tunnel and decoded off the main thread at the size they are drawn.
/// A row's picture is kept on disk with the computer's offline copy, by
/// its path and hash, and drawn from there before (or without) the tunnel.
@MainActor
final class StemCellsImages {
    private let client: DirectAgentClient
    private let offline: StemCellsOfflineFile?
    private let cache = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]

    init(client: DirectAgentClient, offline: StemCellsOfflineFile? = nil) {
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

    static func placeholder(_ thumbhash: String?) -> UIImage? {
        guard let thumbhash else { return nil }
        return AccountPictureImages.placeholder(thumbhash)?.picture as? UIImage
    }
}
#endif
