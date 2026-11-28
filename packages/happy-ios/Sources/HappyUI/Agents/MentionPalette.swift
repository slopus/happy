#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The agent composer's `@` mentions (desktop's `happyAgentMentionPlaces`,
/// its people): while the word at the caret starts with `@`, the
/// composer's suggestion list hangs over the card, as the slash palette
/// does, with the teammates whose names hold the rest of the word. A tap,
/// Return or Tab writes the person in as their Happy link (`Mentions`).
@MainActor
final class MentionPalette {
    let list = ComposerSuggestionListView()
    private(set) var isShown = false
    private var word: ActiveWord?
    private var teammates: [TeamUser] = []
    private var me: String?
    private var items: [ComposerSuggestion] = []
    private var selected = -1
    /// A person was picked, for the `@` word at the caret.
    var onPick: ((ComposerSuggestion) -> Void)?
    /// It opened, closed or changed its rows: lay the screen out again.
    var onChange: (() -> Void)?
    /// An `@` started: the team may have changed since it was last read.
    var onStart: (() -> Void)?

    init(images: Images) {
        list.images = images
        list.isHidden = true
        list.accessibilityIdentifier = "mentionPalette"
        list.onSelect = { [weak self] index in self?.pick(index) }
    }

    /// The draft or its caret moved: the `@` word read in place.
    func update(units: NSString, selection: NSRange) {
        let word = Mentions.word(units: units, selection: selection)
        guard word?.activeWord != self.word?.activeWord else { return }
        if self.word == nil, word != nil { onStart?() }
        self.word = word
        refresh()
    }

    /// The team as the computer named them, and the reader, left out.
    func update(teammates: [TeamUser], me: String?) {
        guard teammates != self.teammates || me != self.me else { return }
        self.teammates = teammates
        self.me = me
        refresh()
    }

    /// Return or Tab: the highlighted person, or the first; false with
    /// the palette closed.
    func pickOnKey() -> Bool {
        guard isShown, !items.isEmpty else { return false }
        pick(max(0, selected))
        return true
    }

    func place(card: CGRect, top: CGFloat, scale: CGFloat) {
        guard isShown else { return }
        let frame = PixelGrid.snap(SlashPaletteLayout.frame(card: card, rows: items.count, border: list.border, top: top), scale: max(1, scale))
        // Bounds and centre: it may be mid-way through its rise.
        list.bounds = CGRect(origin: .zero, size: frame.size)
        list.center = CGPoint(x: frame.midX, y: frame.midY)
    }

    private func refresh() {
        let next = word.map { Mentions.suggestions($0.activeWord, in: teammates, me: me) } ?? []
        guard next != items else { return }
        selected = ComposerAutocomplete.selection(previous: selected, previousCount: items.count, count: next.count)
        items = next
        apply()
    }

    private func pick(_ index: Int) {
        guard items.indices.contains(index) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onPick?(items[index])
    }

    private func apply() {
        guard !items.isEmpty else {
            guard isShown else { return }
            isShown = false
            list.animateOut { [weak self] in
                guard let self, !self.isShown else { return }
                self.list.isHidden = true
            }
            onChange?()
            return
        }
        list.set(items, selected: selected)
        if !isShown {
            isShown = true
            list.isHidden = false
            onChange?()
            list.layoutIfNeeded()
            list.animateIn()
        } else {
            onChange?()
        }
    }
}
#endif
