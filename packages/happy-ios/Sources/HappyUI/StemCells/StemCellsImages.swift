#if canImport(UIKit)
import HappyCore
import ImageIO
import UIKit

/// Pictures the daemon serves (bot avatars, media), read once over the
/// tunnel and decoded off the main thread at the size they are drawn.
@MainActor
final class StemCellsImages {
    private let client: DirectAgentClient
    private let cache = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]

    init(client: DirectAgentClient) { self.client = client }

    func cached(_ path: String, pixels: Int) -> UIImage? {
        cache.object(forKey: "\(pixels):\(path)" as NSString)
    }

    func image(_ path: String, pixels: Int) async -> UIImage? {
        let key = "\(pixels):\(path)"
        if let cached = cache.object(forKey: key as NSString) { return cached }
        if let task = loading[key] { return await task.value }
        let client = client
        let task = Task<UIImage?, Never>.detached(priority: .userInitiated) {
            guard let data = try? await client.image(path) else { return nil }
            return Self.decode(data, maxPixels: pixels)
        }
        loading[key] = task
        let image = await task.value
        loading.removeValue(forKey: key)
        if let image { cache.setObject(image, forKey: key as NSString) }
        return image
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
