import Foundation
import HappyCore

// The composer's copy, verbatim from happy-app's en.ts (the key each comes
// from is noted). Accessibility labels without a key are AgentInput.tsx's
// literals.
extension Strings {
    public enum Composer {
        /// session.inputPlaceholder
        public static let inputPlaceholder = "Type a message ..."

        /// agentInput.permissionMode.title
        public static let permissionModeTitle = "PERMISSION MODE"
        /// agentInput.codexPermissionMode.title
        public static let codexPermissionModeTitle = "CODEX PERMISSION MODE"
        /// agentInput.geminiPermissionMode.title
        public static let geminiPermissionModeTitle = "GEMINI PERMISSION MODE"
        /// agentInput.model.title
        public static let modelTitle = "MODEL"
        /// agentInput.model.configureInCli
        public static let configureModelsInCli = "Configure models in CLI settings"
        /// agentInput.effort.title
        public static let effortTitle = "EFFORT"

        /// agentInput.context.detailContext
        public static func detailContext(used: String, total: String) -> String { "\(used) / \(total) context" }
        /// agentInput.context.percentContext
        public static func percentContext(_ percent: Int) -> String { "\(percent)% context" }
        /// agentInput.context.percentWeek
        public static func percentWeek(_ percent: Int) -> String { "\(percent)% week" }
        /// agentInput.usagePopup.session
        public static let usageSession = "Session"
        /// agentInput.usagePopup.week
        public static let usageWeek = "Week"
        /// agentInput.usagePopup.resets
        public static func usageResets(_ time: String) -> String { "Resets \(time)" }

        /// agentInput.suggestion.fileLabel
        public static let fileLabel = "FILE"
        /// agentInput.suggestion.folderLabel
        public static let folderLabel = "FOLDER"

        /// status.permissionRequired
        public static let permissionRequired = "permission required"
        /// status.inputRequired
        public static let inputRequired = "waiting for your answer"
        /// status.online
        public static let online = "online"
        /// status.lastSeen
        public static func lastSeen(_ time: String) -> String { "last seen \(time)" }
        /// time.justNow
        public static let justNow = "just now"
        /// time.minutesAgo
        public static func minutesAgo(_ count: Int) -> String { "\(count) minute\(count != 1 ? "s" : "") ago" }
        /// time.hoursAgo
        public static func hoursAgo(_ count: Int) -> String { "\(count) hour\(count != 1 ? "s" : "") ago" }
        /// sessionHistory.daysAgo
        public static func daysAgo(_ count: Int) -> String { "\(count) \(count == 1 ? "day" : "days") ago" }

        /// settings.title: the wide composer's gear.
        public static let settingsTitle = "Settings"

        public static let addPhoto = "Add photo"
        public static let stop = "Stop"
        public static let send = "Send"
    }

    /// en.ts `imageUpload`
    public enum ImageUpload {
        public static let permissionTitle = "Photo Library Access"
        public static let permissionMessage = "Allow access to your photo library to attach images to messages."
        public static let limitTitle = "Image Limit Reached"
        public static func limitMessage(_ max: Int) -> String { "You can attach up to \(max) images per message." }
        public static let fileTooLargeTitle = "File Too Large"
        public static func fileTooLargeMessage(name: String, maxMb: Int) -> String { "\"\(name)\" exceeds the \(maxMb)MB limit and was not added." }
        public static let uploadFailedTitle = "Upload Failed"
        public static func uploadFailedMessage(_ count: Int) -> String {
            count == 1
                ? "One image could not be uploaded and was not sent."
                : "\(count) images could not be uploaded and were not sent."
        }
        public static let notSupportedTitle = "Images Not Supported"
        public static let notSupportedMessage = "This agent does not support image attachments. Images were not sent."
        public static let attachTitle = "Add Image"
        public static let pasteFromClipboard = "Paste from Clipboard"
        public static let chooseFromLibrary = "Photo Library"
        public static let nothingToPasteTitle = "Nothing to Paste"
        public static let nothingToPasteMessage = "Copy an image first, then try again."
    }
}
