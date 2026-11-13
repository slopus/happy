package com.slopus.happy.ui.connection

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.CloudCapabilities
import com.slopus.happy.agent.CloudConnection
import com.slopus.happy.agent.CloudDestination
import com.slopus.happy.agent.CloudProviderException
import com.slopus.happy.agent.CloudProviders
import com.slopus.happy.agent.CloudProvidersSource
import com.slopus.happy.agent.CloudSignInRun
import com.slopus.happy.agent.CustomProvider
import com.slopus.happy.agent.Permission
import com.slopus.happy.ui.components.ProviderIcon
import com.slopus.happy.model.ProviderIconKind
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.Segment
import com.slopus.happy.ui.components.SegmentedTabs
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.settings.SettingsPageSpec
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.page
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Happy Cloud's AI providers for connection [connectionId]; [choose] opens the add chooser over them, its pick kept in [to] when it says. */
@Serializable data class CloudProvidersRoute(val connectionId: String, val choose: Boolean = false, val to: String? = null)

/** ChatGPT's device sign-in, kept in [to] (a [CloudDestination] id) when it says. */
@Serializable data class CloudChatGptRoute(val connectionId: String, val to: String? = null)

/** Claude's setup token, kept in [to] when it says. */
@Serializable data class CloudClaudeRoute(val connectionId: String, val to: String? = null)

/** An OpenAI, Anthropic or Grok API key; [vendor] picks the vendor first. */
@Serializable data class CloudApiKeyRoute(val connectionId: String, val vendor: String? = null, val to: String? = null)

/** The team's own endpoint, with its models and key. */
@Serializable data class CloudCustomRoute(val connectionId: String)

/** What a providers link opens over the list (w8548's shared targets). */
sealed interface CloudProviderFlow {
    data object Choose : CloudProviderFlow
    data object ChatGpt : CloudProviderFlow
    data object Claude : CloudProviderFlow
    data class ApiKey(val vendor: String? = null) : CloudProviderFlow
    data object Custom : CloudProviderFlow
}

object CloudProvidersTags {
    const val ROW = "cloudProviders.row"
    const val ADD = "cloudProviders.add"
    const val LIST = "cloudProviders.list"
    const val CODE = "cloudProviders.code"
    const val COPY = "cloudProviders.copy"
    const val OPEN = "cloudProviders.open"
    const val FIELD = "cloudProviders.field"
    const val SUBMIT = "cloudProviders.submit"
    const val SAVE_TO = "cloudProviders.saveTo"
    const val DONE = "cloudProviders.done"
    const val FAILED = "cloudProviders.failed"
    const val CUSTOM = "cloudProviders.custom"
    const val FAMILY_BACK = "cloudProviders.family.back"
    fun connection(id: String) = "cloudProviders.connection.$id"
    internal fun family(kind: ProviderFamily.Kind) = if (kind == ProviderFamily.Kind.Custom) CUSTOM else "cloudProviders.family.${kind.name}"
    fun way(flow: CloudProviderFlow) = "cloudProviders.way." + if (flow is CloudProviderFlow.ApiKey) "key.${flow.vendor}" else flow.toString()
    fun customField(field: com.slopus.happy.agent.CustomProvider.Problem) = "cloudProviders.custom.${field.name}"
    fun customError(field: com.slopus.happy.agent.CustomProvider.Problem) = "cloudProviders.custom.${field.name}.error"
}

fun NavGraphBuilder.cloudProviderRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudProvidersRoute> { entry ->
        val route = entry.toRoute<CloudProvidersRoute>()
        CloudProvidersPage(graph, nav, route.connectionId, route.choose, route.to)
    }
    page<CloudChatGptRoute> { entry ->
        val route = entry.toRoute<CloudChatGptRoute>()
        CloudSignInPage(graph, nav, route.connectionId, CloudProviders.OPENAI, CloudDestination.of(route.to))
    }
    page<CloudClaudeRoute> { entry ->
        val route = entry.toRoute<CloudClaudeRoute>()
        CloudClaudePage(graph, nav, route.connectionId, CloudDestination.of(route.to))
    }
    page<CloudApiKeyRoute> { entry ->
        val route = entry.toRoute<CloudApiKeyRoute>()
        CloudApiKeyPage(graph, nav, route.connectionId, route.vendor, CloudDestination.of(route.to))
    }
    page<CloudCustomRoute> { entry ->
        CloudCustomPage(graph, nav, entry.toRoute<CloudCustomRoute>().connectionId)
    }
}

