package com.slopus.happy.ui.connection

import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import com.slopus.happy.ui.settings.SettingsTags
import com.slopus.happy.ui.components.ProvideRowReveal
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentProfileState
import com.slopus.happy.agent.CompletionSound
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.conversation.openChiefOfStaff
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.settings.AboutActions
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.AccountsCard
import com.slopus.happy.ui.settings.AccountsCardActions
import com.slopus.happy.ui.settings.RemoveCard
import com.slopus.happy.ui.settings.SettingsEditItem
import com.slopus.happy.ui.settings.SettingsHeader
import com.slopus.happy.ui.settings.SettingsPageSpec
import com.slopus.happy.ui.settings.SettingsPageTags
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.settings.SettingsCard
import com.slopus.happy.ui.settings.SettingsEntry
import com.slopus.happy.ui.settings.SettingsSearchBar
import com.slopus.happy.ui.settings.SettingsSearchButton
import com.slopus.happy.ui.settings.SettingsSearchResults
import com.slopus.happy.ui.settings.SettingsSection
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.aboutSection
import com.slopus.happy.ui.settings.addAgentEntry
import com.slopus.happy.ui.settings.rememberSettingsSearch
import com.slopus.happy.ui.settings.settingsProfileEntries
import com.slopus.happy.ui.settings.settingsSearchResults
import com.slopus.happy.ui.settings.supportSection
import com.slopus.happy.ui.settings.kindSubtitle
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.settings.rememberAboutActions
import com.slopus.happy.ui.settings.rememberAboutInfo
import com.slopus.happy.ui.settings.rememberLast
import com.slopus.happy.ui.LocalAccountSwitcher
import com.slopus.happy.ui.AccountSwitcher
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.SettingsDissolveBox
import androidx.compose.foundation.ScrollState
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** The agent connection screens beside home and Settings ([SettingsRoute]). HappyApp's NavHost calls this once. */
fun NavGraphBuilder.agentHomeRoutes(graph: AppGraph, nav: NavHostController) {
    agentSettingsPages(graph, nav)
}

/** Where a row of an agent connection's settings is: its page, or the picture's menu (an ask, which runs). */
enum class AgentSettingsPlace { Settings, Appearance, Ask }

/**
 * One row of an agent connection's settings as home's search finds it
 * (iOS's `SettingsIndex.Entry`): the id the page tags and reveals it by,
 * its title there, its glyph, and where it is. [ask] is an ask's words.
 */
@Immutable
data class AgentSettingsRow(val id: String, val title: String, val icon: Ionicon, val place: AgentSettingsPlace, val ask: String? = null)

/**
 * iOS's `SettingsIndex.computer`: what an agent connection's settings show,
 * in their order, the picture's two asks and Appearance's Hide projects
 * included. Disconnect is left out: a search doesn't offer to take the
 * connection away. The titles are the page's own (`AgentSettingsIndexTest`).
 */
