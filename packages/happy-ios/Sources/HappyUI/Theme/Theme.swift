#if canImport(UIKit)
import CoreText
import HappyLayout
import UIKit

extension UIColor {
    public convenience init(_ rgba: RGBA) {
        self.init(red: CGFloat(rgba.red), green: CGFloat(rgba.green), blue: CGFloat(rgba.blue), alpha: CGFloat(rgba.alpha))
    }

    /// A dynamic colour that follows light and dark appearance.
    public convenience init(_ token: ColorToken) {
        let light = UIColor(token.light)
        let dark = UIColor(token.dark)
        self.init { traits in traits.userInterfaceStyle == .dark ? dark : light }
    }
}

extension LayoutInsets {
    public init(_ insets: UIEdgeInsets) {
        self.init(top: insets.top, left: insets.left, bottom: insets.bottom, right: insets.right)
    }
}

public enum Fonts {
    /// Registers the bundled faces with the process once. UIFont(name:) only
    /// finds them afterwards; without it every style falls back to the
    /// system font.
    public static func registerBundledFonts() {
        _ = registration
    }

    private static let registration: Void = {
        for face in FontFace.allCases {
            let url = Bundle.module.url(forResource: face.rawValue, withExtension: "ttf")
                ?? Bundle.module.url(forResource: face.rawValue, withExtension: "ttf", subdirectory: "Fonts")
            guard let url else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    public static func font(_ face: FontFace, size: CGFloat) -> UIFont {
        if let font = UIFont(name: face.rawValue, size: size) {
            return font
        }
        switch face {
        case .regular: return .systemFont(ofSize: size)
        case .italic: return .italicSystemFont(ofSize: size)
        case .semiBold, .logo: return .systemFont(ofSize: size, weight: .semibold)
        case .mono, .monoItalic: return .monospacedSystemFont(ofSize: size, weight: .regular)
        case .monoSemiBold: return .monospacedSystemFont(ofSize: size, weight: .semibold)
        }
    }
}

extension TextStyle {
    public var font: UIFont {
        Fonts.font(face, size: size)
    }

    /// The height of one line in this style.
    public var lineHeightValue: CGFloat {
        lineHeight ?? font.lineHeight.rounded(.up)
    }

    public func attributes(
        color: UIColor,
        alignment: NSTextAlignment = .natural,
        lineBreakMode: NSLineBreakMode = .byWordWrapping
    ) -> [NSAttributedString.Key: Any] {
        let font = self.font
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = lineBreakMode
        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]
        if let lineHeight {
            paragraph.minimumLineHeight = lineHeight
            paragraph.maximumLineHeight = lineHeight
            // A fixed line height puts the slack above the glyphs; this
            // offset centres them in the line the way React Native does.
            attributes[.baselineOffset] = (lineHeight - font.lineHeight) / 4
        }
        if letterSpacing != 0 {
            attributes[.kern] = letterSpacing
        }
        return attributes
    }

    public func attributedString(
        _ string: String,
        color: UIColor,
        alignment: NSTextAlignment = .natural,
        lineBreakMode: NSLineBreakMode = .byWordWrapping
    ) -> NSAttributedString {
        NSAttributedString(
            string: uppercase ? string.uppercased() : string,
            attributes: attributes(color: color, alignment: alignment, lineBreakMode: lineBreakMode)
        )
    }
}

extension UIView {
    /// This view's size at a given width, for layouts that measure content.
    public var measurable: Measurable {
        Measurable { [unowned self] width in
            sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        }
    }

    /// Applies a computed frame, snapped to this screen's pixels.
    public func setLayoutFrame(_ frame: CGRect) {
        let scale = window?.screen.scale ?? traitCollection.displayScale
        self.frame = PixelGrid.snap(frame, scale: scale > 0 ? scale : 1)
    }

    /// One device pixel, for hairlines.
    var hairline: CGFloat {
        let scale = window?.screen.scale ?? traitCollection.displayScale
        return 1 / max(scale, 1)
    }
}

extension UIImage {
    /// An image from HappyUI's bundle.
    static func happy(_ name: String) -> UIImage? {
        UIImage(named: name, in: .module, compatibleWith: nil)
    }

    /// An SF Symbol at a point size, standing in for happy-app's Ionicons.
    static func symbol(_ name: String, pointSize: CGFloat, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
        UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight))
    }
}
#endif