/** Opens the providers of [connectionId], with [add]'s flow over them, into [destination] where it says. */
fun NavHostController.openCloudProviders(connectionId: String, add: CloudProviderFlow? = null, destination: CloudDestination? = null) {
    val to = destination?.id
    navigate(CloudProvidersRoute(connectionId, choose = add == CloudProviderFlow.Choose, to = to.takeIf { add == CloudProviderFlow.Choose }))
    when (add) {
        CloudProviderFlow.ChatGpt -> navigate(CloudChatGptRoute(connectionId, to))
        CloudProviderFlow.Claude -> navigate(CloudClaudeRoute(connectionId, to))
        is CloudProviderFlow.ApiKey -> navigate(CloudApiKeyRoute(connectionId, add.vendor, to))
        CloudProviderFlow.Custom -> navigate(CloudCustomRoute(connectionId))
        CloudProviderFlow.Choose, null -> Unit
    }
}

/** Opens [flow]'s page alone (no list under it), keeping what it adds in [destination] where allowed: onboarding's inference gate. */
fun NavHostController.openProviderFlow(connectionId: String, flow: CloudProviderFlow, destination: CloudDestination) {
    val to = destination.id
    when (flow) {
        CloudProviderFlow.ChatGpt -> navigate(CloudChatGptRoute(connectionId, to))
        CloudProviderFlow.Claude -> navigate(CloudClaudeRoute(connectionId, to))
        is CloudProviderFlow.ApiKey -> navigate(CloudApiKeyRoute(connectionId, flow.vendor, to))
        CloudProviderFlow.Custom -> navigate(CloudCustomRoute(connectionId))
        CloudProviderFlow.Choose -> navigate(CloudProvidersRoute(connectionId, choose = true, to = to))
    }
}

/** Where the person may keep what they add: My account with providers.own, Team with providers.manage; My account first. */
internal fun destinations(session: AgentSession): List<CloudDestination> {
    val permissions = session.permissions.value
    return listOfNotNull(
        CloudDestination.Private.takeIf { permissions.allows(Permission.PROVIDERS_OWN) },
        CloudDestination.Team.takeIf { permissions.allows(Permission.PROVIDERS_MANAGE) },
    )
}

/** What a sign-in and a credential are kept in: the link's choice where it is allowed, else the first allowed. */
internal fun destinationFor(allowed: List<CloudDestination>, asked: CloudDestination?): CloudDestination =
    asked?.takeIf { it in allowed } ?: allowed.firstOrNull() ?: CloudDestination.Private

@Composable
private fun CloudProvidersPage(graph: AppGraph, nav: NavHostController, connectionId: String, choose: Boolean, to: String?) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val scope = rememberCoroutineScope()
    val source = remember(session, scope) {
        CloudProvidersSource({ CloudProviders.read(session.client) }, { CloudProviders.signIns(session.client) }, session.events, scope)
    }
    val state by source.connections.collectAsStateWithLifecycle()
    val capabilities by source.capabilities.collectAsStateWithLifecycle()
    val canAdd = destinations(session).isNotEmpty()
    var choosing by rememberSaveable { mutableStateOf(choose) }
    CloudProvidersScreen(state, canAdd = canAdd, onAdd = { choosing = true }, onRetry = source::retry, onBack = { nav.popBackStack() })
    if (choosing) {
        CloudAddChooser(
            capabilities = capabilities,
            custom = CloudDestination.Team in destinations(session),
            onPick = { flow ->
                choosing = false
                when (flow) {
                    CloudProviderFlow.ChatGpt -> nav.navigate(CloudChatGptRoute(connectionId, to))
                    CloudProviderFlow.Claude -> nav.navigate(CloudClaudeRoute(connectionId, to))
                    is CloudProviderFlow.ApiKey -> nav.navigate(CloudApiKeyRoute(connectionId, flow.vendor, to))
                    CloudProviderFlow.Custom -> nav.navigate(CloudCustomRoute(connectionId))
                    CloudProviderFlow.Choose -> Unit
                }
            },
            onDismiss = { choosing = false },
        )
    }
}

/**
 * The connections a conversation can run on, as iOS lists them: Included
 * (Happy (free)), then Team, then My account; each with its vendors and how
 * many credentials it holds, and those it shows, Off or Needs attention
 * where they don't serve. Add below, where the person may add any.
 */
