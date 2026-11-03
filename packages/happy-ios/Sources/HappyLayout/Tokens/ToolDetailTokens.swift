import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// A Happy Agent tool call's own screen: grouped cards on the settings
// ground, in desktop's UI face, the terminal and code in mono.

extension Palette {
    /// A status pill's wash and ink, by how the call stands.
    public static let toolRunningPill = ColorToken("#E8F1FD", "#1B2A3D")
    public static let toolRunningInk = ColorToken("#1D6FD6", "#6AA8F7")
    public static let toolDonePill = ColorToken("#E6F6EA", "#16301D")
    public static let toolDoneInk = ColorToken("#1E8E3E", "#4CD964")
    public static let toolFailedPill = ColorToken("#FDE8E7", "#3A1A18")
    public static let toolFailedInk = ColorToken("#C5221F", "#FF6B61")
    /// The header's glyph tile.
    public static let toolTile = ColorToken("#F0F0F2", "#2C2C2E")
    /// A code block's ground inside a card.
    public static let toolCode = ColorToken("#F6F6F8", "#141416")
    public static let toolSeparator = ColorToken("#E2E2E6", "#38383A")
}

extension ChatTextStyles {
    public static let toolDetailKind = ChatTextStyle(.figtree(.semibold), size: 17, lineHeight: 22)
    public static let toolDetailName = ChatTextStyle(.figtree(.regular), size: 13, lineHeight: 18)
    public static let toolDetailStatus = ChatTextStyle(.figtree(.medium), size: 12, lineHeight: 16)
    public static let toolDetailSection = ChatTextStyle(.figtree(.semibold), size: 12, lineHeight: 16, letterSpacing: 0.4, uppercase: true)
    public static let toolDetailLabel = ChatTextStyle(.figtree(.regular), size: 15, lineHeight: 20)
    public static let toolDetailValue = ChatTextStyle(.figtree(.regular), size: 15, lineHeight: 20)
    public static let toolDetailMono = ChatTextStyle(.plex(.mono), size: 13, lineHeight: 19)
    public static let toolDetailBody = ChatTextStyle(.figtree(.regular), size: 15, lineHeight: 22)
    public static let toolDetailNote = ChatTextStyle(.figtree(.regular), size: 13, lineHeight: 18)
}

/// Where the screen's sections sit: 16 apart, a heading 6 over its card.
public enum ToolDetailMetrics {
    public static let sectionGap: CGFloat = 20
    public static let headingGap: CGFloat = 6
    public static let headingInset: CGFloat = 14
    public static let codePadding: CGFloat = 12
    public static let codeRadius: CGFloat = 10
    public static let rowGlyph: CGFloat = 16
}
