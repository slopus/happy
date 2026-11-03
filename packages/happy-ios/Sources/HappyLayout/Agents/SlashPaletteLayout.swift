import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The agent chat's slash palette: the composer's suggestion list
/// (`ComposerSuggestionListLayout`), as wide as the card and 8 above it,
/// its rows' height up to 320, never reaching above `top`.
public enum SlashPaletteLayout {
    public static let gap: CGFloat = AgentInputLayout.Metrics.autocompleteMarginBottom

    public static func frame(card: CGRect, rows: Int, border: CGFloat, top: CGFloat) -> CGRect {
        let bottom = card.minY - gap
        let list = CGFloat(max(0, rows)) * ComposerSuggestionRowLayout.Metrics.height + 2 * max(0, border)
        let height = max(0, min(AgentInputLayout.Metrics.autocompleteMaxHeight, list, bottom - top))
        return CGRect(x: card.minX, y: bottom - height, width: card.width, height: height)
    }
}
