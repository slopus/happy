package com.slopus.happy.ui.vaults

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptInputType
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.vaults.VaultEvent
import com.slopus.happy.vaults.VaultRetention
import com.slopus.happy.vaults.VaultRetentionPreset
import com.slopus.happy.vaults.VaultRetentionTier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

object VaultSettingsTags {
    const val SCREEN = "vault.settings"
    fun preset(preset: VaultRetentionPreset) = "vault.settings.preset.${preset.name}"
    fun trash(days: Int?) = "vault.settings.trash.${days ?: "never"}"
    const val KEEP_ALL = "vault.settings.keepAll"
    const val MAX_VERSIONS = "vault.settings.maxVersions"
    const val MAX_AGE = "vault.settings.maxAge"
    const val ADD_TIER = "vault.settings.addTier"
    fun tier(index: Int) = "vault.settings.tier.$index"
}

internal class VaultSettingsModel(val session: AgentSession, val surfaceId: String) : ViewModel() {
    data class State(val retention: VaultRetention? = null, val error: Problem? = null, val failed: Problem? = null)

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()
    private var saving = 0

    init {
        viewModelScope.launch {
            read()
            session.vaults.events.collect { event ->
                if ((event is VaultEvent.SettingsUpdated && event.surfaceId == surfaceId) || event == VaultEvent.Resync) {
                    if (saving == 0) read()
                }
            }
        }
    }

