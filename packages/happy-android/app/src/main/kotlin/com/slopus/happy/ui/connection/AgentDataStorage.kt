package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.media.MediaSizeText
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.settings.SettingsCard
import com.slopus.happy.ui.settings.SettingsEntry
import com.slopus.happy.ui.settings.SettingsSection
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** An agent connection's Data and Storage. */
@Serializable data class AgentDataStorageRoute(val connectionId: String)

object DataStorageTags {
    const val ROW = "agentSettings.dataStorage"
    const val USAGE = "dataStorage.usage"
    const val CLEAR = "dataStorage.clear"
    fun auto(kind: MediaAutoDownload.Kind) = "dataStorage.auto.${kind.name}"
    fun switch(kind: MediaAutoDownload.Kind) = "dataStorage.auto.${kind.name}.switch"
    fun limit(kind: MediaAutoDownload.Kind) = "dataStorage.limit.${kind.name}"
}

@Composable
internal fun AgentDataStorage(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val library = remember(connectionId) { graph.agentSessions.session(connectionId)?.media }
    val rules by graph.mediaAutoDownload.rules.collectAsStateWithLifecycle()
    var usage by remember { mutableStateOf<Long?>(null) }
    var clearing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(library) { usage = library?.let { withContext(Dispatchers.IO) { it.usage() } } }
    DataStorageScreen(
        usage = usage,
        rules = rules,
        onRules = { next -> graph.mediaAutoDownload.change { next } },
        onClear = if (library == null || clearing || usage == 0L) null else ({
            clearing = true
            scope.launch {
                library.clear()
                usage = withContext(Dispatchers.IO) { library.usage() }
                clearing = false
            }
        }),
        onBack = { nav.popBackStack() },
    )
}

/**
 * Telegram's Data and Storage, as much of iOS's (ba7b68346) as kept chat
 * media needs: what this connection's media takes on the phone, Clear Media
 * after a confirm, and Automatic Media Download's switches and size limits,
 * one setting for every network. iOS's Connection row is the settings
 * unit's (gaps/settings.md S6).
 */
@Composable
fun DataStorageScreen(
    usage: Long?,
    rules: MediaAutoDownload,
    onRules: (MediaAutoDownload) -> Unit,
    onClear: (() -> Unit)?,
    onBack: () -> Unit,
) {
    var confirming by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf<MediaAutoDownload.Kind?>(null) }
    val size = usage?.let(MediaSizeText::size) ?: stringResource(R.string.data_storage_calculating)
    val storage = SettingsSection(
        listOf(
            SettingsEntry(
                id = DataStorageTags.USAGE,
                title = stringResource(R.string.data_storage_usage),
                icon = { SettingsTile(Ionicon.FolderOutline, SettingsTiles.blue) },
                detail = size,
                chevron = false,
            ),
            SettingsEntry(
                id = DataStorageTags.CLEAR,
                title = stringResource(R.string.data_storage_clear_media),
                destructive = true,
                chevron = false,
                enabled = onClear != null,
                onClick = onClear?.let { { confirming = true } },
            ),
        ),
        footer = stringResource(R.string.data_storage_clear_footer),
    )
    val automatic = SettingsSection(
        MediaAutoDownload.Kind.entries.flatMap { kind ->
            val rule = rules[kind]
            val (title, icon, tile) = when (kind) {
                MediaAutoDownload.Kind.Photos -> Triple(R.string.data_storage_photos, Ionicon.ImageOutline, SettingsTiles.orange)
                MediaAutoDownload.Kind.Videos -> Triple(R.string.data_storage_videos, Ionicon.FilmOutline, SettingsTiles.purple)
                MediaAutoDownload.Kind.Files -> Triple(R.string.common_files, Ionicon.DocumentOutline, SettingsTiles.green)
            }
            listOfNotNull(
                SettingsEntry(
                    id = DataStorageTags.auto(kind),
                    title = stringResource(title),
                    icon = { SettingsTile(icon, tile) },
                    toggle = rule.enabled,
                    onToggle = { on -> onRules(rules.with(kind, rule.copy(enabled = on))) },
                    toggleTag = DataStorageTags.switch(kind),
                    chevron = false,
                ),
                if (rule.enabled) SettingsEntry(
                    id = DataStorageTags.limit(kind),
                    title = stringResource(R.string.data_storage_limit),
                    detail = MediaSizeText.size(rule.limit),
                    onClick = { choosing = kind },
                ) else null,
            )
        },
        footer = stringResource(R.string.data_storage_auto_footer),
        title = stringResource(R.string.data_storage_auto),
    )
    AgentPage(stringResource(R.string.data_storage_title), onBack) {
        SettingsCard(storage)
        SettingsCard(automatic)
    }
    if (confirming && onClear != null) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.data_storage_clear_media),
                message = stringResource(R.string.data_storage_clear_confirm, size),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.data_storage_clear), destructive = true, onClick = onClear),
                ),
            ),
            onDismiss = { confirming = false },
        )
    }
    choosing?.let { kind ->
        val rule = rules[kind]
        HappyAlert(
            Alert(
                title = stringResource(R.string.data_storage_limit),
                buttons = MediaAutoDownload.limits.map { limit ->
                    val label = MediaSizeText.size(limit)
                    AlertButton(if (limit == rule.limit) "✓ $label" else label) { onRules(rules.with(kind, rule.copy(limit = limit))) }
                } + AlertButton(stringResource(R.string.common_cancel)),
            ),
            onDismiss = { choosing = null },
        )
    }
}