@Composable
fun agentSettingsIndex(): List<AgentSettingsRow> {
    fun row(id: String, title: String, icon: Ionicon, place: AgentSettingsPlace = AgentSettingsPlace.Settings, ask: String? = null) =
        AgentSettingsRow(id, title, icon, place, ask)
    return listOf(
        row(AgentSettingsTags.PROFILE, stringResource(R.string.settings_account_profile), Ionicon.PersonCircleOutline),
        row(AgentSettingsTags.ASK_NAME, stringResource(R.string.agent_settings_edit_name), Ionicon.CreateOutline, AgentSettingsPlace.Ask, stringResource(R.string.agent_settings_edit_name_prefix)),
        row(AgentSettingsTags.ASK_AVATAR, stringResource(R.string.agent_settings_edit_avatar), Ionicon.ImageOutline, AgentSettingsPlace.Ask, stringResource(R.string.agent_settings_edit_avatar_prefix)),
        row(AgentSettingsTags.APPEARANCE, stringResource(R.string.settings_appearance), Ionicon.ColorPaletteOutline),
        row(AgentPagesTags.HIDE_PROJECTS_ROW, stringResource(R.string.settings_hide_projects), Ionicon.FolderOutline, AgentSettingsPlace.Appearance),
        row(DataStorageTags.ROW, stringResource(R.string.data_storage_title), Ionicon.ServerOutline),
        row(SettingsTags.SUPPORT, stringResource(R.string.settings_support_us), Ionicon.HeartOutline),
        row(SettingsTags.MANAGE_SUBSCRIPTIONS, stringResource(R.string.settings_manage_subscriptions), Ionicon.CardOutline),
        row(SettingsPageTags.ADD_AGENT, stringResource(R.string.settings_add_agent), Ionicon.Add),
        row(SettingsTags.WHATS_NEW, stringResource(R.string.settings_whats_new), Ionicon.SparklesOutline),
        row(SettingsTags.GITHUB, stringResource(R.string.settings_github), Ionicon.LogoGithub),
        row(SettingsTags.REPORT_ISSUE, stringResource(R.string.settings_report_issue), Ionicon.BugOutline),
        row(SettingsTags.PRIVACY, stringResource(R.string.settings_privacy_policy), Ionicon.ShieldCheckmarkOutline),
        row(SettingsTags.TERMS, stringResource(R.string.settings_terms_of_service), Ionicon.DocumentTextOutline),
        row(SettingsTags.VERSION, stringResource(R.string.common_version), Ionicon.InformationCircleOutline),
    )
}

/**
 * Opens [row] as iOS's `SettingsViewController.open(reveal:)` does: the
 * connection's settings, scrolled to the row with it flashing; a row of
 * Appearance's on that page, over settings; an ask runs, the Chief of
 * Staff's chat opening with its words typed in.
 */
fun NavHostController.openAgentSettingsRow(connectionId: String, row: AgentSettingsRow) {
    when (row.place) {
        AgentSettingsPlace.Settings -> navigate(SettingsRoute(reveal = row.id))
        AgentSettingsPlace.Appearance -> {
            navigate(SettingsRoute())
            navigate(AgentAppearanceRoute(connectionId, reveal = row.id))
        }
        AgentSettingsPlace.Ask -> openChiefOfStaff(connectionId, row.ask.orEmpty())
    }
}

object AgentSettingsTags {
    const val DAEMON_VERSION = "agentSettings.daemonVersion"
    const val BAR = "agentSettings.bar"
    const val PROFILE = "agentSettings.profile"
    const val APPEARANCE = "agentSettings.appearance"
    /** The picture's two asks, as search finds them. */
    const val ASK_NAME = "agentSettings.ask.name"
    const val ASK_AVATAR = "agentSettings.ask.avatar"
}

/** Everything an agent connection's settings ask of the app. */
@Immutable
class AgentSettingsActions(
    val onBack: () -> Unit = {},
    /** The person's own name and picture on this agent. */
    val onProfile: () -> Unit = {},
    val onAppearance: () -> Unit = {},
    /** Data and Storage: the media kept on this phone; null where nothing is kept. */
    val onDataStorage: (() -> Unit)? = null,
    /** Disconnects this connection; asked for only after the person confirmed. */
    val onRemove: () -> Unit = {},
    /** Opens this connection's Chief of Staff with [prefix] typed, unsent. */
    val onAskChief: (prefix: String) -> Unit = {},
)

/** The Profile row: the person's own name and picture on the agent. */
@Immutable
data class AgentPerson(val name: String = "", val photo: ImageBitmap? = null, val seed: String? = null)

