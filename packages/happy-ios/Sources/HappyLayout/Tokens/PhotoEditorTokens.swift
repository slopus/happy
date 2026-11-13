import Foundation

// The "+" menu's photo editor in Telegram's colours (`TGPhotoCropView`,
// `MediaPickerPhotoToolbarView`, `DrawingScreen`, `ColorPickerScreen`): it
// is dark in either appearance, as Telegram's is.

extension Palette {
    /// A tool's icon once its edit is applied (`accentColor`, #FFD300).
    public static let photoEditorApplied = ColorToken("#FFD300")
    /// The editor's glyphs and titles.
    public static let photoEditorControl = ColorToken("#FFFFFF")
    /// Over the picture outside the crop (`TGPhotoCropView`'s dim views).
    public static let photoEditorDim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45))
    /// The straightening wheel's ticks, the crop's grid while it turns.
    public static let photoEditorWheel = ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.9), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.9))
    public static let photoEditorMinorGrid = ColorToken(light: RGBA(red: 0.933, green: 0.933, blue: 0.933, alpha: 0.7), dark: RGBA(red: 0.933, green: 0.933, blue: 0.933, alpha: 0.7))
    /// The size wedge's panel (`TextSizeSliderComponent`: #888888 at 30%).
    public static let photoEditorWedge = ColorToken(light: RGBA(red: 0.533, green: 0.533, blue: 0.533, alpha: 0.3), dark: RGBA(red: 0.533, green: 0.533, blue: 0.533, alpha: 0.3))
    /// The brush's size shown while it changes (`DrawingView`'s preview).
    public static let photoEditorBrushRing = ColorToken("#919191")
    /// The shades behind the top and bottom controls (`BlurredGradientComponent`).
    public static let photoEditorShade = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.35), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.35))
    /// The colour sheet's captions, its fields and its rule.
    public static let photoEditorCaption = ColorToken("#9B9DA5")
    public static let photoEditorField = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.6), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.6))
    public static let photoEditorRule = ColorToken("#48484A")
    /// A light square's selection in the colour grid, and the knobs.
    public static let photoEditorKnob = ColorToken("#1A1A1C")
    /// The eyedropper's inner ring over a very light colour.
    public static let photoEditorLoupeLight = ColorToken("#999999")
}
