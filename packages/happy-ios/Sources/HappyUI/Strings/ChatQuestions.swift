import Foundation

// The question banner and answer sheet's copy (AgentQuestionBanner.tsx,
// AgentQuestionModal.tsx), read from the screens' catalog under happy-app's
// `agentQuestion` keys; main thread only.

extension Strings {
    public enum AgentQuestion {
        public static var title: String { localized("agentQuestion.title", "Question") }
        public static var submit: String { localized("agentQuestion.submit", "Send answer") }
        public static var chooseMultiple: String { localized("agentQuestion.chooseMultiple", "Choose as many as apply") }
        public static var ownAnswer: String { localized("agentQuestion.ownAnswer", "Your own answer") }
        public static var ownAnswerPlaceholder: String { localized("agentQuestion.ownAnswerPlaceholder", "Write an answer instead") }
        public static var submitFailed: String { localized("agentQuestion.submitFailed", "Could not send your answer") }
        public static var dismiss: String { localized("agentQuestion.dismiss", "Dismiss") }
        public static var unsupportedTitle: String { localized("agentQuestion.unsupportedTitle", "Unsupported request") }
        /// _default.ts quotes the kind with straight quotes (translations/en.ts,
        /// which the app does not load, with «»).
        public static func unsupportedDescription(_ kind: String) -> String {
            localized("agentQuestion.unsupportedDescription", ["kind": .text(kind)], "This version of Happy cannot show a \"\(kind)\" request. Update the app to respond.")
        }
        public static func moreQuestions(_ count: Int) -> String {
            localized("agentQuestion.moreQuestions", ["count": .number(count)], count == 1 ? "1 more question" : "\(count) more questions")
        }
    }
}
