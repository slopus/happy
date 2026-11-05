package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelPreferences
import com.slopus.happy.conversation.NewSessionStart
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.conversation.permissionName
import kotlinx.serialization.Serializable

@Serializable data class AgentAgentsRoute(val connectionId: String)

object AgentAgentsTags {
    const val ROW = "agentSettings.agents"
    const val START = "agents.start"
    const val MODEL = "agents.model"
    const val EFFORT = "agents.effort"
    const val ACCESS = "agents.access"
    /** One choice in a row's menu: the row's tag, then the choice. */
    fun choice(row: String, key: String) = "$row.$key"
}

/** The computer's models as the page reads them: still reading, unreadable, or read. */
@Immutable
sealed interface AgentModelsCatalog {
    data object Loading : AgentModelsCatalog
    data object Failed : AgentModelsCatalog
    data class Ready(val catalog: ModeCatalog) : AgentModelsCatalog
}

/** One model the default can be: its id, its name, and the accounts that serve it. */
@Immutable
data class DefaultModelOption(val modelId: String, val name: String, val accounts: String)

/** Every model an account on, and shown, offers for picking: one row per model, however many accounts serve it. */
fun defaultModelOptions(catalog: ModeCatalog): List<DefaultModelOption> {
    val byModel = LinkedHashMap<String, Pair<String, MutableList<String>>>()
    for (provider in catalog.providers) {
        if (provider.isDisabled || provider.hidden) continue
        for (model in provider.models) {
            if (model.modelId in provider.hiddenModels) continue
            val entry = byModel.getOrPut(model.modelId) { model.name to ArrayList() }
            if (model.providerName !in entry.second) entry.second += model.providerName
        }
    }
    return byModel.map { (id, entry) -> DefaultModelOption(id, entry.first, entry.second.joinToString(", ")) }
}

/** One choice of a row's menu, with the line under it. */
@Immutable
private data class Choice(val key: String, val label: String, val supporting: String? = null)

/**
 * An agent connection's Agents (the relay's Agents row, iOS's too): desktop's
 * General > New sessions (44ce0c8c) in its order, each value a drop-down,
 * each description its card's footer, as iOS lays them out. What a row shows
 * is what a new chat would start on now, after every fallback
 * ([ModelPreferences.startMode]). They are the person's own user settings on
 * the agent, so they follow them to every device.
 */
@Composable
fun AgentAgentsScreen(
    preferences: ModelPreferences,
    catalog: AgentModelsCatalog,
    onStart: (NewSessionStart) -> Unit,
    onModel: (String) -> Unit,
    onEffort: (String) -> Unit,
    onAccess: (String) -> Unit,
    onBack: () -> Unit,
) {
    val follows = preferences.start == NewSessionStart.LastSession
    val ready = catalog as? AgentModelsCatalog.Ready
    val start = ready?.catalog?.let(preferences::startMode)
    val startNames = listOf(
        NewSessionStart.LastSession to stringResource(R.string.agent_settings_new_sessions_last),
        NewSessionStart.DefaultModel to stringResource(R.string.agent_settings_new_sessions_default),
    )
    AgentPage(stringResource(R.string.settings_agents), onBack) {
        ItemGroup(footer = stringResource(if (follows) R.string.agent_settings_new_sessions_last_description else R.string.agent_settings_new_sessions_default_description)) {
            ChoiceRow(
                tag = AgentAgentsTags.START,
                title = stringResource(R.string.agent_settings_new_sessions_start),
                detail = startNames.first { it.first == preferences.start }.second,
                choices = startNames.map { (start, name) -> Choice(start.name, name) },
                selected = preferences.start.name,
                onSelect = { key -> onStart(NewSessionStart.valueOf(key)) },
            )
        }
        ItemGroup(footer = stringResource(if (follows) R.string.agent_settings_default_model_last_description else R.string.agent_settings_default_model_default_description)) {
            when (catalog) {
                AgentModelsCatalog.Loading -> Item(stringResource(R.string.agent_settings_new_sessions_default), loading = true)
                AgentModelsCatalog.Failed -> Item(stringResource(R.string.agent_settings_new_sessions_unreadable), titleLines = 0)
                is AgentModelsCatalog.Ready -> {
                    val models = defaultModelOptions(catalog.catalog)
                    val model = start?.let { catalog.catalog.model(it.providerId, it.modelId) }
                    ChoiceRow(
                        tag = AgentAgentsTags.MODEL,
                        title = stringResource(R.string.agent_settings_new_sessions_default),
                        detail = model?.name ?: start?.modelId,
                        choices = models.map { Choice(it.modelId, it.name, it.accounts) },
                        selected = start?.modelId,
                        onSelect = onModel,
                    )
                    val efforts = model?.efforts.orEmpty()
                    if (efforts.isNotEmpty()) {
                        ChoiceRow(
                            tag = AgentAgentsTags.EFFORT,
                            title = stringResource(R.string.agent_settings_default_effort),
                            detail = start?.effort?.let(ModeOptions::effortDisplayName),
                            choices = efforts.map { Choice(it, ModeOptions.effortDisplayName(it)) },
                            selected = start?.effort,
                            onSelect = onEffort,
                        )
                    }
                }
            }
        }
        ItemGroup(footer = stringResource(R.string.agent_settings_default_access_description)) {
            val access = preferences.permissionMode
            ChoiceRow(
                tag = AgentAgentsTags.ACCESS,
                title = stringResource(R.string.agent_settings_default_access),
                detail = permissionName(access),
                choices = ModeCatalog.PERMISSION_MODES.map { Choice(it, permissionName(it)) },
                selected = access,
                onSelect = onAccess,
            )
        }
    }
}

/** A row whose value is picked from a drop-down under it, the chosen one checked. */
@Composable
private fun ChoiceRow(tag: String, title: String, detail: String?, choices: List<Choice>, selected: String?, onSelect: (String) -> Unit) {
    var open by rememberSaveable(tag) { mutableStateOf(false) }
    Box {
        Item(title = title, detail = detail, showChevron = false, onClick = { open = true }, modifier = Modifier.testTag(tag))
        HappyDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (choice in choices) {
                HappyMenuItem(
                    label = choice.label,
                    supporting = choice.supporting,
                    selected = choice.key == selected,
                    modifier = Modifier.testTag(AgentAgentsTags.choice(tag, choice.key)),
                    onClick = {
                        open = false
                        if (choice.key != selected) onSelect(choice.key)
                    },
                )
            }
        }
    }
}
