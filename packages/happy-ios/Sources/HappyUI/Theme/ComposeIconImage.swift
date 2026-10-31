#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

extension UIImage {
    /// The existing compose outline, aligned by its square rather than its
    /// pencil's overhang or the icon font's line box. The bar's compose
    /// button draws it, and so does every V2 tile and row that shows
    /// create-outline (`Glyphs.image`).
    static func composeIcon(size: CGFloat = 22, scale: CGFloat? = nil) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        if let scale { format.scale = scale }
        format.opaque = false
        let key = "\(size)@\(format.scale)" as NSString
        if let cached = composeIcons.object(forKey: key) { return cached }
        guard let glyph = IconCatalog.glyph(for: .ionicons("create-outline")) else { return UIImage() }
        let layout = ComposeIconLayout(size: size)
        let image = UIGraphicsImageRenderer(size: layout.size, format: format).image { renderer in
            let context = renderer.cgContext
            context.translateBy(x: layout.glyphOrigin.x, y: layout.glyphOrigin.y)
            context.scaleBy(x: layout.glyphScale, y: layout.glyphScale)
            context.addPath(glyph.path.cgPath)
            context.fillPath(using: .winding)
        }.withRenderingMode(.alwaysTemplate)
        composeIcons.setObject(image, forKey: key)
        return image
    }
}

private nonisolated(unsafe) let composeIcons = NSCache<NSString, UIImage>()
#endif
