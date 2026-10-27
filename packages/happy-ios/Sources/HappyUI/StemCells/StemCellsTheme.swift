#if canImport(UIKit)
import CoreText
import HappyCore
import HappyIcons
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

    /// The face with even-width figures (`tabular-nums`), for a clock.
    static func tabular(_ font: UIFont) -> UIFont {
        UIFont(descriptor: font.fontDescriptor.addingAttributes([.featureSettings: [[
            UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
            UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector,
        ]]]), size: font.pointSize)
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

/// Desktop's icon names (`IconName`) as happy-app's icons: the glyphs a row
/// wears when it has nothing of its own, and the ones its menus and states use.
enum StemCellsGlyphs {
    static func icon(_ name: String) -> Icon {
        switch name {
        case "search": .ionicons("search-outline")
        case "compose": .ionicons("create-outline")
        case "tasks": .ionicons("checkbox-outline")
        case "agents": .ionicons("person-circle-outline")
        case "doc": .ionicons("document-text-outline")
        case "calendar": .ionicons("calendar-outline")
        case "pulse": .ionicons("pulse-outline")
        case "users": .ionicons("people-outline")
        case "chevron-right": .ionicons("chevron-forward")
        case "chevron-down": .ionicons("chevron-down")
        case "open": .ionicons("chevron-forward")
        case "pencil": .octicons("pencil")
        case "close": .ionicons("close-outline")
        case "archive": .ionicons("archive-outline")
        case "trash": .ionicons("trash-outline")
        case "list": .ionicons("list-outline")
        case "question": .ionicons("help-circle")
        case "clock": .ionicons("time-outline")
        case "layers": .ionicons("layers-outline")
        case "eye": .ionicons("eye-outline")
        case "eye-off": .ionicons("eye-off-outline")
        case "more": .materialIcons("more-horiz")
        case "reorder": .ionicons("swap-vertical-outline")
        case "terminal": .ionicons("terminal-outline")
        default: .ionicons(name)
        }
    }

    /// A template image to tint, `size` points as RN sizes an icon.
    static func image(_ name: String, size: CGFloat = 16) -> UIImage {
        UIImage.icon(icon(name), size: size)
    }
}
#endif
