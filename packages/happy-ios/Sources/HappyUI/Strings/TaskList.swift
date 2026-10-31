import Foundation

// Rich tasks' words, as the desktop's proposal has them (task_174 mock v3).
// happy-app has no tasks, so en.ts has none of these; they stay English, as
// the tasks' other words do.
extension Strings {
    enum TaskList {
        /// Under a card's sub-rows, or in its corner when every child is hidden.
        static func more(_ count: Int) -> String { "+\(count) more" }
        /// Under an opened-out card's sub-rows: back to three.
        static let hide = "hide"
        static let merged = "merged"
    }
}