@Composable
internal fun CloudProvidersScreen(
    state: CloudProvidersSource.State,
    canAdd: Boolean,
    onAdd: () -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    Screen(header = { StackHeader(stringResource(R.string.cloud_providers_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(CloudProvidersTags.LIST)) {
            when (state) {
                CloudProvidersSource.State.Loading -> ItemGroup { Item(title = stringResource(R.string.cloud_providers_title), loading = true, showChevron = false) }
                CloudProvidersSource.State.Failed -> ItemGroup {
                    Item(
                        title = stringResource(R.string.cloud_providers_unavailable),
                        subtitle = stringResource(R.string.cloud_providers_try_again),
                        onClick = onRetry,
                        showChevron = false,
                    )
                }
                is CloudProvidersSource.State.Loaded -> {
                    val (included, rest) = state.connections.partition { it.included }
                    val (mine, team) = rest.partition { it.private }
                    ConnectionGroup(stringResource(R.string.cloud_providers_included), included)
                    ConnectionGroup(stringResource(R.string.cloud_providers_team), team)
                    ConnectionGroup(stringResource(R.string.cloud_providers_mine), mine)
                }
            }
            if (canAdd) {
                ItemGroup {
                    Item(
                        title = stringResource(R.string.cloud_providers_add),
                        titleColor = HappyTheme.colors.textLink,
                        showChevron = false,
                        onClick = onAdd,
                        modifier = Modifier.testTag(CloudProvidersTags.ADD),
                    )
                }
            }
        }
    }
}

@Composable
private fun ConnectionGroup(title: String, connections: List<CloudConnection>) {
    ItemGroup(title = title) {
        if (connections.isEmpty()) {
            Item(title = stringResource(R.string.cloud_providers_empty), titleColor = HappyTheme.colors.textSecondary, showChevron = false)
        }
        for (connection in connections) {
            Item(
                title = connectionName(connection),
                subtitle = connection.vendors.joinToString(" · ", transform = ::vendorName).ifEmpty { null },
                detail = if (connection.included) null else pluralStringResource(R.plurals.cloud_providers_credentials, connection.credentialCount, connection.credentialCount),
                enabled = connection.enabled,
                showChevron = false,
                modifier = Modifier.testTag(CloudProvidersTags.connection(connection.id)),
            )
            for (credential in connection.credentials) {
                val off = !credential.enabled
                Item(
                    title = credential.label?.takeIf { it.isNotBlank() } ?: vendorName(credential.vendor),
                    detail = when {
                        credential.needsAttention -> stringResource(R.string.cloud_providers_attention)
                        off -> stringResource(R.string.cloud_providers_off)
                        else -> null
                    },
                    detailColor = if (credential.needsAttention) HappyTheme.colors.textDestructive else HappyTheme.colors.textSecondary,
                    showChevron = false,
                )
            }
        }
    }
}

/** A connection's name as the apps agree to say it: Happy (free), My account, else its own. */
@Composable
internal fun connectionName(connection: CloudConnection): String = when {
    connection.included -> connection.name.ifBlank { stringResource(R.string.cloud_providers_free) }
    connection.id == CloudConnection.PRIVATE -> stringResource(R.string.cloud_providers_mine)
    else -> connection.name.ifBlank { connection.id }
}

/** A credential vendor as people know it. */
internal fun vendorName(vendor: String): String = when (vendor) {
    CloudProviders.OPENAI -> "OpenAI"
    CloudProviders.ANTHROPIC -> "Anthropic"
    CloudProviders.CODEX -> "ChatGPT"
    CloudProviders.CLAUDE_CODE -> "Claude"
    CloudProviders.GROK -> "Grok"
    "bedrock" -> "Bedrock"
    // A team's own endpoint (Add your own endpoint), by the protocol it speaks.
    "openai_compatible" -> "OpenAI-compatible"
    else -> vendor
}

/**
 * The chooser's rows, as iOS lists them (ProviderFamily): one per vendor
 * family, in this order, each with the ways the server offers to add it
 * ([capabilities], null until known: nothing yet). A family with no way
 * isn't shown; Custom only for those who may define the team's own
 * endpoint ([custom]).
 */
internal data class ProviderFamily(val kind: Kind, val ways: List<CloudProviderFlow>) {
    enum class Kind { ChatGpt, Claude, Grok, Custom }

    companion object {
        fun offered(capabilities: CloudCapabilities?, custom: Boolean): List<ProviderFamily> {
            capabilities ?: return emptyList()
            val keys = capabilities.apiKeys
            return listOf(
                ProviderFamily(Kind.ChatGpt, listOfNotNull(CloudProviderFlow.ChatGpt.takeIf { capabilities.codexSignIn }, CloudProviderFlow.ApiKey(CloudProviders.OPENAI).takeIf { keys })),
                ProviderFamily(Kind.Claude, listOfNotNull(CloudProviderFlow.Claude.takeIf { capabilities.claudeSetupToken }, CloudProviderFlow.ApiKey(CloudProviders.ANTHROPIC).takeIf { keys })),
                ProviderFamily(Kind.Grok, listOfNotNull(CloudProviderFlow.ApiKey(CloudProviders.GROK).takeIf { keys })),
                ProviderFamily(Kind.Custom, listOfNotNull(CloudProviderFlow.Custom.takeIf { custom })),
            ).filter { it.ways.isNotEmpty() }
        }
    }
}

/**
 * Add's choices, as a sheet from the bottom: the [ProviderFamily] rows,
 * each with a line for its ways. One with two ways asks which next, in
 * the same sheet.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun CloudAddChooser(capabilities: CloudCapabilities?, onPick: (CloudProviderFlow) -> Unit, onDismiss: () -> Unit, custom: Boolean = false) {
    val colors = HappyTheme.colors
    val sheet = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    fun pick(flow: CloudProviderFlow) {
        scope.launch {
            sheet.hide()
            onPick(flow)
        }
    }
    val families = ProviderFamily.offered(capabilities, custom)
    var opened by rememberSaveable { mutableStateOf<ProviderFamily.Kind?>(null) }
    val family = families.firstOrNull { it.kind == opened }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = colors.surface) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            if (family == null) {
                ChooserTitle(stringResource(R.string.cloud_families_title), onBack = null)
                for (each in families) {
                    val two = each.ways.size > 1
                    Item(
                        title = familyName(each.kind),
                        subtitle = familyWays(each),
                        icon = { FamilyMark(each.kind) },
                        showChevron = two,
                        onClick = { if (two) opened = each.kind else pick(each.ways.single()) },
                        modifier = Modifier.testTag(CloudProvidersTags.family(each.kind)),
                    )
                }
            } else {
                androidx.activity.compose.BackHandler { opened = null }
                ChooserTitle(familyName(family.kind), onBack = { opened = null })
                for (way in family.ways) {
                    val (title, detail) = wayWords(way)
                    Item(
                        title = title,
                        subtitle = detail,
                        showChevron = false,
                        onClick = { pick(way) },
                        modifier = Modifier.testTag(CloudProvidersTags.way(way)),
                    )
                }
            }
        }
    }
}

@Composable
private fun ChooserTitle(title: String, onBack: (() -> Unit)?) {
    val colors = HappyTheme.colors
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().padding(start = if (onBack == null) 24.dp else 8.dp, end = 24.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            androidx.compose.material3.IconButton(onClick = onBack, modifier = Modifier.testTag(CloudProvidersTags.FAMILY_BACK)) {
                com.slopus.happy.ui.components.Icon(com.slopus.happy.ui.components.Ionicon.ChevronBack, 22.dp, colors.textLink)
            }
        }
        Text(title, style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold), color = colors.text)
    }
}

/** ChatGPT's and Claude's own marks on a tile; Grok and Custom a glyph (iOS's ProviderChooser.mark). */
@Composable
private fun FamilyMark(kind: ProviderFamily.Kind) {
    when (kind) {
        ProviderFamily.Kind.ChatGpt -> MarkTile(R.drawable.icon_gpt, SettingsTiles.green)
        ProviderFamily.Kind.Claude -> MarkTile(R.drawable.icon_claude, SettingsTiles.orange)
        ProviderFamily.Kind.Grok -> SettingsTile(com.slopus.happy.ui.components.Ionicon.FlashOutline, SettingsTiles.gray)
        ProviderFamily.Kind.Custom -> SettingsTile(com.slopus.happy.ui.components.Ionicon.CodeSlashOutline, SettingsTiles.blue)
    }
}

@Composable
private fun MarkTile(mark: Int, color: androidx.compose.ui.graphics.Color) {
    androidx.compose.foundation.layout.Box(
        Modifier.size(SettingsPageSpec.tile).clip(androidx.compose.foundation.shape.RoundedCornerShape(SettingsPageSpec.tileRadius)).background(color),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Image(
            painter = androidx.compose.ui.res.painterResource(mark),
            contentDescription = null,
            contentScale = androidx.compose.ui.layout.ContentScale.Fit,
            colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(androidx.compose.ui.graphics.Color.White),
            modifier = Modifier.size(SettingsPageSpec.glyph * 0.9f),
        )
    }
}

@Composable
private fun familyName(kind: ProviderFamily.Kind): String = stringResource(
    when (kind) {
        ProviderFamily.Kind.ChatGpt -> R.string.cloud_families_chatgpt
        ProviderFamily.Kind.Claude -> R.string.cloud_families_claude
        ProviderFamily.Kind.Grok -> R.string.cloud_families_grok
        ProviderFamily.Kind.Custom -> R.string.cloud_families_custom
    },
)

/** The family's line: its ways, "Sign in or API key"; Grok's one key is xAI's, Custom any OpenAI-speaking endpoint. */
@Composable
private fun familyWays(family: ProviderFamily): String {
    if (family.kind == ProviderFamily.Kind.Custom) return stringResource(R.string.cloud_families_custom_ways)
    val ways = family.ways.map { way ->
        when (way) {
            CloudProviderFlow.ChatGpt -> stringResource(R.string.cloud_families_sign_in)
            CloudProviderFlow.Claude -> stringResource(R.string.cloud_families_setup_token)
            else -> stringResource(if (family.kind == ProviderFamily.Kind.Grok) R.string.cloud_families_xai_key else R.string.cloud_families_api_key)
        }
    }
    return if (ways.size == 2) stringResource(R.string.cloud_families_either, ways[0], ways[1]) else ways.joinToString()
}

/** A way's title and what it uses or bills. */
@Composable
private fun wayWords(way: CloudProviderFlow): Pair<String, String?> = when (way) {
    CloudProviderFlow.ChatGpt -> stringResource(R.string.cloud_providers_add_chatgpt) to stringResource(R.string.cloud_families_chatgpt_plan)
    CloudProviderFlow.Claude -> stringResource(R.string.cloud_families_use_setup_token) to stringResource(R.string.cloud_families_claude_plan)
    is CloudProviderFlow.ApiKey -> when (way.vendor) {
        CloudProviders.ANTHROPIC -> stringResource(R.string.cloud_families_anthropic_key) to stringResource(R.string.cloud_families_anthropic_billed)
        CloudProviders.GROK -> stringResource(R.string.cloud_families_xai_key) to stringResource(R.string.cloud_families_xai_billed)
        else -> stringResource(R.string.cloud_families_openai_key) to stringResource(R.string.cloud_families_openai_billed)
    }
    else -> stringResource(R.string.cloud_custom_add) to null
}

/** "Save to": My account or Team, only where the person may pick. */
@Composable
private fun SaveTo(allowed: List<CloudDestination>, picked: CloudDestination, enabled: Boolean, onPick: (CloudDestination) -> Unit) {
    if (allowed.size < 2) return
    ItemGroup(title = stringResource(R.string.cloud_providers_save_to)) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            SegmentedTabs(
                segments = allowed.map { Segment(stringResource(if (it == CloudDestination.Private) R.string.cloud_providers_mine else R.string.cloud_providers_team), "${CloudProvidersTags.SAVE_TO}.${it.id}") },
                selected = allowed.indexOf(picked),
                onPick = { if (enabled) onPick(allowed[it]) },
            )
        }
    }
}

