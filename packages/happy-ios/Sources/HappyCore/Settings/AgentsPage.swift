import Foundation
import HappyStore
import HappyWire

/// Settings › Agents (app/(app)/settings/agents.tsx): the computers, then
/// each configurable agent's default permission, model and effort.
public enum AgentsPage {
    /// One computer under Machines.
    public struct MachineRow: Equatable, Sendable {
        public var id: String
        public var name: String
        /// `platform • online`, without the platform when it is unknown.
        public var subtitle: String
        public var online: Bool
        /// The machine a tap opens: a reachable daemon first, else the one
        /// the computer is named after.
        public var targetMachineId: String?
    }

    /// Computers online first, then the most recently active.
    public static func machineRows(_ machines: [MachineRecord], online: String, offline: String) -> [MachineRow] {
        machineRows(sorted: sortedChoices(machines), online: online, offline: offline)
    }

    private static func machineRows(sorted: [MachineChoice], online: String, offline: String) -> [MachineRow] {
        sorted.map { choice in
            let machine = choice.happyMachine ?? choice.rigMachine
            let platform = machine?.metadata?["platform"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            let status = choice.online ? online : offline
            let subtitle = [platform, status].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " • ")
            let target = [choice.happyMachine, choice.rigMachine].compactMap { $0 }.first(where: \.active) ?? machine
            return MachineRow(id: choice.id, name: choice.name, subtitle: subtitle, online: choice.online, targetMachineId: target?.id)
        }
    }

    /// The CLI the code defaults are described for: the first listed
    /// computer's Happy CLI, which is where a new session most likely starts.
    public static func defaultsCLIVersion(_ machines: [MachineRecord]) -> String? {
        defaultsCLIVersion(sorted: sortedChoices(machines))
    }

    private static func defaultsCLIVersion(sorted: [MachineChoice]) -> String? {
        sorted.first(where: { $0.happyMachine != nil })?
            .happyMachine?.metadata?["happyCliVersion"]?.stringValue
    }

    static func sortedChoices(_ machines: [MachineRecord]) -> [MachineChoice] {
        // Array.sort isn't stable; the index keeps ties in collect order, as
        // JavaScript's stable sort does.
        MachineChoice.collect(machines).enumerated().sorted { left, right in
            if left.element.online != right.element.online { return left.element.online }
            if left.element.activeAt != right.element.activeAt { return left.element.activeAt > right.element.activeAt }
            return left.offset < right.offset
        }.map(\.element)
    }

    /// One field row of an agent's group and the choices it opens.
    public struct FieldRow: Equatable, Sendable {
        public var field: AgentDefaults.Field
        public var title: String
        /// The Ionicons name.
        public var icon: String
        /// The override's name, or `Default (code default)`.
        public var detail: String
        public var options: [AgentDefaults.Option]
        /// "Use code default"'s subtitle.
        public var codeDefaultName: String
        public var hasOverride: Bool
        public var overrideValue: String?
        /// Codex's free-form model: an override that is not in `options`.
        public var customModel: String?
        public var offersCustomModel: Bool
    }

    /// The fields an agent shows: permission always, model and effort when
    /// the agent has any.
    public static func fields(
        _ agent: AgentDefaults.Agent,
        overrides: [String: JSONValue],
        cliVersion: String?
    ) -> [FieldRow] {
        let code = AgentDefaults.codeDefaults(agent, cliVersion: cliVersion)
        let effective = AgentDefaults.resolve(overrides, agent, cliVersion: cliVersion)
        let configs: [(AgentDefaults.Field, String, String, [AgentDefaults.Option])] = [
            (.permissionMode, "Permission", "shield-checkmark-outline", AgentDefaults.permissionModes(agent)),
            (.modelMode, "Model", "hardware-chip-outline", AgentDefaults.modelModes(agent, configured: effective.modelMode)),
            (.effortLevel, "Effort", "speedometer-outline", AgentDefaults.effortLevels(agent, model: effective.modelMode)),
        ]
        return configs.compactMap { field, title, icon, options in
            if field != .permissionMode && options.isEmpty { return nil }
            let overrideValue = AgentDefaults.override(overrides, agent, field)
            let hasOverride = overrideValue != nil
            let detail = hasOverride
                ? AgentDefaults.optionName(options, overrideValue)
                : "Default (\(AgentDefaults.optionName(options, effective[field])))"
            let offersCustom = agent == .codex && field == .modelMode
            let isCustom = offersCustom && overrideValue?.isEmpty == false && !options.contains { $0.key == overrideValue }
            return FieldRow(
                field: field,
                title: title,
                icon: icon,
                detail: detail,
                options: options,
                codeDefaultName: AgentDefaults.optionName(options, code[field]),
                hasOverride: hasOverride,
                overrideValue: overrideValue,
                customModel: isCustom ? overrideValue : nil,
                offersCustomModel: offersCustom
            )
        }
    }
}

