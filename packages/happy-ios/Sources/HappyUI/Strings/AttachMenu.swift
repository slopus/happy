import Foundation

// The composer's "+" menu, as Telegram's attachment menu says it.
extension Strings {
    public enum AttachMenu {
        public static let gallery = "Gallery"
        public static let files = "Files"
        public static let recents = "Recents"
        public static let camera = "Camera"
        public static let cameraHint = "Take a photo or video"
        /// Telegram's "Select from Files" and "Select from Gallery".
        public static let selectFromFiles = "Select from Files"
        public static let selectPhotos = "Select Photos or Videos"
        /// No library: Telegram's `Attachment_MediaAccessTitle`, then why,
        /// then the system's picker under it.
        public static let accessTitle = "Access Your Photos and Videos"
        public static let accessText = "Allow Happy to see your library to pick photos and videos right here, or choose them one at a time without giving access."
        public static let choosePhotos = "Choose Photos or Videos"
        public static let openSettings = "Allow Access in Settings"
        public static let openCamera = "Open Camera"
        public static func add(_ count: Int) -> String { "Add \(count)" }
    }

    /// A sending picture's or video's ring, as VoiceOver reads it.
    public enum Upload {
        public static let waiting = "waiting to upload"
        public static func uploading(_ percent: Int) -> String { "uploading, \(percent)%" }
        public static let failed = "not sent, double-tap to retry"
        public static let cancel = "Remove from message"
    }
}