/**
 * An agent connection's settings, as iOS's SettingsViewController lays out
 * a connection's page: the agent's own picture, large and centred, with a
 * pencil badge whose menu asks its Chief of Staff to change its picture or
 * name (nothing is sent until the person sends it), its name and link
 * status under it; every account on the phone with Add Agent; the person's
 * own Profile here; Appearance (the theme and the desktop's Hide projects);
 * Support us; About; Disconnect, after a confirm. A device token can't reach
 * the agent's device list (API.md, "Credentials on the connector's
 * socket"), so disconnecting forgets the agent on this phone only.
 *
 * Search, as on a Happy account's page ([SettingsSearchResults]), finds the
 * accounts by name, the picture's two asks (which run), this page's rows
 * and [appearance]'s, which change in place.
 */
@Composable
fun AgentConnectionSettingsScreen(
    profile: SettingsProfile,
    accounts: AccountMenu,
    actions: AgentSettingsActions,
    about: AboutInfo,
    accountActions: AccountsCardActions = AccountsCardActions({}, {}),
    aboutActions: AboutActions = AboutActions(),
    person: AgentPerson = AgentPerson(),
    /** Appearance's rows, for search: found, they change here, as on their page. */
    appearance: List<SettingsEntry> = emptyList(),
    /** Where the page is scrolled; shared with the other kind's page, so a switch keeps it (AccountSettings). */
    scroll: ScrollState = rememberScrollState(),
    daemonVersion: String? = null,
) {
    val namePrefix = stringResource(R.string.agent_settings_edit_name_prefix)
    val avatarPrefix = stringResource(R.string.agent_settings_edit_avatar_prefix)
    val changeAvatar = stringResource(R.string.settings_change_avatar)
    val editName = stringResource(R.string.settings_edit_name)
    val edit = listOf(
        SettingsEditItem(changeAvatar, Ionicon.ImageOutline, SettingsPageTags.EDIT_AVATAR) { actions.onAskChief(avatarPrefix) },
        SettingsEditItem(editName, Ionicon.Pencil, SettingsPageTags.EDIT_NAME) { actions.onAskChief(namePrefix) },
    )
    val search = rememberSettingsSearch()
    val sections = listOf(
        SettingsSection(
            listOf(
                SettingsEntry(
                    id = AgentSettingsTags.PROFILE,
                    title = stringResource(R.string.settings_account_profile),
                    icon = { PersonPicture(person.photo, person.seed ?: profile.id, SettingsPageSpec.tile) },
                    detail = person.name.takeIf { it.isNotEmpty() },
                    onClick = actions.onProfile,
                ),
            ),
        ),
        SettingsSection(
            listOf(
                SettingsEntry(
                    id = AgentSettingsTags.APPEARANCE,
                    title = stringResource(R.string.settings_appearance),
                    icon = { SettingsTile(Ionicon.ColorPaletteOutline, SettingsTiles.purple) },
                    onClick = actions.onAppearance,
                ),
            ) + listOfNotNull(
                actions.onDataStorage?.let { open ->
                    SettingsEntry(
                        id = DataStorageTags.ROW,
                        title = stringResource(R.string.data_storage_title),
                        icon = { SettingsTile(Ionicon.ServerOutline, SettingsTiles.green) },
                        onClick = open,
                    )
                },
            ),
        ),
        SettingsSection(
            listOfNotNull(daemonVersion?.takeIf(String::isNotBlank)?.let { version ->
                SettingsEntry(
                    id = AgentSettingsTags.DAEMON_VERSION,
                    title = "${stringResource(R.string.account_kind_agent)} · ${stringResource(R.string.common_version)}",
                    detail = version,
                    icon = { SettingsTile(Ionicon.InformationCircleOutline, SettingsTiles.gray) },
                    chevron = false,
                )
            }),
        ),
        supportSection(about, aboutActions),
        aboutSection(about, aboutActions),
    ).filter { it.rows.isNotEmpty() }
    // The bar on the page's own grey (black in dark), the groups on it: one surface, as the chat's details.
    Screen(
        header = {
            if (search.searching) {
                SettingsSearchBar(search, AgentSettingsTags.BAR)
            } else {
                AgentTopBar(
                    tag = AgentSettingsTags.BAR,
                    container = HappyTheme.colors.grouped.background,
                    navigationIcon = { BackOrSidebarToggle { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), actions.onBack) } },
                    title = { Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleLarge, maxLines = 1) },
                    actions = { SettingsSearchButton(search) },
                )
            }
        },
        avoidKeyboard = search.searching,
    ) {
        if (search.searching) {
            // The picture's two asks, found here, run: the Chief of Staff's chat opens with the words typed in.
            val asks = listOf(
                SettingsEntry(AgentSettingsTags.ASK_NAME, stringResource(R.string.agent_settings_edit_name), icon = { SettingsTile(Ionicon.CreateOutline, SettingsTiles.blue) }, chevron = false, onClick = { actions.onAskChief(namePrefix) }, closesSearch = true),
                SettingsEntry(AgentSettingsTags.ASK_AVATAR, stringResource(R.string.agent_settings_edit_avatar), icon = { SettingsTile(Ionicon.ImageOutline, SettingsTiles.orange) }, chevron = false, onClick = { actions.onAskChief(avatarPrefix) }, closesSearch = true),
            )
            val profiles = settingsProfileEntries(accounts, accountActions.onSwitch)
            val rows = listOf(addAgentEntry(accountActions)) + sections.flatMap { it.rows } + appearance
            SettingsSearchResults(search, settingsSearchResults(search.query, profiles, asks, rows))
        } else {
            SettingsDissolveBox {
                ItemList(scrollState = scroll) {
                    SettingsHeader(profile, edit)
                    AccountsCard(accounts, accountActions)
                    for (section in sections) SettingsCard(section)
                    RemoveCard(agent = true, name = profile.name, onRemove = actions.onRemove)
                }
            }
        }
    }
}

