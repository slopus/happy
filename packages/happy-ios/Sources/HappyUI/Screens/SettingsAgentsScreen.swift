#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// Settings › Agents (app/(app)/settings/agents.tsx): the account's
/// computers, then the permission, model and effort new sessions start with
/// for each agent. A field opens its choices in place, one at a time.
public final class SettingsAgentsViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let list = GroupedListView()
    private var settingsObservation: StoreObservation?
    private var machinesObservation: StoreObservation?
    private var overrides: [String: JSONValue] = [:]
    private var machines: [MachineRecord] = []
    private var expanded: (agent: AgentDefaults.Agent, field: AgentDefaults.Field)?

    public init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = list
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Settings.agents
        showsBackTitle()
        settingsObservation = session.store.observeSettings { [weak self] snapshot in
            self?.overrides = AccountSettings(snapshot).agentDefaultOverrides
            self?.rebuild()
        }
        machinesObservation = session.store.observeMachines { [weak self] snapshot in
            self?.machines = snapshot.machines
            self?.rebuild()
        }
    }

    private func rebuild() {
        var sections: [UIView] = []

        let machineRows = AgentsPage.machineRows(machines, online: Strings.Status.online, offline: Strings.Status.offline)
        if machineRows.isEmpty {
            let row = ItemRowView(
                title: Strings.Agents.noMachines,
                subtitle: Strings.Agents.noMachinesSubtitle,
                icon: ItemIcon(.ionicons("desktop-outline"), tint: Palette.textSecondary)
            )
            row.alpha = 0.5
            sections.append(ItemGroupView(title: Strings.Agents.machines, rows: [row]))
        } else {
            sections.append(ItemGroupView(title: Strings.Agents.machines, rows: machineRows.map { machine in
                let row = ItemRowView(
                    title: machine.name,
                    subtitle: machine.subtitle,
                    icon: ItemIcon(.ionicons("desktop-outline"), tint: machine.online ? Palette.statusConnected : Palette.statusDisconnected)
                )
                if let id = machine.targetMachineId {
                    row.onTap = { [weak self] in
                        guard let self else { return }
                        self.push(.machine(id: id), context: self.context)
                    }
                }
                row.alpha = machine.online ? 1 : 0.5
                return row
            }))
        }

        let clear = ItemRowView(
            title: Strings.Agents.clearOverrides,
            subtitle: Strings.Agents.clearOverridesSubtitle,
            icon: ItemIcon(.ionicons("refresh-outline"), tint: Palette.iconOrange)
        ) { [weak self] in
            self?.update([:])
        }
        clear.showsChevron = false
        if overrides.isEmpty {
            clear.isEnabled = false
            clear.alpha = 0.5
        }
        sections.append(ItemGroupView(title: Strings.Agents.defaults, rows: [clear]))

        let cliVersion = AgentsPage.defaultsCLIVersion(machines)
        for agent in AgentDefaults.Agent.configurable {
            var rows: [ItemRowView] = []
            for field in AgentsPage.fields(agent, overrides: overrides, cliVersion: cliVersion) {
                let isExpanded = expanded?.agent == agent && expanded?.field == field.field
                rows.append(ItemRowView(
                    title: field.title,
                    detail: field.detail,
                    icon: ItemIcon(.ionicons(field.icon), tint: Palette.iconPurple)
                ) { [weak self] in
                    self?.expanded = isExpanded ? nil : (agent, field.field)
                    self?.rebuild()
                })
                guard isExpanded else { continue }
                rows.append(option(
                    title: Strings.Agents.useCodeDefault,
                    subtitle: field.codeDefaultName,
                    selected: !field.hasOverride
                ) { [weak self] in
                    self?.set(agent, field.field, nil)
                })
                for choice in field.options {
                    rows.append(option(
                        title: choice.name,
                        subtitle: choice.description,
                        selected: field.hasOverride && field.overrideValue == choice.key
                    ) { [weak self] in
                        self?.set(agent, field.field, choice.key)
                    })
                }
                if field.offersCustomModel {
                    rows.append(option(
                        title: Strings.Agents.customModel,
                        subtitle: field.customModel ?? Strings.Agents.customModelSubtitle,
                        selected: field.customModel != nil
                    ) { [weak self] in
                        self?.editCustomModel(field.customModel)
                    })
                }
            }
            sections.append(ItemGroupView(title: agent.name, rows: rows))
            // Each field is a Fragment in happy-app, which ItemGroup leaves
            // alone, so every row keeps Item's default divider, the last one
            // included.
            for row in rows { row.showsDivider = true }
        }
        list.sections = sections
    }

    private func option(title: String, subtitle: String?, selected: Bool, onTap: @escaping () -> Void) -> ItemRowView {
        let row = ItemRowView(title: title, subtitle: subtitle, onTap: onTap)
        row.showsChevron = false
        if selected {
            row.trailingView = SettingsCheckmark.view(tint: Palette.headerTint)
        }
        return row
    }

    private func set(_ agent: AgentDefaults.Agent, _ field: AgentDefaults.Field, _ value: String?) {
        update(AgentDefaults.setting(overrides, agent, field, to: value))
    }

    private func update(_ next: [String: JSONValue]) {
        overrides = next
        session.updateSettings(["agentDefaultOverrides": .object(next)])
        rebuild()
    }

    private func editCustomModel(_ current: String?) {
        let alert = UIAlertController(title: Strings.Agents.customModelTitle, message: Strings.Agents.customModelMessage, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = current ?? ""
            field.placeholder = Strings.Agents.customModelPlaceholder
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Common.save, style: .default) { [weak self, weak alert] _ in
            let model = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !model.isEmpty else { return }
            self?.set(.codex, .modelMode, model)
        })
        present(alert, animated: true)
    }
}
#endif
