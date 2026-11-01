import Foundation

// Stories are English only while they're an experiment behind their setting.
extension Strings {
    public enum Stories {
        public static let you = "You"
        public static let someone = "Someone"
        public static func replyTo(_ name: String) -> String { "Reply to \(name)…" }
        public static func viewAll(_ count: Int) -> String { count == 1 ? "View 1 reply" : "View all \(count) replies" }
        public static func repostedFrom(_ name: String) -> String { "Reposted from \(name)" }
        public static let repost = "Repost"
        public static let delete = "Delete"
        public static let post = "Post"
        public static let cancel = "Cancel"
        public static let record = "Record"
        public static let stop = "Stop"
        public static let caption = "Add a caption…"
        public static let failed = "Couldn’t do that. Try again."
        /// How long ago, as a story's header says it: "5m", "3h".
        public static func age(_ ms: Double, now: Date) -> String {
            let minutes = max(0, Int(now.timeIntervalSince1970 - ms / 1000) / 60)
            return minutes < 1 ? "now" : minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h"
        }
    }
}
