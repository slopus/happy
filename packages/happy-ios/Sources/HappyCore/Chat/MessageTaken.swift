import Foundation

/// Without receipts, which of the person's messages the agent took in, as
/// the agent answering after them says. Rows are newest first; `isUser`
/// marks the person's own text.
public enum MessageTaken {
    /// For each row, true when an answer came after it. `strict` (a Happy
    /// CLI that can lose a message, `SessionDetails.waitsForCLIBeforeFirstMessage`)
    /// counts, before the session's first answer, only an answer before the
    /// person's next message: an old CLI that never read the first message
    /// still answers the second, and two checks on the first said it had
    /// arrived when it hadn't. Once it has answered it is listening, and an
    /// answer stands for everything before it.
    public static func answered(_ isUser: [Bool], strict: Bool) -> [Bool] {
        let firstAnswer = isUser.lastIndex(of: false) ?? -1
        var result = Array(repeating: false, count: isUser.count)
        // Walking from the newest: whether an answer is newer than this row
        // (and, when strict and before the first answer, older than the
        // person's next message).
        var answerAbove = false
        for (index, user) in isUser.enumerated() {
            if user {
                result[index] = answerAbove
                if strict, index > firstAnswer { answerAbove = false }
            } else {
                answerAbove = true
            }
        }
        return result
    }
}
