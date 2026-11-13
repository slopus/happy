package com.slopus.happy.ui.plugins

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.Plugin
import com.slopus.happy.plugins.PluginImage
import com.slopus.happy.plugins.PluginInstallation
import com.slopus.happy.plugins.PluginsSnapshot
import com.slopus.happy.plugins.PluginsState
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connection.AgentPicture
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.connection.TileMark
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object PluginsTags {
    const val LIST = "plugins.list"
    const val PAGE = "plugins.page"
    const val HERO = "plugins.hero"
    const val RETRY = "plugins.retry"
    fun installation(id: String) = "plugins.installation.$id"
    fun available(key: String) = "plugins.available.$key"
}

/** Sizes of the plugin pages. */
object PluginsSpec {
    /** A row's picture: the Item icon slot. */
    val rowMark = 32.dp
    /** The page's own picture, over its name. */
    val heroMark = 72.dp
    val heroRadius = 18.dp
    val heroTop = 8.dp
    val heroGap = 12.dp
    val heroPadding = 24.dp
    val heroTitle = happyTextStyle(fontSize = 24, lineHeight = 30, weight = FontWeight.SemiBold)
    val heroBody = happyTextStyle(fontSize = 15, lineHeight = 21)
}

/**
 * A plugin's picture over its ThumbHash, a rounded square, or the plugin
 * glyph on its orange tile where it has none (desktop's `PluginMark`).
 */
@Composable
internal fun PluginMark(image: PluginImage?, size: Dp, radius: Dp = size * 0.25f) {
    if (image != null) AgentPicture(image.path, image.thumbhash, size, radius) else TileMark(Ionicon.ExtensionPuzzleOutline, RowTile.Orange, size)
}

/** How one installation is named beside its siblings: its label, or its number past the first. */
internal fun installationTitle(installation: PluginInstallation): String = when {
    installation.label != null -> "${installation.name} · ${installation.label}"
    installation.ordinal > 1 -> "${installation.name} ${installation.ordinal}"
    else -> installation.name
}

@Composable
internal fun statusWords(installation: PluginInstallation): String = when {
    !installation.available -> stringResource(R.string.plugins_status_unavailable)
    else -> when (installation.status) {
        InstallationStatus.Active -> stringResource(R.string.plugins_status_ready)
        InstallationStatus.NeedsSetup -> stringResource(R.string.plugins_status_needs_setup)
        InstallationStatus.MethodUnavailable -> stringResource(R.string.plugins_status_setup_again)
        InstallationStatus.Installing -> stringResource(R.string.plugins_status_installing)
        is InstallationStatus.Failed -> stringResource(R.string.plugins_status_failed)
    }
}

/** Ready reads quiet; anything that waits on the person reads in the attention colour. */
@Composable
internal fun statusColor(installation: PluginInstallation): Color {
    val colors = HappyTheme.colors
    return when {
        !installation.available || installation.status == InstallationStatus.Active || installation.status == InstallationStatus.Installing -> colors.textSecondary
        installation.status is InstallationStatus.Failed -> colors.textDestructive
        else -> RowTile.Orange.ink(colors.dark)
    }
}

/**
 * The connection's plugins (home's Plugins row; desktop's catalog page):
 * Installed, one row per installation with its picture, its name and its
 * state on the right, then Available, the plugins with no installation,
 * each with its description under its name. Every row opens its plugin.
 * A member whose role may not manage plugins reads why under the list.
 * Rows are [Item]s: 32 picture, 16/24 title, 14/20 subtitle.
 */
@Composable
fun PluginsScreen(
    state: PluginsState,
    onOpen: (pluginKey: String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.plugins_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(PluginsTags.LIST)) {
            when (state) {
                PluginsState.Loading -> ItemGroup { Item(title = stringResource(R.string.plugins_loading), loading = true, showChevron = false) }
                PluginsState.Failed -> ItemGroup {
                    Item(
                        title = stringResource(R.string.plugins_failed),
                        subtitle = stringResource(R.string.plugins_tap_to_retry),
                        onClick = onRetry,
                        showChevron = false,
                        modifier = Modifier.testTag(PluginsTags.RETRY),
                    )
                }
                PluginsState.Unsupported -> ItemGroup { Item(title = stringResource(R.string.plugins_empty), titleColor = HappyTheme.colors.textSecondary, showChevron = false) }
                is PluginsState.Loaded -> PluginsList(state.snapshot, onOpen)
            }
        }
    }
}

