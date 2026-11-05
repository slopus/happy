import Foundation

// An artifact that asks to run as an app (`ArtifactPageMode`) has no screen
// in happy-app; these are the words the shared app-mode contract gives it.
extension Strings {
    enum ArtifactApp {
        /// Its kind on its card, where a page says "Web page".
        static let kind = "App"
        static let open = "Open"
        /// The full-screen app's one way out, as VoiceOver reads it.
        static let close = "Close"
    }
}