// MARK: Off the main thread

extension AgentsPage {
    /// The field showing its choices; one at a time across the page.
    public struct OpenField: Equatable, Sendable {
        public var agent: AgentDefaults.Agent
        public var field: AgentDefaults.Field

        public init(_ agent: AgentDefaults.Agent, _ field: AgentDefaults.Field) {
            self.agent = agent
            self.field = field
        }
    }

    /// What the page is worked out from: the account's settings and
    /// machines feeds, and what the reader did on the page.
    public struct Input: Sendable {
        public var settings: SettingsSnapshot?
        public var machines: MachinesSnapshot?
        /// Overrides chosen here, shown until the settings feed speaks again
        /// (agents.tsx writes them to its local settings at once).
        public var chosen: [String: JSONValue]?
        public var open: OpenField?
        /// `status.online` and `status.offline`, for the computers' subtitles.
        public var online: String
        public var offline: String

        public init(online: String, offline: String) {
            self.online = online
            self.offline = offline
        }

        /// The overrides the page shows, and a choice edits.
        public var overrides: [String: JSONValue] {
            chosen ?? settings.map { AccountSettings($0).agentDefaultOverrides } ?? [:]
        }
    }

    /// One agent's group: its fields and, when it is this agent's, the one
    /// showing its choices.
    public struct AgentGroup: Equatable, Sendable {
        public var agent: AgentDefaults.Agent
        public var fields: [FieldRow]
        public var open: AgentDefaults.Field?
    }

    /// A group of the page.
    public enum Group: Hashable, Sendable {
        case machines
        case defaults
        case agent(AgentDefaults.Agent)
    }

    /// agents.tsx reduced to what it draws.
    public struct Content: Equatable, Sendable {
        public var machines: [MachineRow]
        /// "Clear all overrides" is enabled.
        public var hasOverrides: Bool
        public var agents: [AgentGroup]

        public init(overrides: [String: JSONValue], machines: [MachineRecord], open: OpenField?, online: String, offline: String) {
            let sorted = AgentsPage.sortedChoices(machines)
            let cliVersion = AgentsPage.defaultsCLIVersion(sorted: sorted)
            self.machines = AgentsPage.machineRows(sorted: sorted, online: online, offline: offline)
            self.hasOverrides = !overrides.isEmpty
            self.agents = AgentDefaults.Agent.configurable.map { agent in
                AgentGroup(
                    agent: agent,
                    fields: AgentsPage.fields(agent, overrides: overrides, cliVersion: cliVersion),
                    open: open?.agent == agent ? open?.field : nil
                )
            }
        }

        /// The groups in the order they show.
        public var groups: [Group] {
            [.machines, .defaults] + agents.map { .agent($0.agent) }
        }
    }

    public struct Update: Sendable {
        public var content: Content
        /// The groups to build (again); the rest stay as they are on screen.
        public var rebuilt: Set<Group>
    }

    /// The page for `input` and the groups that differ from `applied`, the
    /// page on screen. Nothing until both feeds have spoken, so the page
    /// never shows "no machines" for machines it hasn't read yet, and nothing
    /// when what it draws is unchanged: a heartbeat that leaves the
    /// computers' order and status alone derives nothing.
    public static func derive(_ input: Input, applied: Content?) -> (output: Update, state: Content)? {
        guard input.settings != nil, let machines = input.machines else { return nil }
        let content = Content(
            overrides: input.overrides,
            machines: machines.machines,
            open: input.open,
            online: input.online,
            offline: input.offline
        )
        guard content != applied else { return nil }
        return (Update(content: content, rebuilt: rebuilt(from: applied, to: content)), content)
    }

    static func rebuilt(from old: Content?, to new: Content) -> Set<Group> {
        guard let old else { return Set(new.groups) }
        var groups: Set<Group> = []
        if old.machines != new.machines { groups.insert(.machines) }
        if old.hasOverrides != new.hasOverrides { groups.insert(.defaults) }
        for group in new.agents where !old.agents.contains(group) {
            groups.insert(.agent(group.agent))
        }
        return groups
    }
}
