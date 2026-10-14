import Foundation
import HappyCore

// The composer's copy, verbatim from happy-app's en.ts. A string happy-app
// reads with `t('key')` reads the screens' catalog under that key
// (`localized`, main thread only); the call it comes from is noted. The
// accessibility labels AgentInput.tsx writes as literals stay English, as
// there.
extension Strings {
    public enum Composer {
        /// SessionView.tsx `placeholder={t('session.inputPlaceholder')}`.
        public static var inputPlaceholder: String { localized("session.inputPlaceholder", "Type a message ...") }

        /// AgentInput.tsx `t('agentInput.permissionMode.title')`: the chip's
        /// label and its menu's heading.
        public static var permissionModeTitle: String { localized("agentInput.permissionMode.title", "PERMISSION MODE") }
        /// AgentInput.tsx `t('agentInput.codexPermissionMode.title')`.
        public static var codexPermissionModeTitle: String { localized("agentInput.codexPermissionMode.title", "CODEX PERMISSION MODE") }
        /// AgentInput.tsx `t('agentInput.geminiPermissionMode.title')`.
        public static var geminiPermissionModeTitle: String { localized("agentInput.geminiPermissionMode.title", "GEMINI PERMISSION MODE") }
        /// AgentInput.tsx `t('agentInput.model.title')`.
        public static var modelTitle: String { localized("agentInput.model.title", "MODEL") }
        /// AgentInput.tsx `{t('agentInput.model.configureInCli')}`.
        public static var configureModelsInCli: String { localized("agentInput.model.configureInCli", "Configure models in CLI settings") }
        /// AgentInput.tsx `t('agentInput.effort.title')`.
        public static var effortTitle: String { localized("agentInput.effort.title", "EFFORT") }

        /// AgentInput.tsx `t('agentInput.context.detailContext', { used, total })`.
        public static func detailContext(used: String, total: String) -> String { localized("agentInput.context.detailContext", ["used": .text(used), "total": .text(total)], "\(used) / \(total) context") }
        /// AgentInput.tsx `t('agentInput.context.percentContext', { percent })`.
        public static func percentContext(_ percent: Int) -> String { localized("agentInput.context.percentContext", ["percent": .number(percent)], "\(percent)% context") }
        /// AgentInput.tsx `t('agentInput.context.percentWeek', { percent })`.
        public static func percentWeek(_ percent: Int) -> String { localized("agentInput.context.percentWeek", ["percent": .number(percent)], "\(percent)% week") }
        /// AgentInput.tsx `t('agentInput.usagePopup.session')`.
        public static var usageSession: String { localized("agentInput.usagePopup.session", "Session") }
        /// AgentInput.tsx `t('agentInput.usagePopup.week')`.
        public static var usageWeek: String { localized("agentInput.usagePopup.week", "Week") }
        /// AgentInput.tsx `t('agentInput.usagePopup.resets', { time })`.
        public static func usageResets(_ time: String) -> String { localized("agentInput.usagePopup.resets", ["time": .text(time)], "Resets \(time)") }

        /// AgentInputSuggestionView.tsx `t('agentInput.suggestion.fileLabel')`.
        public static var fileLabel: String { localized("agentInput.suggestion.fileLabel", "FILE") }
        /// AgentInputSuggestionView.tsx `t('agentInput.suggestion.folderLabel')`.
        public static var folderLabel: String { localized("agentInput.suggestion.folderLabel", "FOLDER") }

