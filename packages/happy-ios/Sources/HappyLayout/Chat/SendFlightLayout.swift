import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where a send's flight (`ChatSendFlight`) draws, in the screen's
/// coordinates. Nothing of it is ever drawn outside `screen`.
///
/// A draft that fits its input field morphs: its words leave the field as
/// the bubble grows around them into the row. A draft that scrolls in the
/// field shows its end there, while the bubble shows its start, so its
/// words are never carried over: the field's visible part fades where it
/// is and the row comes up from the composer, as a send with pictures does.
public struct SendFlightLayout: Equatable, Sendable {
    public enum Style: Equatable, Sendable {
        /// The words fly from the field into the bubble.
        case morph
        /// The row fades in, rising from the composer.
        case slide
    }

    /// What shows over the composer the moment it empties.
    public struct Source: Equatable, Sendable {
        /// The composer's words, laid out whole, where the field shows them:
        /// only for a draft that fits the field.
        public var words: CGRect?
        /// A picture of what the field shows, for a draft that scrolls.
        public var snapshot: CGRect?

        /// `field`: the input field; `text`: its words' frame as laid out
        /// whole; `scrolls`: the draft is taller than the field.
        public init(screen: CGRect, field: CGRect, text: CGRect?, scrolls: Bool) {
            let visible = field.intersection(screen)
            guard !visible.isNull, !visible.isEmpty else { return }
            if !scrolls, let text, visible.insetBy(dx: -0.5, dy: -0.5).contains(text) {
                words = text
            } else if text != nil || scrolls {
                snapshot = visible
            }
        }
    }

    public var style: Style

    /// How the send lands on its row at `row`: it morphs only when the
    /// composer's words were carried, the row has no pictures, and the row
    /// is wholly on screen, so the copy flying in never leaves it.
    public init(screen: CGRect, row: CGRect, source: Source, media: Bool) {
        let fits = screen.insetBy(dx: -0.5, dy: -0.5).contains(row)
        style = source.words != nil && !media && fits ? .morph : .slide
    }
}

/// A text taller than `threshold` is drawn a tile at a time, only the tiles
/// on screen, each `tile` tall: a pasted log opened in full is never one
/// bitmap the height of the log.
public enum ChatTextTiling {
    public static let threshold: CGFloat = 1024
    public static let tile: CGFloat = 512

    public static func tiles(height: CGFloat) -> Bool {
        height > threshold
    }
}
