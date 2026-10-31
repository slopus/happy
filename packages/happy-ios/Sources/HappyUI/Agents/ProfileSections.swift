#if canImport(UIKit)
import HappyLayout
import UIKit

/// One card of a profile's: Settings' rows, a heading over it or not, and
/// a block under the rows the card's width (raw JSON).
struct ProfileSection {
    var id: String
    var heading: String?
    var rows: [SettingsRow]
    var block: UIView?

    init(id: String, heading: String? = nil, rows: [SettingsRow], block: UIView? = nil) {
        self.id = id
        self.heading = heading
        self.rows = rows
        self.block = block
    }
}

/// The cards under a profile's tiles, the agent chat's controls and a
/// legacy session's groups alike, in `container` (the screen's scroll), at
/// `SessionDetailLayout`'s frames. A card stays the same view while its
/// section does, so new rows reconfigure the ones it has in place.
@MainActor
final class ProfileSections {
    private weak var container: UIView?
    private var headings: [String: UILabel] = [:]
    private var cards: [String: SettingsCardView] = [:]
    private var blocks: [String: UIView] = [:]

    private(set) var sections: [ProfileSection] = []

    init(in container: UIView) { self.container = container }

    func show(_ sections: [ProfileSection]) {
        self.sections = sections
        let ids = Set(sections.map(\.id))
        for (id, card) in cards where !ids.contains(id) {
            card.removeFromSuperview()
            cards[id] = nil
        }
        for (id, heading) in headings where !ids.contains(id) || sections.first(where: { $0.id == id })?.heading == nil {
            heading.removeFromSuperview()
            headings[id] = nil
        }
        for section in sections {
            if let text = section.heading {
                let label = headings[section.id] ?? {
                    let label = DetailTileView.heading()
                    container?.addSubview(label)
                    headings[section.id] = label
                    return label
                }()
                label.text = text.uppercased()
            }
            if cards[section.id] == nil {
                let card = SettingsCardView()
                card.accessibilityIdentifier = "profile-section:\(section.id)"
                container?.addSubview(card)
                cards[section.id] = card
            }
            if blocks[section.id] !== section.block {
                blocks[section.id]?.removeFromSuperview()
                blocks[section.id] = section.block
                if let block = section.block { cards[section.id]?.addSubview(block) }
            }
        }
    }

    /// The sections as the layout takes them, a block measured at the
    /// cards' width.
    func specs(width: CGFloat) -> [SessionDetailLayout.Section] {
        let cardWidth = max(0, width - 2 * SessionDetailLayout.Metrics.side)
        return sections.map { section in
            SessionDetailLayout.Section(
                heading: section.heading != nil,
                rows: section.rows.map(SettingsCardView.spec),
                block: section.block.map { $0.sizeThatFits(CGSize(width: cardWidth, height: .greatestFiniteMagnitude)).height }
            )
        }
    }

    /// Where the layout put them, by `sections`' order.
    func place(_ frames: [SessionDetailLayout.SectionFrames]) {
        for (section, frame) in zip(sections, frames) {
            if let rect = frame.heading { headings[section.id]?.frame = rect }
            guard let card = cards[section.id] else { continue }
            if card.frame != frame.card.frame { card.frame = frame.card.frame }
            card.show(section.rows, layout: frame.card)
            if let rect = frame.block, let block = blocks[section.id], block.frame != rect { block.frame = rect }
        }
    }

    /// The card a section is drawn on (tests).
    func card(_ id: String) -> SettingsCardView? { cards[id] }
}
#endif
