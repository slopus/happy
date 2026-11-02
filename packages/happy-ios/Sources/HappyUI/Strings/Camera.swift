import Foundation

// The camera's own copy: happy-app hands photos and QR codes to the
// system's camera and scanner, so there is nothing of its to copy. The
// words follow the system camera's.
extension Strings {
    public enum Camera {
        /// Why the picture stopped (`AVCaptureSession.InterruptionReason`).
        public static let inUse = "The camera is in use by another app."
        public static let multitasking = "The camera isn't available while other apps are on screen."
        public static let systemPressure = "The camera is paused while the device cools down."
        public static let audio = "The camera is paused during the call."
        public static let restricted = "The camera is restricted on this device."
        public static let denied = "Allow Happy to use the camera in Settings to take photos and videos."
        public static let noCamera = "This device has no camera."
        public static let openSettings = "Open Settings"

        // The buttons, as VoiceOver reads them.
        public static let close = "Close"
        public static let shutter = "Take Photo"
        public static let flip = "Switch Camera"
        public static let flash = "Flash"
        public static let flashAuto = "Auto"
        public static let timer = "Timer"
        public static func timerSeconds(_ seconds: Int) -> String { "\(seconds)s" }
        public static let aspect = "Aspect Ratio"
        public static let grid = "Grid"
        public static let on = "On"
        public static let off = "Off"
        public static func lens(_ label: String) -> String { "\(label) zoom" }
        public static let preview = "Viewfinder"
        public static let previewHint = "Tap to focus. Touch and hold to lock focus and exposure."

        /// The long press's hold.
        public static let locked = "AE/AF Lock"

        // The review.
        public static let retake = "Retake"
        public static let usePhoto = "Use Photo"
        public static let photo = "Photo"
    }
}
