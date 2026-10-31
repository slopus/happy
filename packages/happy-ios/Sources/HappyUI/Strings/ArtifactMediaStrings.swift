import Foundation

// Artifacts have no screen in happy-app; these are this app's own, in
// the words its other artifact strings use (`Strings.artifactKind`).
extension Strings {
    public enum ArtifactMedia {
        /// The viewer's share button, for VoiceOver.
        public static let share = "Share"

        /// What a grid of pictures and recordings holds: "4 images",
        /// "3 images, 1 video".
        public static func count(images: Int, videos: Int) -> String {
            var parts: [String] = []
            if images > 0 { parts.append(images == 1 ? "1 image" : "\(images) images") }
            if videos > 0 { parts.append(videos == 1 ? "1 video" : "\(videos) videos") }
            return parts.joined(separator: ", ")
        }

        /// A recording's length, as its pill shows it: "0:07", "12:30", "1:02:03".
        public static func duration(_ seconds: Double) -> String {
            let total = max(0, Int(seconds.rounded()))
            let (hours, minutes, rest) = (total / 3600, total / 60 % 60, total % 60)
            return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
        }

        /// A file of the artifact that this phone can't open here.
        public static let fileUnavailable = "This file couldn’t be opened."
    }
}