/** Leaves the flow a moment after [done] shows, back on the list, as iOS does. */
@Composable
private fun LeaveWhenDone(done: Boolean, nav: NavHostController) {
    LaunchedEffect(done) {
        if (!done) return@LaunchedEffect
        delay(1_200)
        nav.popBackStack()
    }
}

// ---- ChatGPT (device code) -----------------------------------------------------------------

@Composable
private fun CloudSignInPage(graph: AppGraph, nav: NavHostController, connectionId: String, vendor: String, asked: CloudDestination?) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val allowed = remember(session) { destinations(session) }
    var destination by rememberSaveable { mutableStateOf(destinationFor(allowed, asked)) }
    val scope = rememberCoroutineScope()
    val run = remember(session, destination) { CloudSignInRun(session.client, scope, vendor, destination).also { it.start() } }
    DisposableEffect(run) { onDispose { run.close() } }
    val state by run.current.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val dark = HappyTheme.colors.dark
    LeaveWhenDone(state == CloudSignInRun.State.Done, nav)
    CloudDeviceScreen(
        state = state,
        allowed = allowed,
        destination = destination,
        onDestination = { destination = it },
        onOpen = { url -> openSignInPage(context, url, dark) },
        onRetry = run::start,
        onBack = { nav.popBackStack() },
    )
}

