#if canImport(UIKit)
import HappyCore
import UIKit

/// Opens the full-screen viewer on an author of the row.
@MainActor
enum StoriesViewerPresenter {
    static func present(session: StoriesSession, feed: StoryFeed, authorIndex: Int, from host: UIViewController, origin: UIView?) {
        _ = (session, feed, authorIndex, host, origin)
    }
}

/// Opens the editor on a new draft, or on `draft`.
@MainActor
enum StoriesEditorPresenter {
    static func present(session: StoriesSession, draft: Story?, from host: UIViewController) {
        _ = (session, draft, host)
    }
}
#endif
