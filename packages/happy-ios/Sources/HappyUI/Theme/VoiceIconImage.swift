#if canImport(UIKit)
import HappyLayout
import UIKit

extension UIImage {
    /// The voice button's three bars (`VoiceIconLayout`), as a template so
    /// it takes the bar's tint as compose does.
    static func voiceIcon(size: CGFloat = 22, scale: CGFloat? = nil) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        if let scale { format.scale = scale }
        format.opaque = false
        let key = "\(size)@\(format.scale)" as NSString
        if let cached = voiceIcons.object(forKey: key) { return cached }
        let layout = VoiceIconLayout(size: size)
        let image = UIGraphicsImageRenderer(size: layout.size, format: format).image { _ in
            for bar in layout.bars {
                UIBezierPath(roundedRect: bar, cornerRadius: bar.width / 2).fill()
            }
        }.withRenderingMode(.alwaysTemplate)
        voiceIcons.setObject(image, forKey: key)
        return image
    }
}

private nonisolated(unsafe) let voiceIcons = NSCache<NSString, UIImage>()
#endif
