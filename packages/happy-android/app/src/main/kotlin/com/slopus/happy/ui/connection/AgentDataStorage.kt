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
import androidx.navigation.NavGraphBuilder
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentServices
import com.slopus.happy.auth.AuthState
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.media.MediaSizeText
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.page
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
@Serializable data object LegacyDataStorageRoute
@Serializable data class MediaLimitRoute(val kind: MediaAutoDownload.Kind)

internal fun NavGraphBuilder.dataStorageRoutes(graph: AppGraph, nav: NavHostController) {
    connectionDiagnosticsRoutes(graph, nav)
    page<LegacyDataStorageRoute> {
        val auth by graph.auth.state.collectAsStateWithLifecycle()
        val open by graph.openAccount.collectAsStateWithLifecycle()
        val library = remember(auth) {
            if (auth is AuthState.SignedIn) AttachmentServices.of(graph).transfers?.library else null
        }
        MediaStoragePage(graph, nav, library, open.id)
    }
    page<MediaLimitRoute> { entry ->
        val kind = entry.toRoute<MediaLimitRoute>().kind
        val rules by graph.mediaAutoDownload.rules.collectAsStateWithLifecycle()
        MediaLimitScreen(
            limit = rules[kind].limit,
            onSelect = { limit ->
                graph.mediaAutoDownload.change { it.with(kind, it[kind].copy(limit = limit)) }
                nav.popBackStack()
            },
            onBack = { nav.popBackStack() },
        )
    }
}

object DataStorageTags {
    const val ROW = "agentSettings.dataStorage"
    const val USAGE = "dataStorage.usage"
    const val CLEAR = "dataStorage.clear"
    fun auto(kind: MediaAutoDownload.Kind) = "dataStorage.auto.${kind.name}"
    fun switch(kind: MediaAutoDownload.Kind) = "dataStorage.auto.${kind.name}.switch"
    fun limit(kind: MediaAutoDownload.Kind) = "dataStorage.limit.${kind.name}"
    fun choice(bytes: Long) = "dataStorage.limit.$bytes"
}

@Composable
internal fun AgentDataStorage(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val library = remember(connectionId) { graph.agentSessions.session(connectionId)?.media }
    MediaStoragePage(graph, nav, library, connectionId)
}

/** Both kinds of account use the library that their existing downloads write into. */
@Composable
private fun MediaStoragePage(graph: AppGraph, nav: NavHostController, library: MediaLibrary?, connectionId: String?) {
    val rules by graph.mediaAutoDownload.rules.collectAsStateWithLifecycle()
    var usage by remember(library) { mutableStateOf<Long?>(null) }
    var clearing by remember(library) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(library) { usage = library?.let { withContext(Dispatchers.IO) { it.usage() } } }
    DataStorageScreen(
        usage = usage,
        rules = rules,
        onRules = { next -> graph.mediaAutoDownload.change { next } },
        onClear = if (library == null || clearing || usage == 0L) null else ({
            clearing = true
            scope.launch {
                try {
                    library.clear()
                    usage = withContext(Dispatchers.IO) { library.usage() }
                } finally {
                    clearing = false
                }
            }
        }),
        onBack = { nav.popBackStack() },
        onChooseLimit = { nav.navigate(MediaLimitRoute(it)) },
        onConnection = connectionId?.let { id -> { nav.navigate(ConnectionDiagnosticsRoute(id)) } },
    )
}

/**
 * Telegram's Data and Storage, as much of iOS's (ba7b68346) as kept chat
 * media needs: what this connection's media takes on the phone, Clear Media
 * after a confirm, and Automatic Media Download's switches and size limits,
 * one setting for every network, with this account's Connection diagnostics on top.
 */
@Composable
fun DataStorageScreen(
    usage: Long?,
    rules: MediaAutoDownload,
    onRules: (MediaAutoDownload) -> Unit,
    onClear: (() -> Unit)?,
    onBack: () -> Unit,
    onChooseLimit: (MediaAutoDownload.Kind) -> Unit = {},
    onConnection: (() -> Unit)? = null,
) {
    var confirming by remember { mutableStateOf(false) }
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
                    onClick = { onChooseLimit(kind) },
                ) else null,
            )
        },
        footer = stringResource(R.string.data_storage_auto_footer),
        title = stringResource(R.string.data_storage_auto),
    )
    AgentPage(stringResource(R.string.data_storage_title), onBack) {
        onConnection?.let { open ->
            SettingsCard(SettingsSection(listOf(SettingsEntry(
                id = ConnectionPageTags.ROW,
                title = stringResource(R.string.connection_title),
                icon = { SettingsTile(Ionicon.GlobeOutline, SettingsTiles.blue) },
                onClick = open,
            ))))
        }
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
}

/** iOS DataStorageViewController.chooseLimit: a pushed list, the current size checked. */
@Composable
fun MediaLimitScreen(limit: Long, onSelect: (Long) -> Unit, onBack: () -> Unit) {
    AgentPage(stringResource(R.string.data_storage_limit), onBack) {
        SettingsCard(SettingsSection(MediaAutoDownload.limits.map { bytes ->
            SettingsEntry(
                id = DataStorageTags.choice(bytes),
                title = MediaSizeText.size(bytes),
                checked = bytes == limit,
                chevron = false,
                onClick = { onSelect(bytes) },
            )
        }))
    }
}
