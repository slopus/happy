import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Home: MainView.tsx's phone header over navigation/Header.tsx,
// MobileGlass.tsx and MobileHeaderScrim.tsx, HomeHeaderTitle.tsx, the
// project list and the dock (iOS values).

extension Palette {
    /// The glass controls' 1pt rim (Header.tsx `leftControlGlass` /
    /// `rightControlGlass`): white in light, rgba(255,255,255,0.18) in dark.
    public static let headerGlassBorder = ColorToken(
        light: RGBA.white,
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.18)
    )
    /// The flat tint over the static material's blur (MobileGlass.tsx
    /// `surfaceOverlay`, static): rgba(0,0,0,0.024) and rgba(44,44,47,0.40).
    public static let headerGlassOverlay = ColorToken(
        light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.024),
        dark: RGBA(red: 44 / 255, green: 44 / 255, blue: 47 / 255, alpha: 0.40)
    )
}

/// The glass controls' drop shadow (Header.tsx): black, 0/4 offset, radius
/// 20, at 0.06 in light and 0.24 in dark.
public enum HeaderGlassShadow {
    public static let offsetY: CGFloat = 4
    public static let radius: CGFloat = 20
    public static let lightOpacity: Float = 0.06
    public static let darkOpacity: Float = 0.24
    /// expo-blur's `intensity` for the static material, capped at 44
    /// (`STATIC_MATERIAL_BLUR_CAP`); expo-blur runs the effect to
    /// `intensity / 100`.
    public static let materialFraction: CGFloat = 0.44
}

/// Where content scrolls under chrome, as Telegram's chats list treats
/// its two edges (measured from its screen, iOS 26). Both fade to the
/// screen's own ground, never another colour, so with nothing under them
/// they are that ground.
///
/// The header's edge: content goes almost wholly into the ground under the
/// status bar and the controls (0.94), with a light blur, and comes back
/// over the last 36pt (Telegram: 0.88 at 27 from the end, 0.45 at 10).
/// The foot's: no blur, content legible behind the composer's glass, and
/// only a light fade into the ground at the screen's foot (Telegram: 0.5
/// at its last 20pt).
public enum HeaderScrim {
    public static let featherSteps = 24
    public static let rampPoints: CGFloat = 36
    public static let fallbackFeatherStart: CGFloat = 0.60
    /// The header's fade where it holds.
    public static let topPeak: Double = 0.94
    /// The header's blur radius where it holds: softens, never smears.
    public static let topBlurRadius: CGFloat = 2
    /// The foot's fade at the screen's foot, from none at the scrim's top.
    public static let footPeak: Double = 0.55
    /// How the foot's fade grows towards the foot: `t^footCurve`.
    public static let footCurve: Double = 1.67

    public struct Stop: Equatable, Sendable {
        public var location: Double
        /// How much of the fade (or the blur) shows, 0 to 1.
        public var alpha: Double
    }

    /// How far a list scrolls under a scrim before it is whole: the 8 of
    /// room a list keeps before its chrome, so the scrim is whole by the
    /// time anything meets the chrome's edge.
    public static let presenceRamp: CGFloat = 8

    /// A scrim's strength over a list whose content has gone `scrolledUnder`
    /// past where it rests: none at rest, so what rests there reads whole,
    /// and whole `presenceRamp` on.
    public static func presence(scrolledUnder: CGFloat) -> CGFloat {
        min(1, max(0, scrolledUnder / presenceRamp))
    }

    /// The feather: 25 samples of `1 - p^1.67` after a flat
    /// hold, where `hold` puts the ramp's start `rampPoints` above the
    /// bottom of a scrim `height` tall.
    public static func stops(height: CGFloat) -> [Stop] {
        let hold = height > rampPoints ? Double(1 - rampPoints / height) : Double(fallbackFeatherStart)
        return (0...featherSteps).map { step in
            let t = Double(step) / Double(featherSteps)
            let p = t <= hold ? 0 : (t - hold) / (1 - hold)
            let falloff = 1 - pow(p, 1.67)
            // RN writes `toFixed(4)` into the rgba string.
            return Stop(location: t, alpha: (falloff * 10_000).rounded() / 10_000)
        }
    }

    /// The foot's fade, from the screen's foot (location 0, `footPeak`)
    /// to the scrim's top (1, none).
    public static func footStops() -> [Stop] {
        (0...featherSteps).map { step in
            let t = Double(step) / Double(featherSteps)
            return Stop(location: t, alpha: ((footPeak * pow(1 - t, footCurve)) * 10_000).rounded() / 10_000)
        }
    }
}

extension TextStyles {
    /// HomeHeaderTitle.tsx's socket status: 11pt, weight 500, line height
    /// 16. RN resolves weight 500 within IBM Plex Sans to the nearest face
    /// the app bundles, which is SemiBold (0.3 is nearer 0.23 than 0).
    public static let homeHeaderStatus = TextStyle(.semiBold, size: 11, lineHeight: 16)
}

// The project list (components/ProjectHomeList.tsx). Its pressed highlight
// (`surfacePressed`) and line-change colours (`gitAddedText`,
// `gitRemovedText`) are the chat's tokens in ChatTokens.swift.
extension TextStyles {
    /// A project's name on its card.
    public static let projectName = TextStyle(.regular, size: 17, lineHeight: 22)
    /// A worktree's name under its project.
    public static let worktreeName = TextStyle(.regular, size: 16, lineHeight: 21)
    /// "Show all 7 workspaces" / "Show fewer".
    public static let worktreeToggle = TextStyle(.regular, size: 15, lineHeight: 20)
    /// "BOTS", "PROJECTS" and the archive's days.
    public static let projectSection = TextStyle(.semiBold, size: 11, lineHeight: 14, letterSpacing: 0.6, uppercase: true)
    /// The computer's name over its projects.
    public static let projectMachine = TextStyle(.regular, size: 11, lineHeight: 14)
    /// A bot's or an archived chat's time.
    public static let projectTimestamp = TextStyle(.regular, size: 13, lineHeight: 18)
    /// "≈" ahead of approximate line counts.
    public static let gitApproximate = TextStyle(.regular, size: 11, lineHeight: 18)
    /// "+12" and "-3".
    public static let gitLineCount = TextStyle(.semiBold, size: 13, lineHeight: 18)
}

