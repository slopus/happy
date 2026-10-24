import Foundation

// Stories, spelled as happy-agent's API.md "Stories" and "Stickers" name
// them, and as Telegram's stories say the rest. English only, as desktop is.
extension Strings {
    public enum Stories {
        // The row.
        public static let myStory = "My Story"
        public static func author(_ name: String, unseen: Int) -> String {
            unseen > 0 ? "\(name), \(unseen) new" : name
        }
        public static let addStory = "Add story"

        // Settings.
        public static let setting = "Stories"
        public static let settingDetail = "Experimental. Share what your work looks like in a row of circles above the sidebar."

        // The viewer.
        public static let close = "Close"
        public static let photoUnavailable = "This photo is no longer available"
        public static let videoUnavailable = "This video is no longer available"
        public static let open = "Open"
        public static let cancel = "Cancel"
        public static let copyLink = "Copy link"
        public static let delete = "Delete"
        public static let deleteStory = "Delete story?"
        public static let deleteDetail = "This story will be removed for everyone."
        public static let deleteFailed = "Couldn't delete the story"
        public static let openConversation = "Open conversation"
        public static let viewers = "Viewers"
        public static let noViewers = "No views yet"
        public static func views(_ count: Int) -> String { count == 1 ? "1 view" : "\(count) views" }
        public static let react = "React"
        public static let heart = "❤️"
        public static let reactions = ["❤️", "👍", "🔥", "🎉", "😂", "😮", "😢", "👏"]
        public static func ago(_ milliseconds: Int64) -> String {
            let minutes = max(0, milliseconds / 60_000)
            if minutes < 1 { return "just now" }
            if minutes < 60 { return "\(minutes)m ago" }
            return "\(minutes / 60)h ago"
        }

        // The inline story.
        public static let post = "Post"
        public static let edit = "Edit"
        public static let draft = "Draft"
        public static let posted = "Posted"
        public static let deleted = "This story was deleted"
        public static let unavailable = "This story isn't available"
        public static let postFailed = "Couldn't post"
        public static let newerVersion = "The story changed. Check it and post again."

        // The editor.
        public static let newStory = "New Story"
        public static let drafts = "Drafts"
        public static let photos = "Photos"
        public static let camera = "Camera"
        public static let fromConversations = "From conversations"
        public static let text = "Text"
        public static let link = "Link"
        public static let stickers = "Stickers"
        public static let emoji = "Emoji"
        public static let reaction = "Reaction"
        public static let caption = "Add a caption…"
        public static let save = "Save"
        public static let done = "Done"
        public static let linkURL = "URL"
        public static let linkLabel = "Name (optional)"
        public static let invalidLink = "Enter an http or https link."
        public static let uploading = "Uploading…"
        public static let saveFailed = "Couldn't save the story"
        public static let addFrame = "Add"
        public static let noMedia = "Nothing to choose from yet"

        // The sticker picker.
        public static let search = "Search"
        public static let recentlyUsed = "Recently used"
        public static let clearRecents = "Clear recently used"
        public static let noResults = "No stickers found"
    }
}
