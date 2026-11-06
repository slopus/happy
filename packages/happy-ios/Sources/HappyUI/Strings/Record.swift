import Foundation

/// The microphone button and its recording screen (`RecordButton`). New
/// with the native apps: happy-app has no such button, so nothing here is in
/// en.ts. The words are Telegram's.
extension Strings {
    enum Record {
        /// VoiceOver for the button.
        static var dictate: String { "Dictate" }
        static var dictateHint: String { "Hold to talk, let go to type what you said. Slide left to cancel, up to keep talking hands-free." }
        static var slideToCancel: String { "Slide to cancel" }
        static var cancel: String { "Cancel" }
        /// The locked circle: done, the words go in the input box.
        static var send: String { "Done" }
        /// The locked pill: stop, the same.
        static var stop: String { "Stop" }
        static var lock: String { "Slide up to lock" }
        static var microphoneTitle: String { "Microphone access is off" }
        static var microphoneMessage: String { "Allow Happy to use the microphone in Settings to dictate." }
        static var speechTitle: String { "Speech recognition is off" }
        static var speechMessage: String { "Allow Happy to recognize speech in Settings to dictate." }
        static var unavailableTitle: String { "Dictation isn’t available" }
        static var unavailableMessage: String { "This iPhone can’t recognize speech in your language on the device." }
        static var nothingHeard: String { "Nothing was heard" }
        static var openSettings: String { "Open Settings" }
    }
}