/** The person's picture round at [size], else the one [seed] picks (as their Profile page shows it). */
@Composable
internal fun PersonPicture(photo: ImageBitmap?, seed: String, size: Dp) {
    if (photo != null) {
        Image(photo, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(CircleShape))
    } else {
        Avatar(seed, size)
    }
}

/** [bytes] decoded once per array; null for none or bytes that aren't an image. */
@Composable
internal fun rememberPhoto(bytes: ByteArray?): ImageBitmap? = remember(bytes) {
    bytes?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() }
}

@Composable
internal fun statusText(status: AgentLinkStatus): String = stringResource(
    when (status) {
        AgentLinkStatus.Connected -> R.string.agent_settings_connected
        AgentLinkStatus.Connecting -> R.string.agent_settings_connecting
        AgentLinkStatus.Offline -> R.string.agent_settings_offline
        AgentLinkStatus.Revoked -> R.string.agent_settings_revoked
        AgentLinkStatus.UpdateRequired -> R.string.agent_settings_update
        AgentLinkStatus.SignInRequired -> R.string.team_server_settings_signed_out
    },
)

/**
 * Forgets the agent connection [id] on this phone. When it was open, the
 * next account opens: a Happy account first, else another agent; none, the
 * first screen.
 */
internal suspend fun removeAgentConnection(graph: AppGraph, id: String) = graph.whileSwitching {
    val open = graph.openAgentId.value == id
    val next = graph.accountStore.registry.value.ordered.firstOrNull()?.id
        ?: graph.agentConnections.accounts.value.filter { it.id != id }.minByOrNull { it.addedAt }?.id
    graph.agentConnections.remove(id)
    if (!open) return@whileSwitching
    if (next != null) {
        graph.open(next).join()
    } else {
        withContext(Dispatchers.IO) { graph.accountStore.select(null) }
        graph.auth.reload()
    }
}

/**
 * The accounts card's actions, the same on both kinds of page: a tap opens
 * another account without leaving Settings ([AccountSwitcher.fromSettings]),
 * Add scans, holding an agent connection disconnects it and holding a Happy
 * account signs that account out, even when another is open. Taking away the
 * open one keeps Settings, over the next account's home.
 */
