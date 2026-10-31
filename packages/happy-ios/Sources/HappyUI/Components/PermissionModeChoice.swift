#if canImport(UIKit)
import UIKit

/// A chat's permission modes as its profile offers them, now that the chat's
/// header has no More menu: the modes its composer offers, the current one
/// checked, and a pick that goes the composer's own way (`select`), so it is
/// kept and reaches the computer as a pick in the chat always did.
@MainActor
public struct PermissionModeChoice {
    public var menu: AgentInputMenu
    public var select: (String) -> Void

    /// The checked mode's name: the profile row's value.
    var current: String? {
        let options = menu.sections.flatMap(\.options)
        return options.first { $0.isChecked || $0.key == menu.selectedKey }?.label
    }

    /// The modes as a native menu, ticked; `picked` runs after a pick.
    func uiMenu(picked: @escaping () -> Void) -> UIMenu {
        let select = select
        let menu = UIMenu(menu) { key in
            select(key)
            picked()
        }
        return UIMenu(title: Strings.ChatActions.permissionMode, identifier: .init("chat-permissions"), children: menu.children)
    }
}

/// A clear button over a whole row, opening its menu as a pull-down from
/// the row: how a profile row picks from a few choices, as Settings'
/// pop-up rows do. The row under it draws everything.
final class MenuRowButton: UIButton {
    /// Asked each time it opens, so the ticks are always the current ones.
    var menuFor: (() -> UIMenu?)? {
        didSet { applyMenu() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        showsMenuAsPrimaryAction = true
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        applyMenu()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyMenu() {
        menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.menuFor?()?.children ?? [])
        }])
    }
}
#endif