    private suspend fun read() {
        try {
            val settings = session.vaults.routes.settings(surfaceId)
            stateFlow.update { it.copy(retention = settings.retention, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (stateFlow.value.retention == null) stateFlow.update { it.copy(error = Conversation.describe(e)) }
        }
    }

    /** Shows [retention] at once and saves it whole; the latest edit wins. A refusal says why and shows what the vault has. */
    fun save(retention: VaultRetention) {
        if (retention == stateFlow.value.retention) return
        stateFlow.update { it.copy(retention = retention) }
        saving += 1
        viewModelScope.launch {
            try {
                val saved = session.vaults.routes.saveSettings(surfaceId, retention)
                if (saving == 1) stateFlow.update { it.copy(retention = saved.retention) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stateFlow.update { it.copy(failed = Conversation.describe(e)) }
                read()
            } finally {
                saving -= 1
            }
        }
    }

    fun dismiss() = stateFlow.update { it.copy(failed = null) }
}

/**
 * A vault's retention settings: how versions are kept, as one of the
 * presets (Time Machine, which a new vault starts with, keep everything,
 * the last 10 versions) or a custom schedule
 * (every version for a while, then one in each span past an age, at most
 * so many, none older than so long), and how long the Trash holds what
 * was deleted. Each change is saved at once; the daemon applies it at its
 * next pass. Live as anyone changes them.
 */
@Composable
fun VaultSettingsScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit) {
    val model = viewModel(key = "vault-settings:${session.connectionId}:$surfaceId") { VaultSettingsModel(session, surfaceId) }
    val state by model.state.collectAsStateWithLifecycle()
    Screen(header = { StackHeader(stringResource(R.string.vaults_settings), onBack) }, modifier = Modifier.testTag(VaultSettingsTags.SCREEN)) {
        val retention = state.retention
        if (retention == null) {
            if (state.error != null) com.slopus.happy.ui.artifacts.PlaceMessage(problemText(state.error!!)) else LoadingIndicator()
        } else {
            VaultSettingsPage(retention, model::save)
        }
    }
    state.failed?.let { problem ->
        HappyAlert(Alert(stringResource(R.string.vaults_settings_failed), problemText(problem), listOf(AlertButton(stringResource(R.string.common_ok)))), model::dismiss)
    }
}

/** [VaultSettingsScreen]'s groups for [retention], each change handed to [onChange] whole. */
@Composable
internal fun VaultSettingsPage(retention: VaultRetention, onChange: (VaultRetention) -> Unit) {
    val preset = VaultRetentionPreset.of(retention)
    var customOpen by rememberSaveable { mutableStateOf(false) }
    var asking by remember { mutableStateOf<Ask?>(null) }
    var refused by remember { mutableStateOf<VaultRetentionPreset.Problem?>(null) }
    val change: (VaultRetention) -> Unit = { next ->
        val problem = VaultRetentionPreset.problem(next)
        if (problem != null) refused = problem else onChange(next)
    }
    val colors = HappyTheme.colors
    ItemList {
        ItemGroup(title = stringResource(R.string.vaults_versions), footer = stringResource(R.string.vaults_versions_footer)) {
            for (option in VaultRetentionPreset.offered) {
                val chosen = if (customOpen) option == VaultRetentionPreset.Custom else option == preset
                Item(
                    title = presetTitle(option),
                    subtitle = presetSubtitle(option, retention),
                    modifier = Modifier.testTag(VaultSettingsTags.preset(option)),
                    onClick = {
                        customOpen = option == VaultRetentionPreset.Custom
                        if (option != VaultRetentionPreset.Custom) change(option.applied(retention))
                    },
                    rightElement = if (chosen) ({ Icon(Ionicon.Checkmark, 22.dp, colors.textLink) }) else null,
                    showChevron = false,
                )
            }
        }
        if (customOpen || preset == VaultRetentionPreset.Custom) {
            ItemGroup(title = stringResource(R.string.vaults_custom_schedule)) {
                Item(
                    title = stringResource(R.string.vaults_keep_all_for),
                    detail = days(retention.keepAllDays),
                    modifier = Modifier.testTag(VaultSettingsTags.KEEP_ALL),
                    onClick = { asking = Ask.KeepAll },
                )
                retention.thinning.forEachIndexed { index, tier ->
                    Item(
                        title = stringResource(R.string.vaults_tier_after, days(tier.afterDays)),
                        detail = everyDays(tier.everyDays),
                        modifier = Modifier.testTag(VaultSettingsTags.tier(index)),
                        onClick = { asking = Ask.Tier(index) },
                    )
                }
                if (retention.thinning.size < 8) Item(
                    title = stringResource(R.string.vaults_add_tier),
                    titleColor = colors.textLink,
                    modifier = Modifier.testTag(VaultSettingsTags.ADD_TIER),
                    onClick = { asking = Ask.Tier(null) },
                    showChevron = false,
                )
                Item(
                    title = stringResource(R.string.vaults_max_versions),
                    detail = retention.maxVersions?.let { pluralResource(R.plurals.vaults_versions_count, it, it) } ?: stringResource(R.string.vaults_no_limit),
                    modifier = Modifier.testTag(VaultSettingsTags.MAX_VERSIONS),
                    onClick = { asking = Ask.MaxVersions },
                )
                Item(
                    title = stringResource(R.string.vaults_max_age),
                    detail = retention.maxAgeDays?.let { days(it) } ?: stringResource(R.string.vaults_never),
                    modifier = Modifier.testTag(VaultSettingsTags.MAX_AGE),
                    onClick = { asking = Ask.MaxAge },
                )
            }
        }
        ItemGroup(title = stringResource(R.string.vaults_trash), footer = stringResource(R.string.vaults_trash_footer)) {
            val choices = VaultRetentionPreset.trashChoices.let { if (retention.trashDays in it) it else it + retention.trashDays }
            for (choice in choices) {
                Item(
                    title = choice?.let { days(it) } ?: stringResource(R.string.vaults_trash_never),
                    modifier = Modifier.testTag(VaultSettingsTags.trash(choice)),
                    onClick = { change(retention.copy(trashDays = choice)) },
                    rightElement = if (choice == retention.trashDays) ({ Icon(Ionicon.Checkmark, 22.dp, colors.textLink) }) else null,
                    showChevron = false,
                )
            }
            Item(title = stringResource(R.string.vaults_trash_other), onClick = { asking = Ask.Trash })
        }
    }
    when (val ask = asking) {
        null -> Unit
        Ask.KeepAll -> NumberPrompt(stringResource(R.string.vaults_keep_all_for), stringResource(R.string.vaults_days_hint), retention.keepAllDays, allowEmpty = false, { asking = null }) {
            change(retention.copy(keepAllDays = it ?: 0))
        }
        Ask.MaxVersions -> NumberPrompt(stringResource(R.string.vaults_max_versions), stringResource(R.string.vaults_empty_no_limit), retention.maxVersions, allowEmpty = true, { asking = null }) {
            change(retention.copy(maxVersions = it))
        }
        Ask.MaxAge -> NumberPrompt(stringResource(R.string.vaults_max_age), stringResource(R.string.vaults_empty_never), retention.maxAgeDays, allowEmpty = true, { asking = null }) {
            change(retention.copy(maxAgeDays = it))
        }
        Ask.Trash -> NumberPrompt(stringResource(R.string.vaults_trash_days), stringResource(R.string.vaults_empty_never), retention.trashDays, allowEmpty = true, { asking = null }) {
            change(retention.copy(trashDays = it))
        }
        is Ask.Tier -> TierDialog(ask.index?.let { retention.thinning[it] }, onDismiss = { asking = null }, onRemove = ask.index?.let { index -> { change(retention.copy(thinning = retention.thinning.filterIndexed { i, _ -> i != index })) } }) { tier ->
            val rest = retention.thinning.filterIndexed { i, _ -> i != ask.index }
            change(retention.copy(thinning = (rest + tier).sortedBy { it.afterDays }))
        }
    }
    refused?.let { problem ->
        HappyAlert(Alert(stringResource(R.string.vaults_settings_failed), retentionProblem(problem), listOf(AlertButton(stringResource(R.string.common_ok)))), { refused = null })
    }
}

private sealed interface Ask {
    data object KeepAll : Ask
    data object MaxVersions : Ask
    data object MaxAge : Ask
    data object Trash : Ask
    /** A step of the schedule; null is a new one. */
    data class Tier(val index: Int?) : Ask
}

@Composable
private fun presetTitle(preset: VaultRetentionPreset): String = stringResource(
    when (preset) {
        VaultRetentionPreset.KeepEverything -> R.string.vaults_preset_everything
        VaultRetentionPreset.LastTen -> R.string.vaults_preset_last_ten
        VaultRetentionPreset.TimeMachine -> R.string.vaults_preset_time_machine
        VaultRetentionPreset.Custom -> R.string.vaults_preset_custom
    },
)

@Composable
private fun presetSubtitle(preset: VaultRetentionPreset, retention: VaultRetention): String = when (preset) {
    VaultRetentionPreset.KeepEverything -> stringResource(R.string.vaults_preset_everything_detail)
    VaultRetentionPreset.LastTen -> stringResource(R.string.vaults_preset_last_ten_detail)
    VaultRetentionPreset.TimeMachine -> stringResource(R.string.vaults_preset_time_machine_detail)
    VaultRetentionPreset.Custom -> stringResource(R.string.vaults_preset_custom_detail)
}

@Composable
private fun days(count: Int): String = pluralResource(R.plurals.vaults_days, count, count)

@Composable
private fun everyDays(count: Int): String = if (count == 1) stringResource(R.string.vaults_one_a_day) else pluralResource(R.plurals.vaults_one_every_days, count, count)

@Composable
private fun retentionProblem(problem: VaultRetentionPreset.Problem): String = stringResource(
    when (problem) {
        VaultRetentionPreset.Problem.MaxVersions -> R.string.vaults_problem_max_versions
        VaultRetentionPreset.Problem.MaxAge -> R.string.vaults_problem_max_age
        VaultRetentionPreset.Problem.KeepAll -> R.string.vaults_problem_keep_all
        VaultRetentionPreset.Problem.TooManyTiers -> R.string.vaults_problem_too_many_tiers
        VaultRetentionPreset.Problem.Tier -> R.string.vaults_problem_tier
        VaultRetentionPreset.Problem.TierOrder -> R.string.vaults_problem_tier_order
        VaultRetentionPreset.Problem.Trash -> R.string.vaults_problem_trash
    },
)

/** A whole number, or (with [allowEmpty]) nothing for "no limit". */
@Composable
private fun NumberPrompt(title: String, message: String, current: Int?, allowEmpty: Boolean, onDismiss: () -> Unit, onResult: (Int?) -> Unit) {
    PromptModal(
        Prompt(title = title, message = message, defaultValue = current?.toString().orEmpty(), inputType = PromptInputType.Numeric, allowBlank = allowEmpty) { text ->
            if (text == null) return@Prompt
            val trimmed = text.trim()
            if (trimmed.isEmpty()) { if (allowEmpty) onResult(null); return@Prompt }
            trimmed.toIntOrNull()?.let(onResult)
        },
        onDismiss = onDismiss,
    )
}

/** One step of the schedule: after how many days, one version in every how many days; Remove for an existing one. */
@Composable
private fun TierDialog(tier: VaultRetentionTier?, onDismiss: () -> Unit, onRemove: (() -> Unit)?, onSave: (VaultRetentionTier) -> Unit) {
    var after by remember { mutableStateOf(tier?.afterDays?.toString() ?: "30") }
    var every by remember { mutableStateOf(tier?.everyDays?.toString() ?: "7") }
    val parsed = after.trim().toIntOrNull()?.let { a -> every.trim().toIntOrNull()?.let { e -> VaultRetentionTier(a, e) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (tier == null) R.string.vaults_add_tier else R.string.vaults_edit_tier)) },
        text = {
            Column {
                OutlinedTextField(
                    after, { after = it }, singleLine = true,
                    label = { Text(stringResource(R.string.vaults_tier_after_label)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    every, { every = it }, singleLine = true,
                    label = { Text(stringResource(R.string.vaults_tier_every_label)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { parsed?.let { onDismiss(); onSave(it) } }, enabled = parsed != null) { Text(stringResource(R.string.common_save)) }
        },
        dismissButton = {
            if (onRemove != null) TextButton(onClick = { onDismiss(); onRemove() }) { Text(stringResource(R.string.vaults_remove), color = HappyTheme.colors.textDestructive) }
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
        },
    )
}
