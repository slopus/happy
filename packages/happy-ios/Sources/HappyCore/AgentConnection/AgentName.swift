import Foundation

/// The name an agent connection is shown under. A node is named by its
/// owner, but an unnamed one reports its host name ("Steves-MacBook-Pro.local"),
/// which reads as the machine's address, not its name. That is turned back
/// into the computer name macOS made it from ("Steve's MacBook Pro"); a name
/// with a space in it was chosen by a person and stays as it is.
public enum AgentName {
    public static let fallback = "Happy Agent"

    public static func friendly(_ raw: String) -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return fallback }
        guard !name.contains(" ") else { return name }
        // The first label of a dotted host name, unless every label is a
        // number (an IP address names nothing better).
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        let host = labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) ? name : String(labels[0])
        var words = host.split(whereSeparator: { $0 == "-" || $0 == "_" }).map(String.init)
        guard !words.isEmpty else { return name }
        let lowercase = host == host.lowercased()
        words = words.map { word in
            if let device = devices[word.lowercased()] { return device }
            return lowercase ? word.prefix(1).uppercased() + word.dropFirst() : word
        }
        // macOS drops the apostrophe: "Steves MacBook" was "Steve's MacBook".
        // Names that end in s themselves ("Chris", "James") stay.
        if words.count > 1, devices.values.contains(words[1]), possessive(words[0]) {
            words[0] = words[0].dropLast() + "'s"
        }
        return words.joined(separator: " ")
    }

    private static func possessive(_ word: String) -> Bool {
        let lower = word.lowercased()
        guard lower.count > 3, lower.hasSuffix("s") else { return false }
        if ["as", "is", "os", "us", "ss", "ys"].contains(where: lower.hasSuffix) { return false }
        return !["james", "charles", "miles", "jules", "agnes", "moses", "frances"].contains(lower)
    }

    /// Apple's device words as their names are written.
    private static let devices: [String: String] = [
        "macbook": "MacBook", "imac": "iMac", "mac": "Mac", "mini": "mini",
        "iphone": "iPhone", "ipad": "iPad",
    ]
}
