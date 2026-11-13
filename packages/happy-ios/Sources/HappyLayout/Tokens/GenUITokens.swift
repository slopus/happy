import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Gen UI render documents (task_375 genui/RENDER.md) in the agents' chat: desktop's faces
// and colour roles (DESIGN.md §5–§9), at phone sizes. A card is the chat's
// result card (`cardFill` ringed in `divider`); everything inside it is
// separated by space, hairlines and type, never by more boxes.

// Tone and chart colours are not here: they are shared with desktop and
// Android (`GenUITheme`, from the bundled `genui-theme.json`). These are the
// app's own text and surface colours inside a card.
extension Palette {
    /// Metadata and axis ticks (`--color-text-tertiary`).
    public static let genuiTertiary = ColorToken("#807d84", "#97939c")
    /// A code block's well (`--happy-code-background`).
    public static let genuiCode = ColorToken("#f6f8fa", "#161b22")
}

extension ChatTextStyles {
    /// A card's title and subtitle.
    public static let genuiCardTitle = ChatTextStyle(.figtree(.semibold), size: 16, lineHeight: 22)
    public static let genuiCardSubtitle = ChatTextStyle(.figtree(.regular), size: 13, lineHeight: 18)
    /// A section's small heading (DESIGN.md "Section label").
    public static let genuiSection = ChatTextStyle(.figtree(.semibold), size: 13, lineHeight: 18)
    /// Text in a card; the chat's own 16/24 where the document is bare.
    public static let genuiBody = ChatTextStyle(.figtree(.regular), size: 15, lineHeight: 22)
    public static let genuiTitle = ChatTextStyle(.figtree(.semibold), size: 17, lineHeight: 24)
    public static let genuiCaption = ChatTextStyle(.figtree(.regular), size: 13, lineHeight: 18)
    /// A stat's number and its delta.
    public static let genuiStatValue = ChatTextStyle(.figtree(.semibold), size: 24, lineHeight: 30)
    public static let genuiDelta = ChatTextStyle(.figtree(.medium), size: 13, lineHeight: 18)
    /// A list row's title and the strong half of a label/value pair.
    public static let genuiRowTitle = ChatTextStyle(.figtree(.medium), size: 15, lineHeight: 20)
    public static let genuiValue = ChatTextStyle(.figtree(.medium), size: 15, lineHeight: 20)
    /// A label beside or above its value, and a table cell.
    public static let genuiLabel = ChatTextStyle(.figtree(.regular), size: 14, lineHeight: 20)
    public static let genuiCell = ChatTextStyle(.figtree(.regular), size: 15, lineHeight: 20)
    public static let genuiBadge = ChatTextStyle(.figtree(.medium), size: 12, lineHeight: 16)
    /// Chart ticks, table heads, a stacked row's labels.
    public static let genuiMicro = ChatTextStyle(.figtree(.medium), size: 11, lineHeight: 14)
    public static let genuiAxis = ChatTextStyle(.figtree(.regular), size: 11, lineHeight: 14)
    public static let genuiButton = ChatTextStyle(.figtree(.semibold), size: 15, lineHeight: 20)
    public static let genuiDonutTotal = ChatTextStyle(.figtree(.semibold), size: 22, lineHeight: 28)
}
