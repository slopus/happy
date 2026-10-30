#if canImport(UIKit)
import HappyLayout
import UIKit

/// The existing picker panels also host chip menus. Unlike a system context
/// menu, this overlay leaves the text view and its keyboard window in place.
@MainActor
final class ComposerMenuPresenter {
    private struct Page {
        var title: String
        var chip: AgentInputChip?
        var menu: AgentInputMenu?
        var sections: [AgentInputMenu.Section]
        var path: [String] = []
    }
    private weak var card: AgentInputCardView?
    private var chips: [(AgentInputChip, AgentInputChipConfiguration)]
    private let overlay = PickerOverlay()
    private var pages: [Page] = []
    var onSelect: ((String, AgentInputChip) -> Void)?
    var onPress: ((AgentInputChip) -> Void)?
    var onMenu: ((AgentInputChip) -> Void)?
    var anchor: (() -> CGRect)?
    var opensBelowAnchor = false
    var title = Strings.Composer.options
    var rootID = "composer-options-panel"
    var pageID = "composer-chip-panel"
    var top: (() -> CGFloat)?
    var bottom: (() -> CGFloat)?
    var rootActions: [PickerContent.Line] = []
    var onRootAction: ((String) -> Void)?

    init(card: AgentInputCardView, chips: [(AgentInputChip, AgentInputChipConfiguration)]) {
        self.card = card
        self.chips = chips
        overlay.onOutside = { [weak self] in self?.back() }
        overlay.onLayout = { [weak self] in self?.follow() }
    }

    func show(in host: UIView, chip: AgentInputChip? = nil) {
        overlay.frame = host.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(overlay)
        if let chip, let configuration = chips.first(where: { $0.0 == chip })?.1, let menu = configuration.menu {
            push(Page(title: configuration.accessibilityLabel, chip: chip, menu: menu, sections: menu.sections))
            onMenu?(chip)
        } else {
            push(Page(title: title, chip: nil, menu: nil, sections: []))
        }
    }

    func close() {
        overlay.removeFromSuperview()
        if let card { UIAccessibility.post(notification: .screenChanged, argument: card.textView) }
    }

    func update(chips: [(AgentInputChip, AgentInputChipConfiguration)]) {
        guard !chips.elementsEqual(self.chips, by: { $0.0 == $1.0 && $0.1 == $1.1 }) else { return }
        self.chips = chips
        for index in pages.indices {
            guard let chip = pages[index].chip else { continue }
            guard let configuration = chips.first(where: { $0.0 == chip })?.1, let menu = configuration.menu else { return close() }
            var sections = menu.sections
            for key in pages[index].path {
                guard let option = sections.flatMap(\.options).first(where: { $0.key == key }), !option.children.isEmpty else { return close() }
                sections = option.children
            }
            pages[index].menu = menu
            pages[index].sections = sections
        }
        follow()
    }

    func follow() {
        guard let card, overlay.superview != nil else { return }
        let cardFrame = card.convert(card.bounds, to: overlay)
        let bounds = ComposerPanelLayout.available(size: overlay.bounds.size, safeArea: LayoutInsets(overlay.safeAreaInsets), top: top?(), bottom: bottom?() ?? cardFrame.maxY)
        let anchor = anchor?() ?? card.chipFrame(pages.last?.chip ?? .model, in: overlay) ?? cardFrame
        for (index, panel) in overlay.panels.enumerated() {
            let content = content(for: pages[index])
            let width = min(PickerType.panelWidth(content), bounds.width - 2 * PickerMetrics.margin)
            let items = content.lines.map { PickerType.item($0, width: width) }
            let layout = opensBelowAnchor
                ? PickerPanelLayout(items: items, width: width, below: anchor, in: bounds, selected: content.selected)
                : PickerPanelLayout(items: items, width: width, over: anchor, in: bounds, selected: content.selected)
            panel.apply(content, layout: layout, opening: panel.content == nil)
        }
    }

    private func content(for page: Page) -> PickerContent {
        var lines: [PickerContent.Line] = []
        if page.chip == nil {
            lines = chips.enumerated().map { index, entry in
                .option(key: "chip:\(index)", label: entry.1.accessibilityLabel, checked: false, disabled: !entry.1.opensPicker && entry.1.menu == nil, gauge: nil)
            }
            lines += rootActions
        } else {
            for section in page.sections {
                if !lines.isEmpty { lines.append(.separator) }
                if let title = section.title, !title.isEmpty { lines.append(.notice(title, warning: false)) }
                for option in section.options {
                    lines.append(.option(key: option.key, label: option.label, checked: option.isChecked || option.key == page.menu?.selectedKey, disabled: option.isDisabled, gauge: nil))
                    if let subtitle = option.subtitle { lines.append(.notice(subtitle, warning: false)) }
                }
            }
        }
        return PickerContent(id: page.chip == nil ? rootID : pageID, label: page.title, lines: lines, minWidth: 240, maxWidth: 360)
    }

    private func push(_ page: Page) {
        pages.append(page)
        let panel = PickerPanelView()
        panel.accessibilityViewIsModal = true
        panel.onTap = { [weak self] line in self?.tapped(line) }
        overlay.panels.last?.accessibilityElementsHidden = true
        overlay.push(panel)
        follow()
        overlay.grow(panel)
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    private func tapped(_ line: PickerContent.Line) {
        guard case .option(let key, _, _, let disabled, _) = line, !disabled, let page = pages.last else { return }
        if page.chip == nil {
            if !key.hasPrefix("chip:") { close(); onRootAction?(key); return }
            guard let index = Int(key.dropFirst("chip:".count)), chips.indices.contains(index) else { return }
            let (chip, configuration) = chips[index]
            if configuration.opensPicker { close(); onPress?(chip) }
            else if let menu = configuration.menu {
                push(Page(title: configuration.accessibilityLabel, chip: chip, menu: menu, sections: menu.sections))
                onMenu?(chip)
            }
        } else if let chip = page.chip, let option = page.sections.flatMap(\.options).first(where: { $0.key == key }) {
            if option.children.isEmpty { close(); onSelect?(key, chip) }
            else { push(Page(title: option.label, chip: chip, menu: page.menu, sections: option.children, path: page.path + [option.key])) }
        }
    }

    private func back() {
        guard pages.count > 1 else { return close() }
        pages.removeLast()
        overlay.pop(animated: true)
        overlay.panels.last?.accessibilityElementsHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: overlay.panels.last)
    }
}
#endif