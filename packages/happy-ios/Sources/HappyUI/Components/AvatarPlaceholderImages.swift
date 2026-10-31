#if canImport(UIKit)
import HappyLayout
import ImageIO
import UIKit

/// The bundled placeholder pictures (`AvatarPlaceholder`) as UIImages,
/// decoded off the main thread at the size they are drawn, and kept.
@MainActor
enum AvatarPlaceholderImages {
    private static let cache = NSCache<NSString, UIImage>()
    private static var loading: [String: Task<UIImage?, Never>] = [:]

    /// The largest a placeholder is drawn: Settings' agent picture at 3x
    /// fits in the 384 pixels each is bundled at.
    static let maxPixels = 384

    /// `seed`'s picture, `side` points across at `scale`, if it is decoded.
    static func cached(seed: String, side: CGFloat, scale: CGFloat? = nil, monochrome: Bool = false) -> UIImage? {
        cache.object(forKey: key(seed: seed, side: side, scale: scale, monochrome: monochrome) as NSString)
    }

    /// `seed`'s picture, `side` points across at `scale` (the screen's when
    /// nil); nil only when the bundle lacks it.
    static func image(seed: String, side: CGFloat, scale: CGFloat? = nil, monochrome: Bool = false) async -> UIImage? {
        let key = key(seed: seed, side: side, scale: scale, monochrome: monochrome)
        if let image = cache.object(forKey: key as NSString) { return image }
        if let task = loading[key] { return await task.value }
        let name = AvatarPlaceholder.name(seed: seed)
        let scale = resolved(scale)
        let pixels = pixels(side: side, scale: scale)
        let task = Task<UIImage?, Never>.detached(priority: .userInitiated) {
            guard let url = url(name) else { return nil }
            return decode(url, pixels: pixels, scale: scale, monochrome: monochrome)
        }
        loading[key] = task
        let image = await task.value
        loading.removeValue(forKey: key)
        if let image { cache.setObject(image, forKey: key as NSString) }
        return image
    }

    /// An empty circle `side` across, where a picture still being decoded
    /// goes, so nothing else stands in for it. Made once per size and
    /// style, so showing it again is no change for a view to fade.
    static func pending(side: CGFloat) -> UIImage {
        let key = "\(side):\(UITraitCollection.current.userInterfaceStyle.rawValue)"
        if let made = pendings[key] { return made }
        let size = CGSize(width: side, height: side)
        let made = UIGraphicsImageRenderer(size: size).image { _ in
            UIColor(Palette.settingsAddFill).setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
        }.withRenderingMode(.alwaysOriginal)
        pendings[key] = made
        return made
    }
    private static var pendings: [String: UIImage] = [:]

    nonisolated static func url(_ name: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: "webp")
            ?? Bundle.module.url(forResource: name, withExtension: "webp", subdirectory: "AvatarPlaceholders")
    }

    /// The file as a bitmap `pixels` across, decoded now rather than when
    /// first drawn; drained of colour for `monochrome`.
    nonisolated static func decode(_ url: URL, pixels: Int, scale: CGFloat, monochrome: Bool) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels,
        ]
        guard var image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        if monochrome, let gray = grayscale(image) { image = gray }
        return UIImage(cgImage: image, scale: scale, orientation: .up)
    }

    private nonisolated static func grayscale(_ image: CGImage) -> CGImage? {
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.makeImage()
    }

    private static func resolved(_ scale: CGFloat?) -> CGFloat {
        let scale = scale ?? UITraitCollection.current.displayScale
        return scale > 0 ? scale : 3
    }

    private static func pixels(side: CGFloat, scale: CGFloat) -> Int {
        min(maxPixels, max(1, Int((side * scale).rounded(.up))))
    }

    private static func key(seed: String, side: CGFloat, scale: CGFloat?, monochrome: Bool) -> String {
        let scale = resolved(scale)
        return "\(AvatarPlaceholder.index(seed: seed)):\(pixels(side: side, scale: scale)):\(scale):\(monochrome ? "m" : "c")"
    }
}

/// One view's placeholder: shown at once when it is already decoded, else
/// when it lands, unless the view has moved on to another seed by then.
@MainActor
final class AvatarPlaceholderSlot {
    private var task: Task<Void, Never>?
    private var shown: String?

    /// Hands `apply` the picture for `seed`; nil (now) for no seed.
    func show(seed: String?, side: CGFloat, monochrome: Bool = false, _ apply: @escaping @MainActor (UIImage?) -> Void) {
        let key = seed.map { "\($0)|\(side)|\(monochrome)" }
        guard key != shown || task == nil else { return }
        task?.cancel()
        task = nil
        shown = key
        guard let seed, side > 0 else { apply(nil); return }
        if let image = AvatarPlaceholderImages.cached(seed: seed, side: side, monochrome: monochrome) {
            apply(image)
            return
        }
        apply(nil)
        task = Task { [weak self] in
            let image = await AvatarPlaceholderImages.image(seed: seed, side: side, monochrome: monochrome)
            guard !Task.isCancelled, let self, shown == key else { return }
            task = nil
            apply(image)
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        shown = nil
    }

    deinit { task?.cancel() }
}
#endif
