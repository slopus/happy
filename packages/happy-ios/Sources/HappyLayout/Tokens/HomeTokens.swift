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
    /// The colour the home scrim fades from (MobileHeaderScrim.tsx): white
    /// in light, black in dark. Its alpha comes from `HeaderScrim`.
    public static let headerScrimTint = ColorToken(light: RGBA.white, dark: RGBA.black)
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

/// MobileHeaderScrim.tsx: one dim gradient behind the floating controls,
/// full strength at the screen edge and falling to nothing over the last
/// 36pt. The home variant uses the strong peak at full overlay opacity.
public enum HeaderScrim {
    public static let featherSteps = 24
    public static let rampPoints: CGFloat = 36
    public static let fallbackFeatherStart: CGFloat = 0.60
    public static let strongPeakLight: Double = 0.76
    public static let strongPeakDark: Double = 0.55
    /// expo-blur `intensity` 8, as the animator fraction.
    public static let edgeBlurFraction: CGFloat = 0.08

    public struct Stop: Equatable, Sendable {
        public var location: Double
        /// Multiplies the peak alpha.
        public var alpha: Double
    }

    /// `feather(rgb, peak, hold)`: 25 samples of `1 - p^1.67` after a flat
    /// hold, where `hold` puts the ramp's start `rampPoints` above the
    /// bottom of a scrim `height` tall.
    public static func stops(height: CGFloat, peak: Double) -> [Stop] {
        let hold = height > rampPoints ? Double(1 - rampPoints / height) : Double(fallbackFeatherStart)
        return (0...featherSteps).map { step in
            let t = Double(step) / Double(featherSteps)
            let p = t <= hold ? 0 : (t - hold) / (1 - hold)
            let falloff = 1 - pow(p, 1.67)
            // RN writes `toFixed(4)` into the rgba string.
            return Stop(location: t, alpha: ((peak * falloff) * 10_000).rounded() / 10_000)
        }
    }
}

extension TextStyles {
    /// HomeHeaderTitle.tsx's socket status: 11pt, weight 500, line height
    /// 16. RN resolves weight 500 within IBM Plex Sans to the nearest face
    /// the app bundles, which is SemiBold (0.3 is nearer 0.23 than 0).
    public static let homeHeaderStatus = TextStyle(.semiBold, size: 11, lineHeight: 16)
}
