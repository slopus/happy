#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The shared Gen UI glyphs (Lucide, bundled as `genui-<name>.png` at 1x,
/// 2x and 3x): a black glyph whose alpha is the mask, drawn as a template
/// image in its tone's ink. A name with no glyph draws nothing. Safe from
/// any thread.
enum GenUIIcons {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: UIImage] = [:]

    /// Whether `name` has a glyph.
    static func exists(_ name: String) -> Bool {
        !name.contains("/") && GenUIColors.theme?.icons.contains(name) == true
    }

    static func image(_ name: String) -> UIImage? {
        lock.lock()
        let kept = cache[name]
        lock.unlock()
        if let kept { return kept }
        guard !name.contains("/"), let image = UIImage(named: "genui-\(name)", in: .module, compatibleWith: nil)
            ?? UIImage(named: "GenUI/Icons/genui-\(name)", in: .module, compatibleWith: nil) else { return nil }
        let template = image.withRenderingMode(.alwaysTemplate)
        lock.lock()
        cache[name] = template
        lock.unlock()
        return template
    }

    /// Draws `name` into the current context, filling `rect` in `ink`.
    static func draw(_ name: String, in rect: CGRect, ink: UIColor) {
        guard let image = image(name) else { return }
        image.withTintColor(ink.resolvedColor(with: .current), renderingMode: .alwaysOriginal).draw(in: rect)
    }
}

/// The shared Gen UI colours, read once from the bundled `genui-theme.json`.
/// Safe from any thread.
enum GenUIColors {
    static let theme: GenUITheme? = Bundle.module.url(forResource: "genui-theme", withExtension: "json")
        .flatMap { try? Data(contentsOf: $0) }.flatMap(GenUITheme.parse)

    /// A tone or raw colour by name; a name the theme doesn't know is `neutral`.
    private static func tone(_ table: KeyPath<GenUITheme, [String: ColorToken]>, _ tone: GenUITone) -> ColorToken {
        let colours = theme?[keyPath: table]
        return colours?[tone.name] ?? colours?["neutral"] ?? Palette.textSecondary
    }

    /// Whether `tone` names a colour other than `neutral`, so text in it
    /// leaves its role's colour.
    static func tints(_ tone: GenUITone) -> Bool {
        tone != .neutral && theme?.ink[tone.name] != nil
    }

    static func ink(_ tone: GenUITone) -> ColorToken { self.tone(\.ink, tone) }
    static func text(_ tone: GenUITone) -> ColorToken { self.tone(\.text, tone) }
    static func fill(_ tone: GenUITone) -> ColorToken { self.tone(\.fill, tone) }
    static func series(_ index: Int) -> ColorToken { theme?.series(index) ?? Palette.textSecondary }
    static var muted: ColorToken { theme?.muted ?? Palette.textSecondary }
    static var grid: ColorToken { theme?.grid ?? Palette.divider }
    static var axisLabel: ColorToken { theme?.axisLabel ?? Palette.textSecondary }

    /// A step marker's tone for `status`, as the theme maps it.
    static func marker(_ status: String) -> GenUITone {
        theme?.markers[status].map(GenUITone.init(name:)) ?? .neutral
    }
}

extension GenUITone {
    /// A glyph, a bar, a sparkline, a marker or a chart mark in this tone.
    var ink: ColorToken { GenUIColors.ink(self) }
    /// Words in this tone, a pill's label included.
    var text: ColorToken { GenUIColors.text(self) }
    /// The ground of a pill or a notice in this tone.
    var fill: ColorToken { GenUIColors.fill(self) }
}
#endif
