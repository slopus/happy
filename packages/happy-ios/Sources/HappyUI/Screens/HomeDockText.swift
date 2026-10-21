#if canImport(UIKit)
import HappyLayout
import UIKit

/// The heights Home's dock draws its own text at, for one text size and
/// screen: one line of each style (as a one-line label measures it,
/// `TextStyle.oneLine(in:)`) and the bot's lede wrapped at its lane. Made
/// off the main thread (AGENTS.md rule 8), so laying the dock out at any
/// text size measures no text there for a height. The card's text is the
/// card's own (`ComposerTextHeights`).
struct HomeDockText: Equatable, Sendable {
    /// What the heights depend on: the text size and screen, the lede's
    /// lane (`HomeDockHeaderLayout.ledeWidth`) and its words, which are
    /// read on the main thread in the screens' language.
    struct Key: Hashable, Sendable {
        var text: TextEnvironment
        var ledeWidth: CGFloat
        var lede: String
    }

    let key: Key
    /// The resting capsule's prompt or placeholder.
    let entryLine: CGFloat
    /// `focusConfigTriggerValue`, which holds a picker row up.
    let triggerLine: CGFloat
    /// "Starting Claude Code…" and "To interrupt press stop".
    let progressLine: CGFloat
    /// The faces' "Avatar" and their credit.
    let faceHeadingLine: CGFloat
    let creditLine: CGFloat
    /// The bot's lede, centred, wrapped at `key.ledeWidth`.
    let lede: CGSize

    nonisolated init(_ key: Key) {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        let text = key.text
        self.key = key
        entryLine = TextStyles.homeDockEntry.oneLine(in: text)
        triggerLine = TextStyles.homeDockRowValue.oneLine(in: text)
        progressLine = TextStyles.homeDockProgress.oneLine(in: text)
        faceHeadingLine = TextStyles.botFaceHeading.oneLine(in: text)
        creditLine = TextStyles.botFaceCredit.oneLine(in: text)
        lede = NoSessionsMeasure.measure(key.lede, style: TextStyles.homeDockLede, lines: 0, alignment: .center, environment: text, width: key.ledeWidth)
    }

    static func make(_ key: Key) async -> HomeDockText {
        await Task.detached(priority: .userInitiated) { HomeDockText(key) }.value
    }

    /// `label`'s width, as it measures itself, at `line`'s height: a
    /// one-line label whose height comes from here. The width places it
    /// and changes no height.
    @MainActor
    static func line(_ label: UIView, _ line: CGFloat) -> Measurable {
        Measurable { [unowned label] width in
            CGSize(width: label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).width, height: line)
        }
    }
}

/// The dock's `HomeDockText`, made off the main thread for the key last
/// asked for. A result for an older key never lands.
@MainActor
final class HomeDockTextStore {
    private(set) var current: HomeDockText?
    private var asked: HomeDockText.Key?
    private var waiting: [(key: HomeDockText.Key, ready: @MainActor (HomeDockText?) -> Void)] = []
    /// Called on the main thread when a new value lands.
    var onChange: (@MainActor () -> Void)?

    /// The heights for `key`, if they have landed.
    func text(for key: HomeDockText.Key) -> HomeDockText? {
        current?.key == key ? current : nil
    }

    /// Makes the heights for `key` unless they are made or being made.
    func prepare(_ key: HomeDockText.Key) {
        guard current?.key != key, asked != key else { return }
        asked = key
        Task { [weak self] in
            let text = await HomeDockText.make(key)
            guard let self, self.asked == key else { return }
            self.current = text
            self.asked = nil
            let ready = self.waiting.filter { $0.key == key }
            self.waiting.removeAll { $0.key == key }
            self.onChange?()
            for entry in ready { entry.ready(text) }
        }
    }

    /// Calls `ready` with the heights for `key` once they land, or with
    /// nil after `timeout` (at once if they have).
    func whenReady(_ key: HomeDockText.Key, timeout: Duration, _ ready: @escaping @MainActor (HomeDockText?) -> Void) {
        if let text = text(for: key) { return ready(text) }
        prepare(key)
        let once = Once(ready)
        waiting.append((key, { once.fire($0) }))
        Task { @MainActor in
            try? await Task.sleep(for: timeout)
            once.fire(nil)
        }
    }

    /// One answer per wait: the heights or the deadline, whichever first.
    @MainActor
    private final class Once {
        private var ready: (@MainActor (HomeDockText?) -> Void)?
        init(_ ready: @escaping @MainActor (HomeDockText?) -> Void) { self.ready = ready }
        func fire(_ value: HomeDockText?) {
            let ready = self.ready
            self.ready = nil
            ready?(value)
        }
    }
}
#endif
