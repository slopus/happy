#if canImport(UIKit)
import UIKit

/// The text the open composer's card would hold after Session | Bot
/// switches (the prompt while it holds the bot's name, the name while it
/// holds the prompt), measured off the main thread for the card as wide as
/// it is now, so the switch's first frame has the text's height.
///
/// Only the latest text asked for is kept: a measurement that lands after
/// another text, kind or width was asked for is dropped. The text is
/// compared, not copied; an unchanged prompt is the same string.
@MainActor
final class HomeDockKindText {
    private struct Entry {
        let createsBot: Bool
        let width: CGFloat
        let text: String
        var measured: AgentInputCardView.PremeasuredText?

        func isFor(createsBot: Bool, text: String, width: CGFloat) -> Bool {
            self.createsBot == createsBot && self.width == width && self.text == text
        }
    }

    private var entry: Entry?
    private var generation = 0
    private var measuring: Task<Void, Never>?

    /// Measures `text`, for the kind `createsBot`, for `card` `width` wide,
    /// unless it is measured or being measured for exactly that already.
    func prepare(createsBot: Bool, text: String, width: CGFloat, card: AgentInputCardView) {
        guard width > 0, entry?.isFor(createsBot: createsBot, text: text, width: width) != true else { return }
        generation += 1
        let generation = generation
        entry = Entry(createsBot: createsBot, width: width, text: text, measured: nil)
        measuring = Task { [weak self, weak card] in
            guard let card else { return }
            let measured = await card.premeasure(text, fitting: width)
            guard let self, self.generation == generation else { return }
            self.entry?.measured = measured
        }
    }

    /// The text measured for a switch to `createsBot` showing `text` with
    /// the card `width` wide; nil unless it is measured for exactly that.
    func measured(createsBot: Bool, text: String, width: CGFloat) -> AgentInputCardView.PremeasuredText? {
        guard let entry, entry.isFor(createsBot: createsBot, text: text, width: width) else { return nil }
        return entry.measured
    }

    /// Returns once the latest text asked for is measured (tests).
    func measuredLatest() async {
        await measuring?.value
    }
}
#endif
