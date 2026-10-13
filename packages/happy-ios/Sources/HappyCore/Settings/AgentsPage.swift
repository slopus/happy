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
        sortedChoices(machines).map { choice in
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
        sortedChoices(machines).first(where: { $0.happyMachine != nil })?
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
