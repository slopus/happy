#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

extension UIImage {
    /// One of happy-app's icons at RN's `size`, as a template image to tint.
    /// An icon missing from the catalog draws as an empty square, so a
    /// screen never crashes over a glyph that was not generated.
    public static func icon(_ icon: Icon, size: CGFloat) -> UIImage {
        let key = IconImageKey(icon: icon, size: size)
        if let cached = IconImageCache.shared.object(forKey: key) { return cached }
        let box = CGSize(width: size, height: size)
        let renderer = UIGraphicsImageRenderer(size: box)
        let image = renderer.image { context in
            guard let glyph = IconCatalog.glyph(for: icon) else { return }
            let scale = size / glyph.unitsPerEm
            let cg = context.cgContext
            cg.translateBy(x: (size - glyph.advance * scale) / 2, y: 0)
            cg.scaleBy(x: scale, y: scale)
            cg.addPath(glyph.path.cgPath)
            cg.fillPath()
        }.withRenderingMode(.alwaysTemplate)
        IconImageCache.shared.setObject(image, forKey: key)
        return image
    }
}

private final class IconImageKey: NSObject {
    let icon: Icon
    let size: CGFloat

    init(icon: Icon, size: CGFloat) {
        self.icon = icon
        self.size = size
    }

    override var hash: Int {
        var hasher = Hasher()
        hasher.combine(icon)
        hasher.combine(size)
        return hasher.finalize()
    }

    override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? IconImageKey else { return false }
        return other.icon == icon && other.size == size
    }
}

private enum IconImageCache {
    nonisolated(unsafe) static let shared = NSCache<IconImageKey, UIImage>()
}
#endif
