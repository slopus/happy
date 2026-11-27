package com.slopus.happy.ui.connection

import android.icu.text.ListFormatter
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.CloudSecretMetadata
import com.slopus.happy.agent.CloudZone
import com.slopus.happy.agent.cloudSecretMetadata
import com.slopus.happy.agent.cloudZoneMemberNames
import com.slopus.happy.agent.cloudZones
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.page
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

@Serializable data class CloudZonesRoute(val connectionId: String)
@Serializable data class CloudSecretsRoute(val connectionId: String)

internal enum class CloudMetadataPage(@StringRes val title: Int) {
    Zones(R.string.cloud_settings_zones), Secrets(R.string.cloud_settings_secrets),
}

internal sealed interface CloudMetadataState {
    data object Loading : CloudMetadataState
    data object Failed : CloudMetadataState
    data class Zones(val zones: List<CloudZone>, val names: Map<String, String>) : CloudMetadataState
    data class Secrets(val secrets: List<CloudSecretMetadata>) : CloudMetadataState
}

internal fun NavGraphBuilder.cloudMetadataRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudZonesRoute> { entry ->
        CloudMetadata(graph, entry.toRoute<CloudZonesRoute>().connectionId, CloudMetadataPage.Zones) { nav.popBackStack() }
    }
    page<CloudSecretsRoute> { entry ->
        CloudMetadata(graph, entry.toRoute<CloudSecretsRoute>().connectionId, CloudMetadataPage.Secrets) { nav.popBackStack() }
    }
}

@Composable
private fun CloudMetadata(graph: AppGraph, connectionId: String, page: CloudMetadataPage, onBack: () -> Unit) {
    val session = remember(graph, connectionId) { graph.agentSessions.session(connectionId) }
    var state by remember(session, page) { mutableStateOf<CloudMetadataState>(CloudMetadataState.Loading) }
    var attempt by remember(session, page) { mutableIntStateOf(0) }
    LaunchedEffect(session, page, attempt) {
        if (session == null || !session.client.cloud) {
            state = CloudMetadataState.Failed
            return@LaunchedEffect
        }
        val client = session.client
        state = CloudMetadataState.Loading
        state = try {
            when (page) {
                CloudMetadataPage.Zones -> {
                    val zones = client.cloudZones()
                    val ids = zones.flatMap { it.members.orEmpty() }.toSet()
                    CloudMetadataState.Zones(zones, client.cloudZoneMemberNames(ids, session.team.names(ids)))
                }
                CloudMetadataPage.Secrets -> CloudMetadataState.Secrets(client.cloudSecretMetadata())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            CloudMetadataState.Failed
        }
    }
    CloudMetadataScreen(page, state, onRetry = { attempt++ }, onBack = onBack)
}

/** Read-only settings lists: the standard stack header and grouped cards (16dp phone margins).
 * Zone facts and both lists' descriptions use the settings row's wrapping subtitle. */
@Composable
internal fun CloudMetadataScreen(page: CloudMetadataPage, state: CloudMetadataState, onRetry: () -> Unit, onBack: () -> Unit) {
    Screen(header = { StackHeader(stringResource(page.title), onBack) }) {
        ItemList {
            when (state) {
                CloudMetadataState.Loading -> ItemGroup { Item(stringResource(R.string.common_loading), loading = true, showChevron = false) }
                CloudMetadataState.Failed -> ItemGroup {
                    Item(stringResource(R.string.cloud_settings_load_failed), subtitle = stringResource(R.string.common_retry), onClick = onRetry, showChevron = false)
                }
                is CloudMetadataState.Zones -> ItemGroup(footer = stringResource(R.string.cloud_settings_manage_on_desktop)) {
                    if (state.zones.isEmpty()) Item(stringResource(R.string.cloud_settings_no_zones), showChevron = false)
                    val locale = LocalConfiguration.current.locales[0]
                    val listFormatter = remember(locale) { ListFormatter.getInstance(locale) }
                    for (zone in state.zones) key(zone.id) {
                        val names = when {
                            zone.members == null -> stringResource(R.string.cloud_settings_all_members)
                            zone.members.isEmpty() -> stringResource(R.string.cloud_settings_no_members)
                            else -> listFormatter.format(zone.members.map { state.names[it] ?: it })
                        }
                        val facts = listOfNotNull(
                            if (zone.isDefault) stringResource(R.string.cloud_settings_default_zone) else null,
                            if (zone.critical) stringResource(R.string.cloud_settings_critical_zone) else null,
                            zone.description.takeIf(String::isNotBlank),
                            stringResource(R.string.cloud_settings_may_join, names),
                        )
                        Item(
                            zone.name, Modifier.testTag("zone.${zone.id}"), subtitle = facts.joinToString("\n"),
                            titleLines = 0, subtitleLines = 0, showChevron = false,
                            icon = { StatusDot(zoneColor(zone.color), size = 14.dp) },
                        )
                    }
                }
                is CloudMetadataState.Secrets -> {
                    if (state.secrets.isEmpty()) ItemGroup { Item(stringResource(R.string.cloud_settings_no_secrets), showChevron = false) }
                    val owners = listOf("team" to R.string.cloud_settings_owner_team, "me" to R.string.cloud_settings_owner_mine, "agent" to R.string.cloud_settings_owner_agent)
                    val groups = state.secrets.groupBy { secret -> secret.owner?.takeIf { owner -> owners.any { it.first == owner } } }
                    for ((owner, title) in owners + (null to null)) {
                        val secrets = groups[owner] ?: continue
                        ItemGroup(title = title?.let { stringResource(it) }) {
                            for (secret in secrets) key(secret.id) {
                                Item(secret.name, Modifier.testTag("secret.${secret.id}"), subtitle = secret.description?.takeIf(String::isNotBlank),
                                    titleLines = 0, subtitleLines = 0, showChevron = false)
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun zoneColor(color: String): Color = when (color) {
    "red" -> Color(0xFFDC2626)
    "orange" -> Color(0xFFEA580C)
    "amber" -> Color(0xFFB45309)
    "green" -> Color(0xFF15803D)
    "teal" -> Color(0xFF0F766E)
    "blue" -> Color(0xFF2563EB)
    "indigo" -> Color(0xFF4F46E5)
    "purple" -> Color(0xFF9333EA)
    "pink" -> Color(0xFFDB2777)
    else -> Color(0xFF6B7280)
}
