import Foundation

/// What the microphone button records. Telegram's button switches between
/// a voice message and a round video with a tap; here a tap locks the
/// recording instead, and dictation is the only mode until video messages
/// come (docs/VIDEO-MESSAGES.md). A new mode is a case here and a line in
/// `offered`; the button, its glyph and its words switch on this.
public enum RecordMode: String, CaseIterable, Sendable {
    /// Hold to talk; what was said is written out on the phone and sent.
    case dictation

    /// The modes the button offers, in the order a switch goes through.
    public static let offered: [RecordMode] = [.dictation]

    /// The mode a switch goes to: the next offered, round to the first.
    public var next: RecordMode {
        let modes = Self.offered
        guard let index = modes.firstIndex(of: self), modes.count > 1 else { return self }
        return modes[(index + 1) % modes.count]
    }

    /// A tap switches modes only when there is another to go to; with one,
    /// it locks the recording.
    public static var tapSwitches: Bool { offered.count > 1 }
}
