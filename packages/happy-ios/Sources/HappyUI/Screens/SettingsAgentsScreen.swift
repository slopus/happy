#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Settings › Agents (app/(app)/settings/agents.tsx): the account's
/// computers, then the permission, model and effort new sessions start with
/// for each agent. A field opens its choices in place, one at a time.
public final class SettingsAgentsViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let list = GroupedListView()
    private var pipeline: ApplyPipeline<AgentsPage.Input, AgentsPage.Content?, AgentsPage.Update>?
    private var observation: ApplyObservation?
    private var groupViews: [AgentsPage.Group: ItemGroupView] = [:]
    /// The computers' rows on screen, by id, so a change rebuilds only its
    /// own row.
    private var machineRowViews: [String: ItemRowView] = [:]
    /// The language the screen was built in; its derivations speak it.
    private let language = AppLocalization.language

    public init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
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
        // The computers and every agent's fields are worked out off the
        // main thread; the screen rebuilds only the groups that changed.
        let pipeline = ApplyPipeline<AgentsPage.Input, AgentsPage.Content?, AgentsPage.Update>(
            input: AgentsPage.Input(language: language),
            state: nil,
            derive: { AgentsPage.derive($0, applied: $1) },
            apply: { [weak self] update in
                // Worked out for an account that is no longer the active
                // one, or in a language the screens no longer speak: they
                // are being built again.
                guard let self, self.context.account.session === self.session,
                      self.language == AppLocalization.language else { return false }
                ApplyPerf.measure(.screen) { self.apply(update) }
                return true
            }
        )
        pipeline.follow(session.settingsFeed.snapshots()) { input, snapshot in
            input.settings = snapshot
            input.chosen = nil
        }
        pipeline.follow(session.machinesFeed.snapshots()) { $0.machines = $1 }
        self.pipeline = pipeline
        observation = pipeline.observation
    }

    /// Builds the groups `update` names and puts them in their place, and
    /// patches the computers' rows it names; the rest is untouched. Returns
    /// the rows built or changed.
    private func apply(_ update: AgentsPage.Update) -> Int {
        let content = update.content
        var rows = 0
        if let changes = update.machineRows, let group = groupViews[.machines] {
            patch(group, changes)
            rows += changes.count
        }
        for group in update.rebuilt {
            let view: ItemGroupView
            switch group {
            case .machines:
                view = machinesGroup(content.machines)
            case .defaults:
                view = defaultsGroup(hasOverrides: content.hasOverrides)
            case .agent(let agent):
                guard let agentGroup = content.agents.first(where: { $0.agent == agent }) else { continue }
                view = self.agentGroup(agentGroup)
            }
            groupViews[group] = view
            rows += view.rows.count
        }
        list.sections = content.groups.compactMap { groupViews[$0] }
        return rows
    }

    private func machinesGroup(_ machines: [AgentsPage.MachineRow]) -> ItemGroupView {
        machineRowViews = [:]
        guard !machines.isEmpty else {
            let row = ItemRowView(
                title: Strings.Agents.noMachines,
                subtitle: Strings.Agents.noMachinesSubtitle,
                icon: ItemIcon(.ionicons("desktop-outline"), tint: Palette.textSecondary)
            )
            row.alpha = 0.5
            return ItemGroupView(title: Strings.Agents.machines, rows: [row])
        }
        return ItemGroupView(title: Strings.Agents.machines, rows: machines.map(machineRow))
    }

    private func machineRow(_ machine: AgentsPage.MachineRow) -> ItemRowView {
        let row = ItemRowView(title: machine.name)
        configure(row, machine)
        machineRowViews[machine.id] = row
        return row
    }

    private func configure(_ row: ItemRowView, _ machine: AgentsPage.MachineRow) {
        row.title = machine.name
        row.subtitle = machine.subtitle
        row.icon = ItemIcon(.ionicons("desktop-outline"), tint: machine.online ? Palette.statusConnected : Palette.statusDisconnected)
        row.onTap = machine.targetMachineId.map { id in
            { [weak self] in
                guard let self else { return }
                self.push(.machine(id: id), context: self.context)
            }
        }
        row.alpha = machine.online ? 1 : 0.5
    }

    /// The computers' group with only the rows `changes` names built or
    /// changed; the group takes its rows again only when their order did.
    private func patch(_ group: ItemGroupView, _ changes: AgentsPage.MachineRowChanges) {
        for id in changes.removed { machineRowViews.removeValue(forKey: id) }
        var resized = false
        for machine in changes.updated {
            guard let row = machineRowViews[machine.id] else { continue }
            configure(row, machine)
            // A row only re-lays out itself; the group measures again only
            // when one of the changed rows is now another height.
            let height = row.sizeThatFits(CGSize(width: row.bounds.width, height: .greatestFiniteMagnitude)).height
            if height != row.bounds.height { resized = true }
        }
        for machine in changes.inserted { _ = machineRow(machine) }
        if let order = changes.order {
            group.rows = order.compactMap { machineRowViews[$0] }
        } else if resized {
            group.setNeedsLayout()
            list.setNeedsLayout()
        }
    }

    private func defaultsGroup(hasOverrides: Bool) -> ItemGroupView {
        let clear = ItemRowView(
            title: Strings.Agents.clearOverrides,
            subtitle: Strings.Agents.clearOverridesSubtitle,
            icon: ItemIcon(.ionicons("refresh-outline"), tint: Palette.iconOrange)
        ) { [weak self] in
            self?.choose { $0 = [:] }
        }
        clear.showsChevron = false
        if !hasOverrides {
            clear.isEnabled = false
            clear.alpha = 0.5
        }
        return ItemGroupView(title: Strings.Agents.defaults, rows: [clear])
    }

    private func agentGroup(_ group: AgentsPage.AgentGroup) -> ItemGroupView {
        let agent = group.agent
        var rows: [ItemRowView] = []
        for field in group.fields {
            let open = AgentsPage.OpenField(agent, field.field)
            rows.append(ItemRowView(
                title: field.title,
                detail: field.detail,
                icon: ItemIcon(.ionicons(field.icon), tint: Palette.iconPurple)
            ) { [weak self] in
                self?.pipeline?.update { $0.open = $0.open == open ? nil : open }
            })
            guard group.open == field.field else { continue }
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
        let view = ItemGroupView(title: agent.name, rows: rows)
        // Each field is a Fragment in happy-app, which ItemGroup leaves
        // alone, so every row keeps Item's default divider, the last one
        // included.
        for row in rows { row.showsDivider = true }
        return view
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
        choose { $0 = AgentDefaults.setting($0, agent, field, to: value) }
    }

    /// Edits the overrides the page shows, the latest choice included even
    /// before it has drawn, and saves them.
    private func choose(_ change: (inout [String: JSONValue]) -> Void) {
        var next: [String: JSONValue]?
        pipeline?.update { input in
            var overrides = input.overrides
            change(&overrides)
            input.chosen = overrides
            next = overrides
        }
        guard let next else { return }
        session.updateSettings(["agentDefaultOverrides": .object(next)])
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
