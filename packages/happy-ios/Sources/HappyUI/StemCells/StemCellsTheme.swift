#if canImport(UIKit)
import CoreText
import HappyCore
import HappyLayout
import UIKit

/// Desktop's faces for the Stem Cells screens: Figtree for the interface and
/// JetBrains Mono for section titles (`--happy-font-ui`, `--happy-font-mono`).
enum StemCellsFonts {
    private static let registration: Void = {
        for name in ["Figtree-latin", "JetBrainsMono-latin"] {
            guard let url = Bundle.module.url(forResource: name, withExtension: "woff2")
                ?? Bundle.module.url(forResource: name, withExtension: "woff2", subdirectory: "Fonts") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    enum Weight: String {
        case regular = "Figtree-Regular"
        case medium = "Figtree-Medium"
        case semiBold = "Figtree-SemiBold"
        case bold = "Figtree-Bold"
    }

    static func ui(_ weight: Weight, size: CGFloat) -> UIFont {
        _ = registration
        if let font = UIFont(name: weight.rawValue, size: size) { return font }
        let system: UIFont.Weight = switch weight {
        case .regular: .regular
        case .medium: .medium
        case .semiBold: .semibold
        case .bold: .bold
        }
        return .systemFont(ofSize: size, weight: system)
    }

    static func mono(bold: Bool, size: CGFloat) -> UIFont {
        _ = registration
        if let font = UIFont(name: bold ? "JetBrainsMono-Bold" : "JetBrainsMono-Regular", size: size) { return font }
        return .monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
    }
}

/// The library's clay icons and Happy's mark, bundled at 64px.
@MainActor
enum ClayIconImages {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(_ slug: String) -> UIImage? {
        if let cached = cache.object(forKey: slug as NSString) { return cached }
        guard ClayIcons.contains(slug),
              let url = Bundle.module.url(forResource: "clay-\(slug)", withExtension: "png")
                ?? Bundle.module.url(forResource: "clay-\(slug)", withExtension: "png", subdirectory: "ClayIcons"),
              let image = UIImage(contentsOfFile: url.path) else { return nil }
        cache.setObject(image, forKey: slug as NSString)
        return image
    }

    static var happy: UIImage? { UIImage.happy("clay-happy-mark") }
}

/// The glyphs a row wears when it has nothing of its own, as SF Symbols.
enum StemCellsGlyphs {
    static func image(_ name: String, size: CGFloat = 16, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
        let symbol = switch name {
        case "search": "magnifyingglass"
        case "compose": "square.and.pencil"
        case "tasks": "checklist"
        case "agents": "person.crop.circle"
        case "doc": "doc.text"
        default: name
        }
        return UIImage.symbol(symbol, pointSize: size, weight: weight)
    }
}
#endif
