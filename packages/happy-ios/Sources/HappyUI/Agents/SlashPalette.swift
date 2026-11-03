#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The agent composer's slash commands (desktop d04fbfef, 4078fd44,
/// fd553cc3): while the whole draft is `/` and a command word some command
/// starts with, the composer's suggestion list hangs over the card with
/// those commands, filtered as the word grows. A tap, Return or Tab picks:
/// one that takes arguments waits for them after its name, any other runs.
@MainActor
final class SlashPalette {
    let list = ComposerSuggestionListView()
    private(set) var isShown = false
    private var catalog: [AgentWire.SlashCommand] = []
    private var agentId = ""
    private var query: String?
    private var items: [ComposerSuggestion] = []
    private var selected = -1
    /// A command was picked.
    var onPick: ((AgentWire.SlashCommand) -> Void)?
    /// It opened, closed or changed its rows: lay the screen out again.
    var onChange: (() -> Void)?

    init(images: Images) {
        list.images = images
        list.isHidden = true
        list.accessibilityIdentifier = "slashPalette"
        list.onSelect = { [weak self] index in self?.pick(index) }
    }

    /// The draft or the agent's commands changed.
    func update(draft: String, catalog: [AgentWire.SlashCommand], agentId: String) {
        let query = SlashCommands.query(draft, in: catalog)
        guard query != self.query || catalog != self.catalog || agentId != self.agentId else { return }
        self.query = query
        self.catalog = catalog
        self.agentId = agentId
        let next = query.map { SlashCommands.suggestions($0, in: catalog, agentId: agentId) } ?? []
        selected = ComposerAutocomplete.selection(previous: selected, previousCount: items.count, count: next.count)
        items = next
        apply()
    }

    /// Return or Tab: the highlighted command, or the first; false with
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

    private func pick(_ index: Int) {
        guard items.indices.contains(index), case .agentCommand(let command, _) = items[index].kind else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onPick?(command)
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
