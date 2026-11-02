import Foundation
import HappyCore

extension Strings {
    /// The agent composer's slash commands: what a row says of a command's
    /// kind, and why one didn't run. This app's own words, in every language
    /// (`TranslationCatalog.nativeSources`).
    public enum SlashCommands {
        /// A row's tag: the kinds the app knows, in the person's language;
        /// any other as the computer named it, capitalized as they are.
        public static func kind(_ kind: String) -> String {
            switch kind {
            case "skill": localized("native.slashCommands.kindSkill", "Skill")
            case "compaction": localized("native.slashCommands.kindCompaction", "Compaction")
            default: kind.prefix(1).uppercased() + kind.dropFirst()
            }
        }

        public static func unavailable(_ name: String) -> String {
            localized("native.slashCommands.unavailable", ["name": .text(name)], "/\(name) is no longer available.")
        }

        public static func busy(_ name: String) -> String {
            localized("native.slashCommands.busy", ["name": .text(name)], "/\(name) can’t run right now. Try again when the agent is idle.")
        }

        public static func unreachable(_ name: String) -> String {
            localized("native.slashCommands.unreachable", ["name": .text(name)], "Couldn’t reach Happy Agent to run /\(name). Try again when it’s back.")
        }

        public static func refused(_ name: String) -> String {
            localized("native.slashCommands.refused", ["name": .text(name)], "Happy Agent couldn’t run /\(name).")
        }

        public static func notSaved(_ name: String) -> String {
            localized("native.slashCommands.notSaved", ["name": .text(name)], "/\(name) could not be saved on this phone. Your text is still here.")
        }

        /// Why `outcome` stopped the command; nil when it ran.
        public static func problem(_ outcome: SlashCommandOutcome, name: String) -> String? {
            switch outcome {
            case .accepted: nil
            case .unavailable: unavailable(name)
            case .busy: busy(name)
            case .unreachable: unreachable(name)
            case .refused: refused(name)
            case .notSaved: notSaved(name)
            }
        }
    }
}