/**
 * ChatGPT's device sign-in: the code to enter at OpenAI, with Copy and
 * Open OpenAI (a Custom Tab), then waiting until the server says how it
 * went. No token ever reaches the phone.
 */
@Composable
internal fun CloudDeviceScreen(
    state: CloudSignInRun.State,
    allowed: List<CloudDestination>,
    destination: CloudDestination,
    onDestination: (CloudDestination) -> Unit,
    onOpen: (String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Screen(header = { StackHeader(stringResource(R.string.cloud_providers_add_chatgpt), onBack) }) {
        ItemList {
            SaveTo(allowed, destination, enabled = state !is CloudSignInRun.State.Done, onPick = onDestination)
            when (state) {
                CloudSignInRun.State.Starting -> ItemGroup { Item(title = stringResource(R.string.cloud_providers_add_chatgpt), loading = true, showChevron = false) }
                is CloudSignInRun.State.Waiting -> ItemGroup {
                    FlowColumn {
                        Text(stringResource(R.string.cloud_providers_device_enter), style = happyTextStyle(fontSize = 15, lineHeight = 21), color = HappyTheme.colors.textSecondary, textAlign = TextAlign.Center)
                        val code = state.userCode.orEmpty()
                        Text(
                            code,
                            style = happyTextStyle(fontSize = 30, lineHeight = 36, weight = FontWeight.SemiBold).copy(fontFamily = FontFamily.Monospace),
                            color = HappyTheme.colors.text,
                            modifier = Modifier.testTag(CloudProvidersTags.CODE),
                        )
                        RoundButton(
                            title = stringResource(R.string.common_copy),
                            display = RoundButtonDisplay.Inverted,
                            onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(code, code))) } },
                            modifier = Modifier.testTag(CloudProvidersTags.COPY),
                        )
                        state.url?.let { url ->
                            RoundButton(title = stringResource(R.string.cloud_providers_open_openai), onClick = { onOpen(url) }, modifier = Modifier.testTag(CloudProvidersTags.OPEN))
                        }
                        Text(stringResource(R.string.cloud_providers_waiting), style = happyTextStyle(fontSize = 14, lineHeight = 20), color = HappyTheme.colors.textSecondary)
                    }
                }
                CloudSignInRun.State.Done -> Outcome(stringResource(R.string.cloud_providers_chatgpt_done), null, null)
                is CloudSignInRun.State.Failed -> Outcome(failureTitle(state.code), state.message ?: stringResource(R.string.cloud_failed), onRetry)
            }
        }
    }
}

