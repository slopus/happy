import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The composer: AgentInput.tsx, MultiTextInput.tsx, MobileGlass.tsx's
// frosted material, AgentInputAutocomplete.tsx, AgentInputSuggestionView.tsx
// and AgentInputAttachmentStrip.tsx (iOS values).

extension Palette {
    /// The frosted material's flat tint over its blur (MobileGlass.tsx
    /// `surfaceOverlay`, frosted): rgba(255,255,255,0.82) and
    /// rgba(20,20,22,0.82).
    public static let composerFrostedOverlay = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.82),
        dark: RGBA(red: 20 / 255, green: 20 / 255, blue: 22 / 255, alpha: 0.82)
    )
    /// `mobilePrimaryButtonInactive`: send with nothing to send.
    public static let composerPrimaryInactive = ColorToken("#D1D1D6", "#3A3A3C")
    /// `mobileStopButton`: button.primary.background in light, #F5F5F5 in
    /// dark.
    public static let composerStopFill = ColorToken("#000000", "#F5F5F5")
    /// The stop glyph on it.
    public static let composerStopIcon = ColorToken("#FFFFFF", "#000000")
    /// HomeDock.tsx `sendButtonActive`: send and stop on the new-session
    /// card (button.primary.background in light, #F5F5F5 in dark).
    public static let composerNewSessionPrimaryFill = ColorToken("#000000", "#F5F5F5")
    /// HomeDock.tsx `primaryActionIconColor`: button.primary.tint in light,
    /// #111111 in dark.
    public static let composerNewSessionPrimaryIcon = ColorToken("#FFFFFF", "#111111")
    /// HomeDock.tsx `primaryActionFlash`: the wash over Stop's fill when a
    /// press is refused.
    public static let composerPrimaryFlash = ColorToken("#FFFFFF", "#4A4A4E")
    /// theme.colors.glass.overlay: the suggestion list's fill.
    public static let glassOverlay = ColorToken(
        light: RGBA(red: 245 / 255, green: 245 / 255, blue: 248 / 255, alpha: 0.58),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.72)
    )
    /// theme.colors.glass.shadow: the suggestion list's shadow.
    public static let glassShadow = ColorToken(
        light: RGBA(red: 39 / 255, green: 47 / 255, blue: 54 / 255, alpha: 0.16),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55)
    )
    /// The wide composer's send (`sendButton`): theme.colors.button.primary
    /// `background` with text (`sendButtonActive`), `disabled` without
    /// (`sendButtonInactive`), and its `tint` for the arrow and spinner.
    public static let composerSendFill = ColorToken("#000000")
    public static let composerSendDisabled = ColorToken("#C0C0C0")
    public static let composerSendIcon = ColorToken("#FFFFFF")
    /// LocalBlurHalo's default `dimColor` over its blur, behind the
    /// suggestion list.
    public static let composerHaloDim = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.08),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.10)
    )
    /// theme.colors.radio.inactive.
    public static let radioInactive = ColorToken("#C0C0C0", "#48484A")

    /// useSessionStatus's colours: the same in both appearances.
    public static let sessionStatusDisconnected = ColorToken("#999999")
    public static let sessionStatusAttention = ColorToken("#FF9500")
    public static let sessionStatusThinking = ColorToken("#007AFF")
    public static let sessionStatusOnline = ColorToken("#34C759")

    public static let composer: [ColorToken] = [
        composerFrostedOverlay, composerPrimaryInactive, composerStopFill, composerStopIcon,
        composerNewSessionPrimaryFill, composerNewSessionPrimaryIcon, composerPrimaryFlash, glassOverlay,
        glassShadow, composerSendFill, composerSendDisabled, composerSendIcon, composerHaloDim, radioInactive,
        sessionStatusDisconnected, sessionStatusAttention, sessionStatusThinking, sessionStatusOnline,
    ]
}

/// `unifiedPanelShadow`: black, 0/2 radius 8 at 0.08 in light; 0/6 radius
/// 16 at 0.22 in dark.
public enum ComposerShadow {
    public static let lightOffsetY: CGFloat = 2
    public static let lightRadius: CGFloat = 8
    public static let lightOpacity: Float = 0.08
    public static let darkOffsetY: CGFloat = 6
    public static let darkRadius: CGFloat = 16
    public static let darkOpacity: Float = 0.22
    /// The frosted material's blur: expo-blur `intensity` 92 capped at 42.
    public static let materialFraction: CGFloat = 0.42
}

/// AgentInputAutocomplete's glass: glass.shadow at full opacity, 0/16
/// radius 36; a liquid glass blur (`intensity` 88, 36 without the glass
/// API).
public enum AutocompleteShadow {
    public static let offsetY: CGFloat = 16
    public static let radius: CGFloat = 36
    public static let materialFraction: CGFloat = 0.36
}

/// ContextGaugeIcon: a ring that fills and darkens with the context used.
public enum ContextGauge {
    public static let size: CGFloat = 14
    public static let strokeWidth: CGFloat = 2.5

    /// The ring's alpha at `percent` (0…100): 0.35 empty to 1 full.
    public static func intensity(percent: Double) -> Double {
        0.35 + 0.65 * (min(100, max(0, percent)) / 100)
    }
}

extension TextStyles {
    /// MultiTextInput: 16 / 22, Typography.default().
    public static let composerInput = TextStyle(.regular, size: 16, lineHeight: 22)
    /// `mobileModeText` and `mobileModeSeparator`.
    public static let composerChip = TextStyle(.regular, size: 14)
    /// The status and usage rows.
    public static let composerStatus = TextStyle(.regular, size: 11)
    /// AgentInputSuggestionView.
    public static let suggestionCommand = TextStyle(.semiBold, size: 14)
    public static let suggestionDescription = TextStyle(.regular, size: 13)
    public static let suggestionFile = TextStyle(.regular, size: 14)
    public static let suggestionLabel = TextStyle(.regular, size: 12)
}
