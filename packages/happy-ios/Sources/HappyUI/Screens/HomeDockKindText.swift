#if canImport(UIKit)
import HappyLayout
import UIKit

/// The text the open composer's card would hold after Session | Bot
/// switches (the prompt while it holds the bot's name, the name while it
/// holds the prompt), measured off the main thread for the card as it is
/// now, so the switch's first frame has the text's height.
///
/// A measurement is for one text, kind and card key (`textKey(fitting:)`:
/// the width, the text size, the panel); another of any of them is not it,
/// and asking again measures again. Only the latest text asked for is
/// kept: a measurement that lands after another was asked for is dropped.
/// The text is compared, not copied; an unchanged prompt is the same
/// string.
@MainActor
final class HomeDockKindText {
    private struct Entry {
        let createsBot: Bool
        let key: ComposerTextHeights.Key
        let text: String
        var measured: AgentInputCardView.PremeasuredText?

        func isFor(createsBot: Bool, text: String, key: ComposerTextHeights.Key) -> Bool {
            self.createsBot == createsBot && self.key == key && self.text == text
        }
    }

    private weak var card: AgentInputCardView?
    private var entry: Entry?
    private var generation = 0
    private var measuring: Task<Void, Never>?

    init(card: AgentInputCardView) {
        self.card = card
    }

    /// Measures `text`, for the kind `createsBot`, for the card `width`
    /// wide as it is drawn now, unless it is measured or being measured
    /// for exactly that already.
    func prepare(createsBot: Bool, text: String, width: CGFloat) {
        guard let card else { return }
        let key = card.textKey(fitting: width)
        guard key.width > 0, entry?.isFor(createsBot: createsBot, text: text, key: key) != true else { return }
        generation += 1
        let generation = generation
        entry = Entry(createsBot: createsBot, key: key, text: text, measured: nil)
        measuring = Task { [weak self, weak card] in
            guard let card else { return }
            let measured = await card.premeasure(text, fitting: width)
            guard let self, self.generation == generation else { return }
            self.entry?.measured = measured
        }
    }

    /// The text measured for a switch to `createsBot` showing `text` with
    /// the card `width` wide as it is drawn now; nil unless it is measured
    /// for exactly that.
    func measured(createsBot: Bool, text: String, width: CGFloat) -> AgentInputCardView.PremeasuredText? {
        guard let card, let entry, entry.isFor(createsBot: createsBot, text: text, key: card.textKey(fitting: width)) else { return nil }
        return entry.measured
    }

    /// Returns once the latest text asked for is measured (tests).
    func measuredLatest() async {
        await measuring?.value
    }
}
#endif
