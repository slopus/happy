package com.slopus.happy.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.model.AgentType
import com.slopus.happy.model.Machine
import com.slopus.happy.model.MachineChoice
import com.slopus.happy.model.settings.AgentDefaultField
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.settings.AgentKey
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import androidx.compose.ui.unit.dp

object AgentsTags {
    const val CHECK = "agents.check"
}

/** settings/agents.tsx: field icons are #5856D6, Clear Overrides #FF9500, checkmarks 20. */
object AgentsSpec {
    val fieldIcon = Color(0xFF5856D6)
    val clearIcon = Color(0xFFFF9500)
    val check = 20.dp
}

/** A retired harness keeps its stored defaults, but there is nothing to configure for it. */
private val configurableAgents = AgentKey.entries.filter { AgentType.fromWire(it.wire)?.retired != true }

/** optionName: the option's name, the raw key when unlisted, "none" without one. */
private fun optionName(options: List<ModeOption>, key: String?): String =
    if (key.isNullOrEmpty()) "none" else options.find { it.key == key }?.name ?: key

/** The machines group's order: online first, then most recently active. */
fun sortAgentMachines(choices: List<MachineChoice>): List<MachineChoice> =
    choices.sortedWith(compareByDescending<MachineChoice> { it.online }.thenByDescending { it.activeAt })

/** The CLI version code defaults are described for: the first listed computer with Happy CLI. */
fun agentDefaultsCliVersion(sorted: List<MachineChoice>): String? =
    sorted.firstNotNullOfOrNull { it.happyMachine }?.metadata?.happyCliVersion

private data class FieldConfig(
    val field: AgentDefaultField,
    val title: String,
    val icon: Ionicon,
    val options: List<ModeOption>,
    val codeDefaultKey: String?,
)

/**
 * Settings > Agents (settings/agents.tsx).
 *
 * Machines: one row per computer ([machines], already sorted by
 * [sortAgentMachines]), a desktop icon in the connected or disconnected
 * colour, "platform • online" under the name, offline rows at 50%; tapping
 * opens the online daemon's machine, else the computer's own. With none, a
 * disabled "No connected machines" row. Defaults: Clear Overrides, disabled
 * while nothing is overridden. Then a group per configurable agent, titled
 * with its harness name: Permission, Model (when the agent has models) and
 * Effort (when the effective model has levels). A field's detail is the
 * override's name or "Default (code default)"; tapping expands it, one at a
 * time, into "Use code default" and every option, the chosen one with a 20
 * checkmark in the header tint. Codex models end with "Custom model…", which
 * asks for an exact model ID. Strings are happy-app's, untranslated.
 */