@Composable
private fun FlowColumn(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) { content() }
}

/** The end of a flow: [title] (done, or why not), the server's [message], and Try again where it failed. */
@Composable
private fun Outcome(title: String, message: String?, onRetry: (() -> Unit)?) {
    ItemGroup(footer = message, modifier = Modifier.testTag(if (onRetry == null) CloudProvidersTags.DONE else CloudProvidersTags.FAILED)) {
        Item(title = title, showChevron = false, titleColor = if (onRetry == null) HappyTheme.colors.text else HappyTheme.colors.textDestructive)
        onRetry?.let { retry ->
            Item(title = stringResource(R.string.cloud_providers_try_again), titleColor = HappyTheme.colors.textLink, showChevron = false, onClick = retry)
        }
    }
}

@Composable
private fun failureTitle(code: String?): String =
    stringResource(if (code == "expired") R.string.cloud_providers_expired else R.string.cloud_providers_failed)

// ---- Claude (a setup token) --------------------------------------------------------------------

@Composable
private fun CloudClaudePage(graph: AppGraph, nav: NavHostController, connectionId: String, asked: CloudDestination?) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val allowed = remember(session) { destinations(session) }
    var destination by rememberSaveable { mutableStateOf(destinationFor(allowed, asked)) }
    CloudSecretFlow(
        title = stringResource(R.string.cloud_providers_add_setup_token),
        field = stringResource(R.string.cloud_providers_setup_token),
        hint = stringResource(R.string.cloud_providers_setup_token_hint),
        done = stringResource(R.string.cloud_providers_claude_done),
        allowed = allowed,
        destination = destination,
        onDestination = { destination = it },
        vendors = emptyList(),
        add = { _, secret, to -> CloudProviders.addCredential(session.client, CloudProviders.container(to, CloudProviders.CLAUDE_CODE), CloudProviders.CLAUDE_CODE, "oauth_token", secret) },
        nav = nav,
    )
}

@Composable
private fun SecretField(value: String, onChange: (String) -> Unit, placeholder: String, enabled: Boolean, hidden: Boolean) {
    HappyTextField(
        value = value,
        onValueChange = onChange,
        placeholder = placeholder,
        textStyle = happyTextStyle(fontSize = 15, lineHeight = 20),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
        minHeight = 44.dp,
        cornerRadius = 8.dp,
        singleLine = true,
        enabled = enabled,
        visualTransformation = if (hidden) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (hidden) KeyboardType.Password else KeyboardType.Ascii, imeAction = ImeAction.Done, autoCorrectEnabled = false),
        modifier = Modifier.testTag(CloudProvidersTags.FIELD),
    )
}

// ---- API keys and setup tokens --------------------------------------------------------------

@Composable
private fun CloudApiKeyPage(graph: AppGraph, nav: NavHostController, connectionId: String, vendor: String?, asked: CloudDestination?) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val allowed = remember(session) { destinations(session) }
    var destination by rememberSaveable { mutableStateOf(destinationFor(allowed, asked)) }
    CloudSecretFlow(
        title = stringResource(R.string.cloud_providers_add_key),
        field = stringResource(R.string.cloud_providers_key),
        hint = null,
        done = stringResource(R.string.cloud_providers_key_done),
        allowed = allowed,
        destination = destination,
        onDestination = { destination = it },
        vendors = listOf(CloudProviders.OPENAI, CloudProviders.ANTHROPIC, CloudProviders.GROK),
        initialVendor = vendor,
        add = { picked, secret, to -> CloudProviders.addCredential(session.client, CloudProviders.container(to, picked), picked, "api_key", secret) },
        nav = nav,
    )
}