@Composable
private fun PluginsList(snapshot: PluginsSnapshot, onOpen: (String) -> Unit) {
    if (snapshot.plugins.isEmpty() && snapshot.installations.isEmpty()) {
        ItemGroup { Item(title = stringResource(R.string.plugins_empty), titleColor = HappyTheme.colors.textSecondary, showChevron = false) }
        return
    }
    if (snapshot.installations.isNotEmpty()) {
        ItemGroup(title = stringResource(R.string.plugins_installed)) {
            for (installation in snapshot.installations) {
                Item(
                    title = installationTitle(installation),
                    subtitle = statusWords(installation),
                    subtitleColor = statusColor(installation),
                    icon = { PluginMark(installation.image ?: snapshot.plugin(installation.pluginKey)?.image, PluginsSpec.rowMark) },
                    onClick = { onOpen(installation.pluginKey) },
                    modifier = Modifier.testTag(PluginsTags.installation(installation.id)),
                )
            }
        }
    }
    val available = snapshot.available
    if (available.isNotEmpty()) {
        ItemGroup(
            title = stringResource(R.string.plugins_available),
            footer = if (snapshot.canManage) null else stringResource(R.string.plugins_manage_note),
        ) {
            for (plugin in available) {
                Item(
                    title = plugin.name,
                    subtitle = plugin.description.ifBlank { null },
                    icon = { PluginMark(plugin.image, PluginsSpec.rowMark) },
                    onClick = { onOpen(plugin.key) },
                    modifier = Modifier.testTag(PluginsTags.available(plugin.key)),
                )
            }
        }
    }
}

/**
 * One plugin's page (desktop's plugin page): its picture (72, rounded 18)
 * centred over its name (24/30 semibold), its version and description;
 * then its installations with their state, and the tools it gives agents.
 * [actions] holds what the person may do with it, under the picture.
 * A plugin the server doesn't offer says so.
 */
@Composable
fun PluginScreen(
    state: PluginsState,
    pluginKey: String,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    installationRow: @Composable (PluginInstallation) -> Unit = { DefaultInstallationRow(it) },
    actions: @Composable (Plugin, PluginsSnapshot) -> Unit = { _, _ -> },
) {
    val snapshot = (state as? PluginsState.Loaded)?.snapshot
    val plugin = snapshot?.plugin(pluginKey)
    val installations = snapshot?.installationsOf(pluginKey).orEmpty()
    Screen(header = { StackHeader(plugin?.name ?: installations.firstOrNull()?.name ?: stringResource(R.string.plugins_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(PluginsTags.PAGE)) {
            when {
                state == PluginsState.Loading -> ItemGroup { Item(title = stringResource(R.string.plugins_loading), loading = true, showChevron = false) }
                state == PluginsState.Failed -> ItemGroup {
                    Item(title = stringResource(R.string.plugins_failed), subtitle = stringResource(R.string.plugins_tap_to_retry), onClick = onRetry, showChevron = false)
                }
                snapshot == null || (plugin == null && installations.isEmpty()) ->
                    ItemGroup { Item(title = stringResource(R.string.plugins_not_offered), titleColor = HappyTheme.colors.textSecondary, showChevron = false) }
                else -> {
                    Hero(plugin, installations.firstOrNull())
                    if (plugin != null) actions(plugin, snapshot)
                    if (installations.isNotEmpty()) {
                        ItemGroup(
                            title = stringResource(R.string.plugins_installed),
                            footer = if (plugin == null) stringResource(R.string.plugins_no_longer_offered) else null,
                        ) { installations.forEach { installationRow(it) } }
                    }
                    if (plugin != null && plugin.tools.isNotEmpty()) {
                        ItemGroup(title = stringResource(R.string.plugins_tools)) {
                            plugin.tools.forEach { tool -> Item(title = tool.name, subtitle = tool.summary.ifBlank { null }, subtitleLines = 3, showChevron = false) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DefaultInstallationRow(installation: PluginInstallation) {
    Item(
        title = installationTitle(installation),
        subtitle = statusWords(installation),
        subtitleColor = statusColor(installation),
        showChevron = false,
        modifier = Modifier.testTag(PluginsTags.installation(installation.id)),
    )
}

@Composable
private fun Hero(plugin: Plugin?, installation: PluginInstallation?) {
    val colors = HappyTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = PluginsSpec.heroPadding).padding(top = PluginsSpec.heroTop).testTag(PluginsTags.HERO),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(PluginsSpec.heroGap),
    ) {
        PluginMark(plugin?.image ?: installation?.image, PluginsSpec.heroMark, PluginsSpec.heroRadius)
        Text(
            plugin?.name ?: installation?.name.orEmpty(),
            style = PluginsSpec.heroTitle,
            color = colors.text,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        val about = listOfNotNull(
            plugin?.version?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.plugins_version, it) },
            plugin?.description?.takeIf { it.isNotBlank() },
        )
        if (about.isNotEmpty()) {
            Text(about.joinToString("\n"), style = PluginsSpec.heroBody, color = colors.textSecondary, textAlign = TextAlign.Center)
        }
    }
}