/// RowPressable's highlight: up in 70ms, gone over 240ms.
public enum RowHighlight {
    public static let fadeIn: Double = 0.07
    public static let fadeOut: Double = 0.24
}

// The dock (components/HomeDock.tsx).
extension Palette {
    // The send button's fill and glyph (`sendButtonActive`,
    // `primaryActionIconColor`) are Composer's
    // `composerNewSessionPrimaryFill` and `composerNewSessionPrimaryIcon`.

    /// The dim over the list while the composer is open
    /// (`focusBackdropDim`): rgba(255,255,255,0.88) and rgba(0,0,0,0.88).
    public static let homeDockBackdropDim = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.88),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.88)
    )

    public static let homeDock: [ColorToken] = [homeDockBackdropDim]
}

/// The open composer's blur: expo-blur `intensity` 8 on the ultra-thin
/// material, as the animator fraction.
public enum HomeDockBackdrop {
    public static let blurFraction: CGFloat = 0.08
}

extension TextStyles {
    /// The resting capsule's prompt or placeholder (`inputEntryText`).
    public static let homeDockEntry = TextStyle(.regular, size: 17)
    /// A picker row's value (`focusConfigValue`).
    public static let homeDockRowValue = TextStyle(.regular, size: 17)
    /// The status line above the composer and its hint.
    public static let homeDockProgress = TextStyle(.regular, size: 11)
    /// What a bot is for, under Session | Bot (`focusHeaderLede`).
    public static let homeDockLede = TextStyle(.regular, size: 13, lineHeight: 18)
    /// "Avatar" over a bot's faces (BotFacePicker.tsx `heading`).
    public static let botFaceHeading = TextStyle(.semiBold, size: 12)
    /// "Art by Lisa Wischofsky" under them.
    public static let botFaceCredit = TextStyle(.regular, size: 11)
}

// The new-session screen (app/(app)/new/index.tsx).
extension Palette {
    /// theme.colors.glass.tint: the composer's liquid glass.
    public static let glassTint = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.14),
        dark: RGBA(red: 16 / 255, green: 16 / 255, blue: 16 / 255, alpha: 0.08)
    )
    /// theme.colors.glass.overlayTint: the picker popover's glass.
    public static let glassOverlayTint = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.46),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.56)
    )
    /// theme.colors.glass.highlight: Send's rim.
    public static let glassHighlight = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.94),
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.22)
    )
    /// LocalBlurHalo's wash over its blur.
    public static let pickerHaloDim = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.08),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.10)
    )

    public static let newSession: [ColorToken] = [glassTint, glassOverlayTint, glassHighlight, pickerHaloDim]
}

/// The new-session screen's materials, shadows and fades.
public enum NewSessionMaterial {
    /// MobileGlassSurface without the glass API: `intensity` 88 capped at
    /// 36 on the ultra-thin material.
    public static let glassFallbackFraction: CGFloat = 0.36
    /// LocalBlurHalo: `intensity` 34.
    public static let haloFraction: CGFloat = 0.34
    /// `mobileComposerShadow`: glass.shadow, 0/10 radius 24, full opacity.
    public static let composerShadowOffsetY: CGFloat = 10
    public static let composerShadowRadius: CGFloat = 24
    /// `nativePopoverSurface`: glass.shadow, 0/12 radius 32.
    public static let popoverShadowOffsetY: CGFloat = 12
    public static let popoverShadowRadius: CGFloat = 32
    /// `configRowPressed`, and BubblePressable's own.
    public static let pressedOpacity: CGFloat = 0.6
    /// The place rows while the computer is offline.
    public static let offlineOpacity: CGFloat = 0.4
    /// An offline computer in the machine picker.
    public static let dimmedOpacity: CGFloat = 0.45
    /// Send while it can't be pressed.
    public static let sendInactiveOpacity: CGFloat = 0.56
}

extension TextStyles {
    /// `configLabel` on a phone.
    public static let newSessionRow = TextStyle(.semiBold, size: 16)
    /// `offlineHelpTitle` and `offlineHelpText`.
    public static let newSessionOfflineTitle = TextStyle(.semiBold, size: 13)
    public static let newSessionOfflineBody = TextStyle(.regular, size: 12, lineHeight: 18)
    /// `composerAgentLabel`.
    public static let newSessionAgent = TextStyle(.semiBold, size: 13)
    /// A picker row (`optionText`) and the line under it.
    public static let newSessionOption = TextStyle(.regular, size: 15)
    public static let newSessionOptionDetail = TextStyle(.regular, size: 13)
    /// `sectionLabel`.
    public static let newSessionSection = TextStyle(.semiBold, size: 13)
    /// `pathMetaText`.
    public static let newSessionMeta = TextStyle(.regular, size: 13)
    /// `emptyText`.
    public static let newSessionEmpty = TextStyle(.regular, size: 14)
    /// A settings row's name, over its value.
    public static let newSessionSettingName = TextStyle(.regular, size: 12)
    /// `composerPickerTitle`.
    public static let newSessionPickerTitle = TextStyle(.semiBold, size: 14)
}