/** One secret checked and kept by the server: an API key (OpenAI, Anthropic or Grok), or a Claude setup token. */
@Composable
private fun CloudSecretFlow(
    title: String,
    field: String,
    hint: String?,
    done: String,
    allowed: List<CloudDestination>,
    destination: CloudDestination,
    onDestination: (CloudDestination) -> Unit,
    vendors: List<String>,
    add: suspend (vendor: String, secret: String, to: CloudDestination) -> Unit,
    nav: NavHostController,
    initialVendor: String? = null,
) {
    val scope = rememberCoroutineScope()
    var vendor by rememberSaveable { mutableStateOf(initialVendor?.takeIf { it in vendors } ?: vendors.firstOrNull().orEmpty()) }
    var phase by remember { mutableStateOf<SecretPhase>(SecretPhase.Editing) }
    LeaveWhenDone(phase == SecretPhase.Done, nav)
    CloudSecretScreen(
        title = title,
        field = field,
        hint = hint,
        done = done,
        allowed = allowed,
        destination = destination,
        onDestination = onDestination,
        vendors = vendors,
        vendor = vendor,
        onVendor = { vendor = it },
        phase = phase,
        onSubmit = { secret ->
            phase = SecretPhase.Checking
            scope.launch {
                phase = try {
                    add(vendor, secret.trim(), destination)
                    SecretPhase.Done
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CloudProviderException) {
                    SecretPhase.Failed(e.message)
                } catch (_: Exception) {
                    SecretPhase.Failed(null)
                }
            }
        },
        onRetry = { phase = SecretPhase.Editing },
        onBack = { nav.popBackStack() },
    )
}

internal sealed interface SecretPhase {
    data object Editing : SecretPhase
    data object Checking : SecretPhase
    data object Done : SecretPhase
    data class Failed(val message: String?) : SecretPhase
}

