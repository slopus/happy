#if canImport(UIKit)
import UIKit

/// The feedback happy-agent's API.md "Haptics" table names for each story
/// moment, the same on every client. Only the person's own acts play one,
/// never a change that arrived from the computer. Generators are prepared
/// as the gesture that may end in a moment begins, so it is never late.
enum StoriesHaptics {
    enum Moment: String, CaseIterable {
        /// The viewer opens from a circle or an inline story.
        case open = "story.open"
        /// The viewer moves to another frame, story or author.
        case advance = "story.advance"
        /// `post` answered 200 (not the tap).
        case post = "story.post"
        /// A confirmed deletion answered 200.
        case delete = "story.delete"
        /// A reaction bubble or the heart, as the reaction appears.
        case react = "story.react"
        /// A sticker or emoji lands on a frame from the picker.
        case stickerDrop = "sticker.drop"
        /// A dragged overlay snaps to a guide, once each time.
        case snap = "overlay.snap"
        /// A dragged overlay reaches the delete target.
        case trash = "overlay.trash"
        /// A refused post or deletion.
        case refused
        /// Home's stories open under the header, or close into the title,
        /// under the person's finger (Telegram's chat list: a tap, then a
        /// very light impact).
        case headerOpen = "stories.header.open"
        case headerClose = "stories.header.close"
    }

    enum Feedback: Equatable {
        case selection
        /// An impact of `style` at `intensity` (1: the style's own).
        case impact(UIImpactFeedbackGenerator.FeedbackStyle, intensity: CGFloat)
        case notification(UINotificationFeedbackGenerator.FeedbackType)
    }

    static func feedback(_ moment: Moment) -> Feedback {
        switch moment {
        case .open, .react: .impact(.light, intensity: 1)
        case .advance: .selection
        case .post: .notification(.success)
        case .delete: .notification(.warning)
        case .stickerDrop: .impact(.medium, intensity: 1)
        // "Rigid impact, light".
        case .snap: .impact(.rigid, intensity: 0.5)
        case .trash: .impact(.heavy, intensity: 1)
        case .refused: .notification(.error)
        case .headerOpen: .selection
        case .headerClose: .impact(.medium, intensity: 0.3)
        }
    }

    /// Plays feedback; tests put a recorder here.
    @MainActor
    protocol Player: AnyObject {
        func prepare(_ feedback: Feedback)
        func play(_ feedback: Feedback)
    }

    @MainActor static var player: Player = Generators()

    /// Each moment as it plays, for the harness to report.
    @MainActor static var onPlay: ((Moment) -> Void)?

    @MainActor static func play(_ moment: Moment) {
        onPlay?(moment)
        player.play(feedback(moment))
    }

    @MainActor static func prepare(_ moments: Moment...) {
        for moment in moments { player.prepare(feedback(moment)) }
    }

    /// One prepared generator per kind, kept.
    @MainActor
    final class Generators: Player {
        private let selection = UISelectionFeedbackGenerator()
        private var impacts: [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]
        private let notification = UINotificationFeedbackGenerator()

        private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
            if let kept = impacts[style] { return kept }
            let made = UIImpactFeedbackGenerator(style: style)
            impacts[style] = made
            return made
        }

        func prepare(_ feedback: Feedback) {
            switch feedback {
            case .selection: selection.prepare()
            case .impact(let style, _): impact(style).prepare()
            case .notification: notification.prepare()
            }
        }

        func play(_ feedback: Feedback) {
            switch feedback {
            case .selection:
                selection.selectionChanged()
                selection.prepare()
            case .impact(let style, let intensity):
                impact(style).impactOccurred(intensity: intensity)
                impact(style).prepare()
            case .notification(let type):
                notification.notificationOccurred(type)
                notification.prepare()
            }
        }
    }
}
#endif
