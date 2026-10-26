#if canImport(UIKit)
import UIKit

/// What Stem Cells' gestures feel like, by what they mean. Desktop's
/// `haptics.ts` names two signals, a `selection` tick each time a drag
/// crosses a slot and an `impact` when something is dropped; the rest are
/// iOS's conventions for the same kinds of moment. Only the person's own
/// acts play one, never a change that arrived from the computer.
enum StemCellsHaptics {
    enum Moment: CaseIterable {
        /// A hold opened a row's preview and menu (Telegram's light tap).
        case hold
        /// A held row was lifted to be carried.
        case lift
        /// A carried row's landing slot changed.
        case slot
        /// A carried row was set down.
        case drop
        /// Work was archived, left or closed.
        case putAway
        /// A rename was kept.
        case renamed
        /// A message went.
        case send
        /// New work was made from the dock's field.
        case newWork
        /// A picker's choice changed.
        case pick
        /// A section folded or unfolded.
        case fold
    }

    enum Feedback: Equatable {
        case selection
        case impact(UIImpactFeedbackGenerator.FeedbackStyle)
        case notification(UINotificationFeedbackGenerator.FeedbackType)
    }

    static func feedback(_ moment: Moment) -> Feedback {
        switch moment {
        case .lift: .impact(.medium)
        case .slot, .pick: .selection
        case .hold, .drop, .renamed, .send, .newWork, .fold: .impact(.light)
        case .putAway: .notification(.success)
        }
    }

    /// Plays feedback; tests put a recorder here.
    @MainActor
    protocol Player: AnyObject {
        func prepare(_ feedback: Feedback)
        func play(_ feedback: Feedback)
    }

    @MainActor static var player: Player = Generators()

    @MainActor static func play(_ moment: Moment) {
        player.play(feedback(moment))
    }

    /// Warms the generator `moment` uses, so its first feedback isn't late
    /// (as a touch begins, before the act it may end in).
    @MainActor static func prepare(_ moment: Moment) {
        player.prepare(feedback(moment))
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
            case .impact(let style): impact(style).prepare()
            case .notification: notification.prepare()
            }
        }

        func play(_ feedback: Feedback) {
            switch feedback {
            case .selection:
                selection.selectionChanged()
                selection.prepare()
            case .impact(let style):
                impact(style).impactOccurred()
                impact(style).prepare()
            case .notification(let type):
                notification.notificationOccurred(type)
            }
        }
    }
}
#endif
