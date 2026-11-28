import Foundation

/// What Siri says for Happy's intents (`SiriAgents`). New with the native
/// apps: happy-app has no intents, so nothing here is in en.ts. Spoken, so
/// short, and never code, paths or IDs.
extension Strings {
    enum Siri {
        static var noConnection: String { "Open Happy and connect a computer first." }
        static var nothingToSend: String { "There was nothing to send." }
        static var gone: String { "That conversation isn't in Happy any more." }
        static func sent(_ name: String) -> String { "Sent to \(name)." }
        static func queued(_ name: String) -> String {
            "Saved for \(name). It goes when Happy next reaches your computer."
        }
        static func failed(_ name: String) -> String { "That didn't go through to \(name). Try it in the app." }
        static func refused(_ name: String) -> String { "\(lead(name)) can't take a message right now. Try it in the app." }
        static func waiting(_ name: String) -> String { "\(lead(name)) is waiting for your answer in the app first." }
        static func unreadable(_ name: String) -> String { "I couldn't read \(name) right now." }
        static func noReply(_ name: String) -> String { "\(lead(name)) hasn't replied yet." }
        static func reply(_ name: String, _ reply: String, working: Bool) -> String {
            working ? "\(lead(name)) is still working. Its last reply: \(reply)" : "\(lead(name)) said: \(reply)"
        }

        /// A name opening a sentence: "a new task" says "A new task".
        private static func lead(_ name: String) -> String { name.prefix(1).uppercased() + name.dropFirst() }
    }
}
