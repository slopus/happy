import Foundation
import HappyCore

// happy-app has no Feed, so en.ts has none of these words. They follow
// Happy Desktop's Feed page (`HappyAgentFeedPage`) and are this app's own
// in every language (`FeedWords`, `TranslationCatalog.feedSources`).
// "Feed" names the row and the screen, as "Artifacts" and "Todos" do.
extension Strings {
    enum Feed {
        static let title = "Feed"

        /// The screens' words, for the main thread; a derivation takes its
        /// own copy in its input.
        @MainActor static var words: FeedWords { FeedWords(catalog: AppLocalization.screens) }

        /// The home row's count, for VoiceOver.
        @MainActor static func unreadCount(_ count: Int) -> String { words.unread(count) }
    }
}
