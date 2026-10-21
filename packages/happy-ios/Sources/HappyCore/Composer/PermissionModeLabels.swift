import Foundation

/// permissionModeLabels.ts: the one-word permission vocabulary every
/// harness shares.
///
/// The chip beside the model and effort chips has room for one word. The
/// catalogs we ship are named in these words; a harness that publishes its
/// own keeps its wording, shortened to the first word ("Workspace write"
/// reads as "Workspace").
public enum PermissionModeLabels {
    /// Pick order, lowest first: Auto and Edits lead, Default trails with
    /// Yolo/Full just above it.
    static let ranks: [String: Int] = [
        "auto": 10,
        "edits": 15,
        "plan": 20,
        "workspace": 30,
        "read": 40,
        "yolo": 50,
        "full": 50,
        "default": 100,
    ]

    /// Words we don't know sort above Default, so they stay easy to reach.
    static let unranked = 90

    static func firstWord(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
    }

    /// `getPermissionModeShortLabel`: the chip's one word, nil for no mode
    /// or a blank name.
    public static func shortLabel(_ mode: ModeOption?) -> String? {
        guard let mode else { return nil }
        let word = firstWord(mode.name)
        return word.isEmpty ? nil : word
    }

    /// `getPermissionModeMenuLabel`: a menu row is the mode's name alone.
    public static func menuLabel(_ mode: ModeOption) -> String {
        mode.name
    }

    /// `getPermissionModeRank`.
    public static func rank(_ name: String) -> Int {
        ranks[firstWord(name).lowercased()] ?? unranked
    }

    /// `sortPermissionModes`: by rank; equal ranks keep the order the
    /// harness sent.
    public static func sorted(_ modes: [ModeOption]) -> [ModeOption] {
        modes.enumerated()
            .sorted { left, right in
                let l = rank(left.element.name)
                let r = rank(right.element.name)
                return l != r ? l < r : left.offset < right.offset
            }
            .map(\.element)
    }
}

/// modeHacks.ts: tidies the doubled names some harnesses publish.
public enum ModeHacks {
    /// `hackMode`.
    public static func hack(_ mode: ModeOption) -> ModeOption {
        let name = mode.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let key = mode.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var mode = mode
        if name == "build, build" || (key == "build" && name == "build") {
            mode.name = "Build"
        } else if name == "plan/plan" || (key == "plan" && name == "plan") {
            mode.name = "Plan"
        }
        return mode
    }

    /// `hackModes`.
    public static func hack(_ modes: [ModeOption]) -> [ModeOption] {
        modes.map(hack)
    }
}
