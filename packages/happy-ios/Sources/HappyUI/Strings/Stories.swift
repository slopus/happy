import Foundation
import HappyCore

// Stories, spelled as happy-agent's API.md "Stories" and "Stickers" name
// them, and as Telegram's stories say the rest. English only, as desktop is.
extension Strings {
    public enum Stories {
        // The row.
        public static let myStory = "My Story"
        public static func author(_ name: String, unseen: Int) -> String {
            unseen > 0 ? "\(name), \(unseen) new" : name
        }
        /// The avatars closed into the header's title.
        public static func collapsed(_ names: [String]) -> String {
            names.isEmpty ? "Stories" : "Stories: \(names.joined(separator: ", "))"
        }
        /// The one-time tooltip under them (ChatList.StoryFeedTooltipUsers),
        /// naming up to three: "Ana", "Ana and Steve", "Ana, Steve, and Bo".
        public static func tooltip(_ names: [String]) -> String {
            let list = ListFormatter()
            list.locale = Locale(identifier: "en_US")
            return "Tap above to view stories from \(list.string(from: names) ?? names.joined(separator: ", "))"
        }

        // Settings.
        public static let setting = "Stories"
        public static let settingDetail = "Experimental. Share what your work looks like in a row of circles in the header."

        // The viewer.
        public static let close = "Close"
        /// What ends a folded caption (Telegram's Story.CaptionShowMore).
        public static let captionShowMore = "Show more"
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
        /// A recording's sound (Telegram's Story.TooltipVideoHasNoSound).
        public static let mute = "Mute"
        public static let unmute = "Unmute"
        public static let videoHasNoSound = "This video has no sound"
        public static let heart = "❤️"
        public static let reactions = ["❤️", "👍", "🔥", "🎉", "😂", "😮", "😢", "👏"]
        public static func ago(_ milliseconds: Int64) -> String {
            let minutes = max(0, milliseconds / 60_000)
            if minutes < 1 { return "just now" }
            if minutes < 60 { return "\(minutes)m ago" }
            return "\(minutes / 60)h ago"
        }
        /// When something happened, both in epoch milliseconds: how long
        /// ago within a day, then "yesterday at" its time as Telegram's
        /// list says, then the date.
        public static func when(_ milliseconds: Int64, now: Int64, calendar: Calendar = .current) -> String {
            if now - milliseconds < 86_400_000 { return ago(now - milliseconds) }
            let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
            var style = Date.FormatStyle.dateTime
            style.timeZone = calendar.timeZone
            style.locale = Locale(identifier: "en_US")
            if let yesterday = calendar.date(byAdding: .day, value: -1, to: Date(timeIntervalSince1970: TimeInterval(now) / 1000)),
               calendar.isDate(date, inSameDayAs: yesterday) {
                return "yesterday at \(date.formatted(style.hour().minute()))"
            }
            return date.formatted(style.month(.abbreviated).day())
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
        /// The library sheet's button: "Add", "Add 2".
        public static let add = "Add"
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
        public static let addFrame = "Add frame"
        public static let discardChanges = "Discard changes?"
        public static let discardDetail = "Your edits to this story will be lost."
        public static let discard = "Discard"
        public static let saveDraft = "Save draft"
        public static let keepEditing = "Keep editing"
        public static let deleteFrame = "Delete frame"
        public static let saving = "Saving…"
        public static let couldntOpen = "Couldn't open that photo or video"
        public static let fill = "Fill"
        public static let align = "Alignment"
        public static let trash = "Delete"
        public static let color = "Color"
        public static let font = "Font"
        public static let textSize = "Text size"
        public static let frames = "Frames"
        public static let useLatest = "Use the newer version"
        public static let overwrite = "Keep my edits"
        public static let newerVersionDetail = "It was saved somewhere else since you opened it."
        public static func fontName(_ font: StoryTextFont) -> String {
            switch font {
            case .sanFrancisco: "San Francisco"
            case .typewriter: "Typewriter"
            case .avenirNext: "Avenir Next"
            case .courierNew: "Courier New"
            case .noteworthy: "Noteworthy"
            case .georgia: "Georgia"
            case .papyrus: "Papyrus"
            case .snellRoundhand: "Snell Roundhand"
            }
        }

        // The sticker picker.
        public static let search = "Search"
        public static let recentlyUsed = "Recently used"
        public static let clearRecents = "Clear recently used"
        public static let noResults = "No stickers found"
        public static let emojiPeople = "Smileys & People"
        public static let emojiNature = "Animals & Nature"
        public static let emojiFood = "Food & Drink"
        public static let emojiActivity = "Activity"
        public static let emojiTravel = "Travel & Places"
        public static let emojiObjects = "Objects"
        public static let emojiSymbols = "Symbols"
        public static let emojiFlags = "Flags"

        // Agents' stories (sidebar v2, API.md "Agent stories").
        public static func newStories(_ count: Int) -> String { count == 1 ? "1 new story" : "\(count) new stories" }
        public static let waitingOnYou = "Waiting on you"
        public static let watchStory = "Watch story"
        public static let feedbackPlaceholder = "Tell the agent what to change\u{2026}"
        public static let feedbackSent = "Sent"
        public static let feedbackFailed = "Couldn't send. Try again."
        public static let send = "Send"
        public static let repost = "Repost"
        public static let repostFailed = "Couldn't repost this story"
        public static func repostedFrom(_ title: String?) -> String { "Reposted from " + ((title?.isEmpty ?? true) ? "an agent" : title!) }
        public static let pageUnavailable = "This page is no longer available"
        public static let roundVideo = "Round video"
        public static let roundVideoHint = "Hold to record a round video, tap to lock"
        public static let flipCamera = "Flip camera"
        public static let stopRecording = "Stop"
        public static let cameraDenied = "Allow camera access in Settings to record a round video."
    }
}
