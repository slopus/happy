import Foundation

// The question banner and answer sheet's copy, verbatim from happy-app's
// en.ts `agentQuestion`.

extension Strings {
    public enum AgentQuestion {
        public static let title = "Question"
        public static let submit = "Send answer"
        public static let chooseMultiple = "Choose as many as apply"
        public static let ownAnswer = "Your own answer"
        public static let ownAnswerPlaceholder = "Write an answer instead"
        public static let submitFailed = "Could not send your answer"
        public static let dismiss = "Dismiss"
        public static let unsupportedTitle = "Unsupported request"
        public static func unsupportedDescription(_ kind: String) -> String {
            "This version of Happy cannot show a «\(kind)» request. Update the app to respond."
        }
        public static func moreQuestions(_ count: Int) -> String {
            count == 1 ? "1 more question" : "\(count) more questions"
        }
    }
}