        /// sessionUtils.ts `t('status.permissionRequired')`.
        public static var permissionRequired: String { localized("status.permissionRequired", "permission required") }
        /// sessionUtils.ts `t('status.inputRequired')`.
        public static var inputRequired: String { localized("status.inputRequired", "waiting for your answer") }
        /// sessionUtils.ts `t('status.online')`.
        public static var online: String { localized("status.online", "online") }
        /// sessionUtils.ts `t('status.lastSeen', { time })`.
        public static func lastSeen(_ time: String) -> String { localized("status.lastSeen", ["time": .text(time)], "last seen \(time)") }
        /// sessionUtils.ts `formatLastSeen`: `t('time.justNow')`.
        public static var justNow: String { localized("time.justNow", "just now") }
        /// sessionUtils.ts `formatLastSeen`: `t('time.minutesAgo', { count })`.
        public static func minutesAgo(_ count: Int) -> String { localized("time.minutesAgo", ["count": .number(count)], "\(count) minute\(count != 1 ? "s" : "") ago") }
        /// sessionUtils.ts `formatLastSeen`: `t('time.hoursAgo', { count })`.
        public static func hoursAgo(_ count: Int) -> String { localized("time.hoursAgo", ["count": .number(count)], "\(count) hour\(count != 1 ? "s" : "") ago") }
        /// sessionUtils.ts `formatLastSeen`: `t('sessionHistory.daysAgo', { count })`.
        public static func daysAgo(_ count: Int) -> String { localized("sessionHistory.daysAgo", ["count": .number(count)], "\(count) \(count == 1 ? "day" : "days") ago") }

        /// AgentInput.tsx `accessibilityLabel={t('settings.title')}`: the
        /// wide composer's gear.
        public static var settingsTitle: String { localized("settings.title", "Settings") }

        /// AgentInput.tsx `accessibilityLabel="Add photo"`, a literal.
        public static let addPhoto = "Add photo"
        /// AgentInput.tsx `accessibilityLabel={shouldShowStopButton ? 'Stop' … : 'Send'}`, literals.
        public static let stop = "Stop"
        public static let send = "Send"
    }

    /// en.ts `imageUpload`: useImagePicker.ts's alerts, and sync.ts's
    /// "Images Not Supported" and "Upload Failed".
    public enum ImageUpload {
        public static var permissionTitle: String { localized("imageUpload.permissionTitle", "Photo Library Access") }
        public static var permissionMessage: String { localized("imageUpload.permissionMessage", "Allow access to your photo library to attach images to messages.") }
        public static var limitTitle: String { localized("imageUpload.limitTitle", "Image Limit Reached") }
        public static func limitMessage(_ max: Int) -> String { localized("imageUpload.limitMessage", ["max": .number(max)], "You can attach up to \(max) images per message.") }
        public static var fileTooLargeTitle: String { localized("imageUpload.fileTooLargeTitle", "File Too Large") }
        public static func fileTooLargeMessage(name: String, maxMb: Int) -> String { localized("imageUpload.fileTooLargeMessage", ["name": .text(name), "maxMb": .number(maxMb)], "\"\(name)\" exceeds the \(maxMb)MB limit and was not added.") }
        public static var uploadFailedTitle: String { localized("imageUpload.uploadFailedTitle", "Upload Failed") }
        public static func uploadFailedMessage(_ count: Int) -> String { localized("imageUpload.uploadFailedMessage", ["count": .number(count)], count == 1 ? "One image could not be uploaded and was not sent." : "\(count) images could not be uploaded and were not sent.") }
        public static var notSupportedTitle: String { localized("imageUpload.notSupportedTitle", "Images Not Supported") }
        public static var notSupportedMessage: String { localized("imageUpload.notSupportedMessage", "This agent does not support image attachments. Images were not sent.") }
        public static var attachTitle: String { localized("imageUpload.attachTitle", "Add Image") }
        public static var pasteFromClipboard: String { localized("imageUpload.pasteFromClipboard", "Paste from Clipboard") }
        public static var chooseFromLibrary: String { localized("imageUpload.chooseFromLibrary", "Photo Library") }
        public static var nothingToPasteTitle: String { localized("imageUpload.nothingToPasteTitle", "Nothing to Paste") }
        public static var nothingToPasteMessage: String { localized("imageUpload.nothingToPasteMessage", "Copy an image first, then try again.") }
    }
}
