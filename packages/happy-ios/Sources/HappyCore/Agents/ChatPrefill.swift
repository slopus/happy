import Foundation

/// An ask typed into a conversation's composer for the person, unsent:
/// Settings' "Change agent name" and "Change agent avatar" open the
/// Chief of Staff's conversation with the words already there, the caret
/// after them, so the person says which name or which picture and sends
/// it themselves. Nothing here sends anything.
public struct ChatPrefill: Equatable, Sendable {
    /// Exactly what the composer opens with, the caret at its end. The
    /// trailing space is part of it: the person types straight on.
    public let prefix: String

    public init(prefix: String) {
        self.prefix = prefix
    }

    public static let agentName = ChatPrefill(prefix: "Change your name to ")
    public static let agentAvatar = ChatPrefill(prefix: "Change your avatar to ")

    /// What the composer shows, given the draft the conversation already
    /// had. The draft is kept, two lines under the ask, never dropped and
    /// never sent. A draft already opening with this ask is left exactly
    /// as it is, so coming back twice does not stack the words up.
    public func applied(to draft: String) -> Shown {
        let caret = (prefix as NSString).length
        if draft.hasPrefix(prefix) { return Shown(text: draft, caret: caret) }
        guard !draft.isEmpty else { return Shown(text: prefix, caret: caret) }
        return Shown(text: prefix + "\n\n" + draft, caret: caret)
    }

    /// The composer's text and where the caret goes in it, in UTF-16 as
    /// the text view counts.
    public struct Shown: Equatable, Sendable {
        public var text: String
        public var caret: Int

        public init(text: String, caret: Int) {
            self.text = text
            self.caret = caret
        }
    }
}
