import Foundation

/// The colours every Gen UI client shares (task_375 `genui/theme.json`,
/// bundled as `genui-theme.json`): each tone's ink and fill, and the chart's
/// palette, muted series, grid and axis labels. Surfaces, body text and
/// hairlines are not here; they stay the app's.
public struct GenUITheme: Equatable, Sendable {
    public static let tones = ["neutral", "accent", "success", "warning", "danger", "muted"]

    /// By tone name, then raw colour name (`colors`): icons, bars,
    /// sparklines, markers and chart marks in that colour.
    public var ink: [String: ColorToken]
    /// By the same names: text in that colour, a pill's label included
    /// (the ink, darkened or lightened to 4.5:1 on the card).
    public var text: [String: ColorToken]
    /// By the same names: the ground of a pill or a notice.
    public var fill: [String: ColorToken]
    /// The raw colours' names (`red`, `brown`, ...), sorted.
    public var colors: [String]
    public var palette: [ColorToken]
    public var muted: ColorToken
    public var grid: ColorToken
    public var axisLabel: ColorToken
    /// A step marker's tone by status (`done`, `failed`, `active`, `pending`).
    public var markers: [String: String]
    /// The icon names the shared glyphs cover.
    public var icons: [String]

    /// Nil unless every tone and chart colour is there and well formed.
    public static func parse(_ data: Data) -> GenUITheme? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tones = root["tones"] as? [String: Any], let chart = root["chart"] as? [String: Any] else { return nil }
        var ink: [String: ColorToken] = [:]
        var text: [String: ColorToken] = [:]
        var fill: [String: ColorToken] = [:]
        func read(_ name: String, _ json: Any?) -> Bool {
            guard let tone = json as? [String: Any], let i = color(tone["ink"]), let t = color(tone["text"]), let f = color(tone["fill"]) else { return false }
            ink[name] = i
            text[name] = t
            fill[name] = f
            return true
        }
        for name in Self.tones {
            guard read(name, tones[name]) else { return nil }
        }
        // Raw colours have a tone's shape; a tone keeps its name if both use it.
        var colors: [String] = []
        for (name, value) in root["colors"] as? [String: Any] ?? [:] where ink[name] == nil {
            guard read(name, value) else { return nil }
            colors.append(name)
        }
        let markers = root["markers"] as? [String: String] ?? [:]
        let palette = (chart["palette"] as? [Any] ?? []).compactMap(color)
        guard !palette.isEmpty, palette.count == (chart["palette"] as? [Any])?.count,
              let muted = color(chart["muted"]), let grid = color(chart["grid"]), let axisLabel = color(chart["axisLabel"]) else { return nil }
        let icons = ((root["icons"] as? [String: Any])?["names"] as? [String]) ?? []
        return GenUITheme(
            ink: ink, text: text, fill: fill, colors: colors.sorted(), palette: palette, muted: muted, grid: grid, axisLabel: axisLabel,
            markers: markers, icons: icons
        )
    }

    /// Plot colour `index`, 1-based, wrapping round the palette.
    public func series(_ index: Int) -> ColorToken {
        let count = palette.count
        return palette[((index - 1) % count + count) % count]
    }

    private static func color(_ json: Any?) -> ColorToken? {
        guard let pair = json as? [String: Any], let light = (pair["light"] as? String).flatMap(RGBA.init(hex:)),
              let dark = (pair["dark"] as? String).flatMap(RGBA.init(hex:)) else { return nil }
        return ColorToken(light: light, dark: dark)
    }
}