@Composable
internal fun CloudSecretScreen(
    title: String,
    field: String,
    hint: String?,
    done: String,
    allowed: List<CloudDestination>,
    destination: CloudDestination,
    onDestination: (CloudDestination) -> Unit,
    vendors: List<String>,
    vendor: String,
    onVendor: (String) -> Unit,
    phase: SecretPhase,
    onSubmit: (String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    // Held only while the page is up; never saved with its state.
    var secret by remember { mutableStateOf("") }
    val busy = phase == SecretPhase.Checking || phase == SecretPhase.Done
    Screen(header = { StackHeader(title, onBack) }) {
        ItemList {
            SaveTo(allowed, destination, enabled = !busy, onPick = onDestination)
            when (phase) {
                SecretPhase.Done -> Outcome(done, null, null)
                is SecretPhase.Failed -> Outcome(stringResource(R.string.cloud_providers_key_failed), phase.message ?: stringResource(R.string.cloud_failed), onRetry)
                else -> ItemGroup(footer = hint) {
                    FlowColumn {
                        if (vendors.size > 1) {
                            SegmentedTabs(
                                segments = vendors.map { Segment(vendorName(it), "cloudProviders.vendor.$it") },
                                selected = vendors.indexOf(vendor).coerceAtLeast(0),
                                onPick = { if (!busy) onVendor(vendors[it]) },
                            )
                        }
                        SecretField(secret, { secret = it }, field, enabled = !busy, hidden = true)
                        RoundButton(
                            title = stringResource(R.string.cloud_providers_add),
                            onClick = { onSubmit(secret) },
                            enabled = secret.isNotBlank(),
                            loading = phase == SecretPhase.Checking,
                            loadingTitle = stringResource(R.string.cloud_providers_checking),
                            modifier = Modifier.testTag(CloudProvidersTags.SUBMIT),
                        )
                    }
                }
            }
        }
    }
}

// ---- The team's own endpoint ----------------------------------------------------------------

@Composable
private fun CloudCustomPage(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val scope = rememberCoroutineScope()
    val taken = stringResource(R.string.cloud_custom_exists)
    var phase by remember { mutableStateOf<SecretPhase>(SecretPhase.Editing) }
    LeaveWhenDone(phase == SecretPhase.Done, nav)
    CloudCustomScreen(
        phase = phase,
        onSubmit = { draft ->
            phase = SecretPhase.Checking
            scope.launch {
                phase = try {
                    CloudProviders.defineCustom(session.client, draft)
                    SecretPhase.Done
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CloudProviderException) {
                    SecretPhase.Failed(if (e.kind == CustomProvider.EXISTS) taken else e.message)
                } catch (_: Exception) {
                    SecretPhase.Failed(null)
                }
            }
        },
        onRetry = { phase = SecretPhase.Editing },
        onBack = { nav.popBackStack() },
    )
}

/**
 * The team's own endpoint in one form: its name, the ID its models are
 * named by (suggested from the name until edited), an https base URL, its
 * model IDs and its key. What the server would refuse is said under its
 * field before anything is sent; the server's own refusal ends the form
 * with Try again, which brings it back as it was but for the key.
 */
@Composable
internal fun CloudCustomScreen(
    phase: SecretPhase,
    onSubmit: (CustomProvider) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    var id by rememberSaveable { mutableStateOf("") }
    var idEdited by rememberSaveable { mutableStateOf(false) }
    var baseUrl by rememberSaveable { mutableStateOf("") }
    var models by rememberSaveable { mutableStateOf("") }
    // Held only while the page is up; never saved with its state.
    var apiKey by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf<CustomProvider.Problem?>(null) }
    val draft = CustomProvider(name, if (idEdited) id else CustomProvider.idFor(name), baseUrl, models, apiKey)
    val busy = phase == SecretPhase.Checking || phase == SecretPhase.Done
    fun submit() {
        shown = draft.problem()
        if (shown == null && !busy) onSubmit(draft)
    }
    Screen(header = { StackHeader(stringResource(R.string.cloud_custom_add), onBack) }, avoidKeyboard = true) {
        ItemList {
            when (phase) {
                SecretPhase.Done -> Outcome(stringResource(R.string.cloud_custom_done), null, null)
                is SecretPhase.Failed -> Outcome(stringResource(R.string.cloud_custom_failed), phase.message ?: stringResource(R.string.cloud_failed), onRetry)
                else -> ItemGroup(footer = stringResource(R.string.cloud_custom_footer)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        CustomField(
                            CustomProvider.Problem.Name, stringResource(R.string.cloud_custom_name), name, { name = it }, "Acme vLLM",
                            error = R.string.cloud_custom_name_error, shown = shown, enabled = !busy,
                            keyboard = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Words, imeAction = ImeAction.Next),
                        )
                        CustomField(
                            CustomProvider.Problem.Id, stringResource(R.string.cloud_custom_id), draft.id, { id = it.lowercase(); idEdited = true }, "acme",
                            error = R.string.cloud_custom_id_error, shown = shown, enabled = !busy, help = stringResource(R.string.cloud_custom_id_help),
                            keyboard = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                        )
                        CustomField(
                            CustomProvider.Problem.BaseUrl, stringResource(R.string.cloud_custom_base_url), baseUrl, { baseUrl = it }, "https://llm.example.com/v1",
                            error = R.string.cloud_custom_base_url_error, shown = shown, enabled = !busy,
                            keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                        )
                        CustomField(
                            CustomProvider.Problem.Models, stringResource(R.string.cloud_custom_models), models, { models = it }, "llama-4-70b, qwen-3",
                            error = R.string.cloud_custom_models_error, shown = shown, enabled = !busy, help = stringResource(R.string.cloud_custom_models_help),
                            keyboard = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                        )
                        CustomField(
                            CustomProvider.Problem.ApiKey, stringResource(R.string.cloud_providers_key), apiKey, { apiKey = it }, stringResource(R.string.cloud_providers_key),
                            error = R.string.cloud_custom_key_error, shown = shown, enabled = !busy, hidden = true,
                            keyboard = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                            onDone = ::submit,
                        )
                        RoundButton(
                            title = stringResource(R.string.cloud_providers_add),
                            onClick = ::submit,
                            enabled = name.isNotBlank() && baseUrl.isNotBlank() && models.isNotBlank() && apiKey.isNotBlank(),
                            loading = phase == SecretPhase.Checking,
                            loadingTitle = stringResource(R.string.cloud_providers_checking),
                            modifier = Modifier.fillMaxWidth().testTag(CloudProvidersTags.SUBMIT),
                        )
                    }
                }
            }
        }
    }
}

/** One labelled field of [CloudCustomScreen], with [error] under it while it is the [shown] problem. */
@Composable
private fun CustomField(
    field: CustomProvider.Problem,
    label: String,
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    error: Int,
    shown: CustomProvider.Problem?,
    enabled: Boolean,
    keyboard: KeyboardOptions,
    help: String? = null,
    hidden: Boolean = false,
    onDone: (() -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
        HappyTextField(
            value = value,
            onValueChange = onChange,
            placeholder = placeholder,
            textStyle = happyTextStyle(fontSize = 15, lineHeight = 20),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            minHeight = 44.dp,
            cornerRadius = 8.dp,
            singleLine = true,
            enabled = enabled,
            visualTransformation = if (hidden) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            keyboardOptions = keyboard,
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { onDone?.invoke() }),
            modifier = Modifier.testTag(CloudProvidersTags.customField(field)),
        )
        if (shown == field) {
            Text(stringResource(error), style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textDestructive, modifier = Modifier.testTag(CloudProvidersTags.customError(field)))
        }
        if (help != null) Text(help, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
    }
}
