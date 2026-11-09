package com.slopus.happy.ui.connection

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
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

/** An OpenAI or Anthropic API key; [vendor] picks the vendor first. */
@Serializable data class CloudApiKeyRoute(val connectionId: String, val vendor: String? = null, val to: String? = null)

/** What a providers link opens over the list (w8548's shared targets). */
sealed interface CloudProviderFlow {
    data object Choose : CloudProviderFlow
    data object ChatGpt : CloudProviderFlow
    data object Claude : CloudProviderFlow
    data class ApiKey(val vendor: String? = null) : CloudProviderFlow
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
    fun connection(id: String) = "cloudProviders.connection.$id"
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
}

/** Opens the providers of [connectionId], with [add]'s flow over them, into [destination] where it says. */
fun NavHostController.openCloudProviders(connectionId: String, add: CloudProviderFlow? = null, destination: CloudDestination? = null) {
    val to = destination?.id
    navigate(CloudProvidersRoute(connectionId, choose = add == CloudProviderFlow.Choose, to = to.takeIf { add == CloudProviderFlow.Choose }))
    when (add) {
        CloudProviderFlow.ChatGpt -> navigate(CloudChatGptRoute(connectionId, to))
        CloudProviderFlow.Claude -> navigate(CloudClaudeRoute(connectionId, to))
        is CloudProviderFlow.ApiKey -> navigate(CloudApiKeyRoute(connectionId, add.vendor, to))
        CloudProviderFlow.Choose, null -> Unit
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
            onPick = { flow ->
                choosing = false
                when (flow) {
                    CloudProviderFlow.ChatGpt -> nav.navigate(CloudChatGptRoute(connectionId, to))
                    CloudProviderFlow.Claude -> nav.navigate(CloudClaudeRoute(connectionId, to))
                    is CloudProviderFlow.ApiKey -> nav.navigate(CloudApiKeyRoute(connectionId, flow.vendor, to))
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
    "grok" -> "Grok"
    "bedrock" -> "Bedrock"
    else -> vendor
}

/**
 * Add's choices, as a sheet from the bottom (iOS's action sheet): a
 * ChatGPT and a Claude sign-in, a Claude setup token where Claude's sign-in
 * isn't offered, and an API key; each where the server offers it
 * ([capabilities], null until known: nothing yet).
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun CloudAddChooser(capabilities: CloudCapabilities?, onPick: (CloudProviderFlow) -> Unit, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val sheet = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    fun pick(flow: CloudProviderFlow) {
        scope.launch {
            sheet.hide()
            onPick(flow)
        }
    }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = colors.surface) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            if (capabilities?.codexSignIn == true) {
                Item(
                    title = stringResource(R.string.cloud_providers_add_chatgpt),
                    icon = { ProviderIcon(ProviderIconKind.Codex, size = 24.dp) },
                    showChevron = false,
                    onClick = { pick(CloudProviderFlow.ChatGpt) },
                )
            }
            if (capabilities?.claudeSetupToken == true) {
                Item(
                    title = stringResource(R.string.cloud_providers_add_setup_token),
                    icon = { ProviderIcon(ProviderIconKind.Claude, size = 24.dp) },
                    showChevron = false,
                    onClick = { pick(CloudProviderFlow.Claude) },
                )
            }
            if (capabilities?.apiKeys == true) {
                Item(
                    title = stringResource(R.string.cloud_providers_add_key),
                    icon = { com.slopus.happy.ui.components.Icon(com.slopus.happy.ui.components.Ionicon.KeyOutline, 24.dp, colors.textSecondary) },
                    showChevron = false,
                    onClick = { pick(CloudProviderFlow.ApiKey()) },
                )
            }
        }
    }
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
        vendors = listOf(CloudProviders.OPENAI, CloudProviders.ANTHROPIC),
        initialVendor = vendor,
        add = { picked, secret, to -> CloudProviders.addCredential(session.client, CloudProviders.container(to, picked), picked, "api_key", secret) },
        nav = nav,
    )
}

/** One secret checked and kept by the server: an API key (OpenAI or Anthropic), or a Claude setup token. */
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
