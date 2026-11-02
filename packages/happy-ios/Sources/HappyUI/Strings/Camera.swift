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
    }
}
