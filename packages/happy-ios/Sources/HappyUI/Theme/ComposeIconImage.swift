#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

extension UIImage {
    /// The existing compose outline, aligned by its square rather than its
    /// pencil's overhang or the icon font's line box.
    static func composeIcon(size: CGFloat = 22, scale: CGFloat? = nil) -> UIImage {
        guard let glyph = IconCatalog.glyph(for: .ionicons("create-outline")) else { return UIImage() }
        let layout = ComposeIconLayout(size: size)
        let format = UIGraphicsImageRendererFormat.preferred()
        if let scale { format.scale = scale }
        format.opaque = false
        return UIGraphicsImageRenderer(size: layout.size, format: format).image { renderer in
            let context = renderer.cgContext
            context.translateBy(x: layout.glyphOrigin.x, y: layout.glyphOrigin.y)
            context.scaleBy(x: layout.glyphScale, y: layout.glyphScale)
            context.addPath(glyph.path.cgPath)
            context.fillPath(using: .winding)
        }.withRenderingMode(.alwaysTemplate)
    }
}
#endif