@Composable
fun AgentsScreen(
    machines: List<MachineChoice>,
    overrides: AgentDefaultOverrides,
    onOverridesChange: (AgentDefaultOverrides) -> Unit,
    onMachine: (Machine) -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    var expanded by remember { mutableStateOf<Pair<AgentKey, AgentDefaultField>?>(null) }
    var customModel by remember { mutableStateOf<String?>(null) }
    val cliVersion = agentDefaultsCliVersion(machines)
    val online = stringResource(R.string.status_online)
    val offline = stringResource(R.string.status_offline)

    fun update(agent: AgentKey, field: AgentDefaultField, value: String?) =
        onOverridesChange(AgentDefaults.set(overrides, agent.wire, field, value))

    val check: @Composable () -> Unit = { Icon(Ionicon.Checkmark, AgentsSpec.check, colors.header.tint, Modifier.testTag(AgentsTags.CHECK)) }

    @Composable
    fun Option(title: String, subtitle: String?, selected: Boolean, onClick: () -> Unit) {
        Item(
            title = title,
            subtitle = subtitle,
            onClick = onClick,
            showChevron = false,
            rightElement = if (selected) check else null,
        )
    }

    @Composable
    fun Field(agent: AgentKey, config: FieldConfig) {
        val effective = AgentDefaults.resolve(overrides, agent.wire, cliVersion)
        val effectiveValue = when (config.field) {
            AgentDefaultField.PermissionMode -> effective.permissionMode
            AgentDefaultField.ModelMode -> effective.modelMode
            AgentDefaultField.EffortLevel -> effective.effortLevel
        }
        val overrideValue = AgentDefaults.overrideValue(overrides, agent.wire, config.field)
        val hasOverride = AgentDefaults.hasOverride(overrides, agent.wire, config.field)
        val isExpanded = expanded == agent to config.field
        val detail = if (hasOverride) optionName(config.options, overrideValue) else "Default (${optionName(config.options, effectiveValue)})"
        val isCustomCodexModel = agent == AgentKey.Codex && config.field == AgentDefaultField.ModelMode &&
            !overrideValue.isNullOrEmpty() && config.options.none { it.key == overrideValue }

        Item(
            title = config.title,
            detail = detail,
            icon = { ItemIcon(config.icon, AgentsSpec.fieldIcon) },
            onClick = { expanded = if (isExpanded) null else agent to config.field },
        )
        if (isExpanded) {
            Option("Use code default", optionName(config.options, config.codeDefaultKey), !hasOverride) { update(agent, config.field, null) }
            for (option in config.options) {
                Option(option.name, option.description, hasOverride && overrideValue == option.key) { update(agent, config.field, option.key) }
            }
            if (agent == AgentKey.Codex && config.field == AgentDefaultField.ModelMode) {
                Option("Custom model…", if (isCustomCodexModel) overrideValue else "Enter an exact model ID", isCustomCodexModel) {
                    customModel = if (isCustomCodexModel) overrideValue else ""
                }
            }
        }
    }

    Screen(header = { StackHeader("Agents", onBack) }) {
        ItemList {
            ItemGroup(title = "Machines") {
                if (machines.isEmpty()) {
                    Item(
                        title = "No connected machines",
                        subtitle = "Run Happy on a computer to connect it",
                        icon = { ItemIcon(Ionicon.DesktopOutline, colors.textSecondary) },
                        enabled = false,
                        showChevron = false,
                    )
                }
                for (choice in machines) {
                    val machine = choice.happyMachine ?: choice.rigMachine
                    val platform = machine?.metadata?.platform?.trim()
                    val subtitle = listOfNotNull(platform?.takeIf { it.isNotEmpty() }, if (choice.online) online else offline).joinToString(" • ")
                    val target = listOfNotNull(choice.happyMachine, choice.rigMachine).find { it.isOnline } ?: machine
                    Item(
                        title = choice.name,
                        subtitle = subtitle,
                        icon = { ItemIcon(Ionicon.DesktopOutline, if (choice.online) colors.status.connected else colors.status.disconnected) },
                        onClick = target?.let { { onMachine(it) } },
                        modifier = Modifier.alpha(if (choice.online) 1f else 0.5f),
                    )
                }
            }

            ItemGroup(title = "Defaults") {
                Item(
                    title = "Clear Overrides",
                    subtitle = "Return every agent to code defaults",
                    icon = { ItemIcon(Ionicon.RefreshOutline, AgentsSpec.clearIcon) },
                    onClick = { onOverridesChange(AgentDefaultOverrides()) },
                    enabled = overrides.agents.isNotEmpty() || overrides.unknown.isNotEmpty(),
                    showChevron = false,
                )
            }

            for (agent in configurableAgents) {
                val code = AgentDefaults.codeDefaults(agent.wire, cliVersion)
                val effective = AgentDefaults.resolve(overrides, agent.wire, cliVersion)
                val models = ModeOptions.includeConfiguredModel(agent.wire, ModeOptions.modelModes(agent.wire), effective.modelMode)
                    .filter { it.key != "default" }
                val efforts = ModeOptions.effortLevelsForModel(agent.wire, effective.modelMode)
                val fields = buildList {
                    add(FieldConfig(AgentDefaultField.PermissionMode, "Permission", Ionicon.ShieldCheckmarkOutline, ModeOptions.permissionModes(agent.wire, resources::getString), code.permissionMode))
                    if (models.isNotEmpty()) add(FieldConfig(AgentDefaultField.ModelMode, "Model", Ionicon.HardwareChipOutline, models, code.modelMode))
                    if (efforts.isNotEmpty()) add(FieldConfig(AgentDefaultField.EffortLevel, "Effort", Ionicon.SpeedometerOutline, efforts, code.effortLevel))
                }
                ItemGroup(title = AgentType.harnessName(agent.wire)) {
                    Column {
                        for (field in fields) Field(agent, field)
                    }
                }
            }
        }
    }

    customModel?.let { current ->
        PromptModal(
            prompt = Prompt(
                title = "Custom Codex model",
                message = "Enter an exact model ID. Availability depends on your Codex account or API configuration.",
                placeholder = "model-id",
                defaultValue = current,
                confirmText = "Save",
                onResult = { value ->
                    val model = value?.trim()
                    if (!model.isNullOrEmpty()) update(AgentKey.Codex, AgentDefaultField.ModelMode, model)
                },
            ),
            onDismiss = { customModel = null },
        )
    }
}
