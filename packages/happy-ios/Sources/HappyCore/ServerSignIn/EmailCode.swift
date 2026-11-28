import Foundation

/// The code Happy Cloud emails to sign in with: six digits. Typed, filled
/// by iOS from Messages or Apple Mail, or pasted from wherever else the
/// email was read (Gmail's app, say), which iOS doesn't offer over the
/// keyboard.
public enum EmailCode {
    public static let length = 6

    /// The code in pasted text: its first run of exactly six digits
    /// ("Your Happy code is 123456."), so a longer number beside it (an
    /// order, a year and a day) isn't taken for one; failing that, its
    /// digits when they are six in all (`123 456`, `123-456`). nil when
    /// there is no such thing. Only `0`–`9` count as digits.
    public static func find(in text: String) -> String? {
        var runs: [Substring] = []
        var start: String.Index?
        for index in text.indices {
            if isDigit(text[index]) {
                if start == nil { start = index }
            } else if let from = start {
                runs.append(text[from..<index])
                start = nil
            }
        }
        if let from = start { runs.append(text[from...]) }
        if let run = runs.first(where: { $0.count == length }) { return String(run) }
        let digits = runs.joined()
        return digits.count == length ? digits : nil
    }

    private static func isDigit(_ character: Character) -> Bool { character.asciiValue.map { (48...57).contains($0) } ?? false }
}