@Composable
internal fun rememberAccountsCardActions(graph: AppGraph): AccountsCardActions {
    val scope = rememberCoroutineScope()
    val add = LocalAddFlow.current
    val switcher = LocalAccountSwitcher.current
    return remember(graph, add, switcher) {
        AccountsCardActions(
            onSwitch = { id -> if (switcher != null) switcher.fromSettings(id) else graph.open(id) },
            onAdd = { add?.scan() },
            onRemove = { entry ->
                val remove: suspend () -> Unit = if (entry.agent) {
                    { removeAgentConnection(graph, entry.id) }
                } else {
                    { graph.logout(entry.id).join() }
                }
                val open = graph.openAccount.value.id == entry.id
                if (switcher != null && open) switcher.removingFromSettings(remove) else scope.launch { remove() }
            },
            canRemove = { true },
        )
    }
}

/** Agent connection [connectionId]'s Settings, scrolled by [scroll] (AccountSettings). */
@Composable
internal fun AgentConnectionSettings(graph: AppGraph, nav: NavHostController, connectionId: String, scroll: ScrollState) {
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    // Disconnecting from here, the page stays as it was until the next account's takes its place.
    val agent = rememberLast(agents.firstOrNull { it.id == connectionId })?.takeIf { it.id == connectionId } ?: return
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val status = session?.status?.collectAsStateWithLifecycle()?.value ?: AgentLinkStatus.Offline
    val personState = session?.profile?.state?.collectAsStateWithLifecycle()?.value ?: AgentProfileState()
    val personPhoto = rememberPhoto(session?.profile?.photo?.collectAsStateWithLifecycle()?.value)
    val theme by graph.localSettings.themePreference.collectAsStateWithLifecycle()
    val sound = session?.completionSound?.collectAsStateWithLifecycle()?.value ?: CompletionSound.Always
    val projectsHidden = session?.projectsHidden?.collectAsStateWithLifecycle()?.value ?: false
    // Read every time the page shows, as iOS's Profile row is.
    LaunchedEffect(session) { session?.profile?.refresh() }
    val scope = rememberCoroutineScope()
    val accounts = rememberAccountMenu(graph).shownAs(connectionId)
    val switcher = LocalAccountSwitcher.current
    val actions = remember(graph, nav, connectionId, switcher) {
        AgentSettingsActions(
            onBack = { nav.popBackStack() },
            onProfile = { nav.navigate(AgentProfileRoute(connectionId)) },
            onAppearance = { nav.navigate(AgentAppearanceRoute(connectionId)) },
            onDataStorage = { nav.navigate(AgentDataStorageRoute(connectionId)) },
            onAskChief = { prefix -> nav.openChiefOfStaff(connectionId, prefix) },
            onRemove = {
                if (switcher != null) switcher.removingFromSettings { removeAgentConnection(graph, connectionId) }
                else scope.launch { removeAgentConnection(graph, connectionId) }
            },
        )
    }
    AgentConnectionSettingsScreen(
        profile = SettingsProfile(
            id = connectionId,
            seed = accounts.entries.firstOrNull { it.id == connectionId }?.seed ?: connectionId,
            name = agent.name.ifEmpty { stringResource(R.string.account_kind_agent) },
            subtitle = kindSubtitle(stringResource(R.string.account_kind_agent), statusText(status)),
            imageUri = agent.avatarFile?.let { "file://$it" },
            thumbhash = agent.thumbhash,
        ),
        accounts = accounts,
        actions = actions,
        about = rememberAboutInfo(graph),
        accountActions = rememberAccountsCardActions(graph),
        aboutActions = rememberAboutActions(graph, nav),
        person = AgentPerson(personState.name, personPhoto, rememberPersonSeed(graph, connectionId)),
        appearance = agentAppearanceSections(theme, graph.localSettings::setThemePreference, projectsHidden, { session?.setProjectsHidden(it) }, sound, { session?.setCompletionSound(it) }).flatMap { it.rows },
        scroll = scroll,
        daemonVersion = agent.daemonVersion,
    )
}
