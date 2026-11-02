import Foundation
import HappyCore

// Where an empty chat's first send goes: whether each computer answers, and
// what to do when the chosen one doesn't. happy-app's dock says nothing
// before Send ("Machine is offline" comes back as an error after), so these
// are this app's own, in English in every language as the bot and task
// words are; "online" and "last seen" are happy-app's.
extension Strings {
    public enum ComposeTarget {
        /// The computer's row, and each computer in its menu.
        public static func status(_ target: MachineTarget, for kind: HomeDockKind, now: Int64) -> String {
            guard let at = target.lastSeen(for: kind) else {
                return target.isOnline(for: kind) ? Strings.Status.online : Strings.Status.offline
            }
            return Strings.Composer.lastSeen(lastSeen(ComposerStatus.lastSeen(activeAt: at, now: now)))
        }

        /// The computer row's chip: a dot and a word or two.
        public static func label(_ target: MachineTarget, offline: NewSessionChoices.Offline?, now: Int64) -> String {
            switch offline {
            case nil: return "● Online"
            case .computer(let at): return "● Offline · " + compact(ComposerStatus.lastSeen(activeAt: at, now: now))
            case .happyAgent: return "● Agent offline"
            case .happyCLI: return "● CLI offline"
            }
        }

        /// "now", "5m", "2h", "3d", or the date.
        static func compact(_ lastSeen: ComposerStatus.LastSeen) -> String {
            switch lastSeen {
            case .justNow: return "now"
            case .minutes(let count): return "\(count)m"
            case .hours(let count): return "\(count)h"
            case .days(let count): return "\(count)d"
            case .date: return Self.lastSeen(lastSeen)
            }
        }

        /// The computer row while the account's computers are still
        /// arriving, and its chip.
        public static let loading = "Loading computers…"
        public static let loadingStatus = "● …"
        /// Send pressed before they are in.
        public static let stillLoading = "Your computers are still loading. Try again in a moment."

        /// The whole of it, at the head of the computer menu and when Send
        /// is pressed.
        public static func offline(_ offline: NewSessionChoices.Offline) -> String {
            switch offline {
            case .computer: "This computer is offline. Start Happy on it or pick another."
            case .happyAgent: "Happy Agent on this computer is offline. Start it or pick another computer."
            case .happyCLI: "Happy CLI on this computer is offline. Run `happy daemon start` there or pick another computer."
            }
        }

        /// The computer menu's heading while a bot or a task is made: only
        /// computers whose Happy Agent makes it are listed.
        public static func machinesTitle(_ kind: HomeDockKind) -> String {
            switch kind {
            case .session: Strings.Home.machineTitle
            case .bot: "Computers whose Happy Agent makes bots"
            case .task: "Computers whose Happy Agent makes tasks"
            }
        }

        /// `formatLastSeen`'s time, as the composer's status words it.
        static func lastSeen(_ lastSeen: ComposerStatus.LastSeen) -> String {
            switch lastSeen {
            case .justNow: return Strings.Composer.justNow
            case .minutes(let count): return Strings.Composer.minutesAgo(count)
            case .hours(let count): return Strings.Composer.hoursAgo(count)
            case .days(let count): return Strings.Composer.daysAgo(count)
            case .date(let ms):
                let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
                let formatter = DateFormatter()
                let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
                formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
                return formatter.string(from: date)
            }
        }
    }
}
