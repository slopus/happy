import Foundation

// The full camera, dark in both appearances as every camera is: Telegram's
// controls (`CaptureControlsComponent`, `ZoomComponent`) over the system
// camera's yellow for what is chosen or held.

extension Palette {
    /// Behind the picture and the controls.
    public static let cameraGround = ColorToken("#000000")
    /// The buttons' glyphs and words.
    public static let cameraControl = ColorToken("#FFFFFF")
    /// The chosen lens, a flash that will fire, a lock: Telegram's
    /// `ZoomComponent` yellow.
    public static let cameraActive = ColorToken("#FFD300")
    /// A lens button's disc and the capsule behind them.
    public static let cameraLens = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3))
    public static let cameraLensBar = ColorToken(light: RGBA(red: 0.133, green: 0.133, blue: 0.133, alpha: 0.3), dark: RGBA(red: 0.133, green: 0.133, blue: 0.133, alpha: 0.3))
    /// The picture outside the photo's shape (a square's top and bottom).
    public static let cameraOutsideCrop = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.6), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.6))
    /// The focus square, the exposure slider and the lock's banner.
    public static let cameraFocus = ColorToken("#FFD60A")
    public static let cameraBannerText = ColorToken("#000000")
    /// The grid's lines.
    public static let cameraGrid = ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.35), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.35))
    /// The shutter's ring and disc.
    public static let cameraShutter = ColorToken("#FFFFFF")
    /// The screen lit for a front shot without a flash of its own.
    public static let cameraScreenFlash = ColorToken("#FFFFFF")
}

extension TextStyles {
    /// A lens button's number (Telegram: 13, semibold).
    public static let cameraLens = TextStyle(.semiBold, size: 13, maxScale: 1)
    /// A top button's word ("4:3") and the lock's banner.
    public static let cameraButton = TextStyle(.semiBold, size: 13, maxScale: 1)
    public static let cameraBanner = TextStyle(.semiBold, size: 13, letterSpacing: 0.5, uppercase: true, maxScale: 1)
    /// The timer's count, over the picture.
    public static let cameraCountdown = TextStyle(.regular, size: 120, maxScale: 1)
    /// Retake and Use Photo.
    public static let cameraReview = TextStyle(.regular, size: 17)
    /// Why there is no picture.
    public static let cameraMessage = TextStyle(.regular, size: 17, lineHeight: 22)
}
