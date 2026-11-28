package com.slopus.happy.ui.connection

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.ui.connect.LocalAddFlow
import com.slopus.happy.ui.backStackEntries
import com.slopus.happy.ui.rememberHomeAccountSwitch
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.surfaces.openSurface
import com.slopus.happy.ui.tablet.MainPanel
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.agent.homePage
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuDropdown
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.theme.HappyTheme

object AgentDrawerTags {
    const val SHEET = "agentDrawer"
    const val HEADER = "agentDrawer.header"
    const val SETTINGS = "agentDrawer.settings"
    fun item(key: String) = "agentDrawer.item.$key"
}

/**
 * What an agent connection's drawer lists (Steve, every phone): Home, then
 * home's places in a fixed order (Activity, Artifacts, Documents, TODOs,
 * Plugins, Pipelines, each where the connection has it), then the other
 * Surfaces the person joined, in their own order, under a divider. Each
 * is keyed as the stack names its root ([MainPanelKey]); Home is [HOME].
 */
@Immutable
data class AgentDrawerItems(val places: List<AgentFeedRow>, val surfaces: List<AgentFeedRow.Surface>) {
    companion object {
        const val HOME = "home"

        private val order = listOf(MainPanelKey.FEED, MainPanelKey.ARTIFACTS, MainPanelKey.DOCUMENTS, MainPanelKey.TODOS, MainPanelKey.PLUGINS, MainPanelKey.PIPELINES)

        fun of(feed: AgentFeed): AgentDrawerItems {
            val places = feed.places()
            return AgentDrawerItems(
                places.filter { it.homePage }.sortedBy { order.indexOf(it.panelKey()) },
                places.filterIsInstance<AgentFeedRow.Surface>(),
            )
        }

        /**
         * The item for the stack's root [root] ([MainPanelKey.of], null with
         * home alone): its own, a document's or todo list's section, or Home
         * for anything opened from home (a conversation, a new chat).
         */
        fun selected(root: String?, feed: AgentFeed): String {
            if (root == null) return HOME
            val items = of(feed)
            if (items.places.any { it.panelKey() == root } || items.surfaces.any { it.panelKey() == root }) return root
            if (root == MainPanelKey.SETTINGS) return root
            val list = feed.lists.firstOrNull { MainPanelKey.surface(it.id) == root }
            return when (list?.type) {
                SurfaceType.DOCUMENT -> MainPanelKey.DOCUMENTS
                SurfaceType.TODO -> MainPanelKey.TODOS
                else -> HOME
            }
        }
    }
}

/** The rows of home's places card, in order. */
private fun AgentFeed.places(): List<AgentFeedRow> {
    val start = rows.indexOfFirst { it is AgentFeedRow.Section && it.section == AgentFeedSection.Places }
    if (start < 0) return emptyList()
    return rows.drop(start + 1).takeWhile { it !is AgentFeedRow.Section }
}

/**
 * Home on a phone with the drawer (Steve: "home is a list of bots/tasks
 * only", as on iOS): the shared bot, the bots and the tasks. Home's places
 * are the drawer's; the projects' conversations are found by search.
 */
fun AgentFeed.withoutPlaces(): AgentFeed {
    val out = ArrayList<AgentFeedRow>(rows.size)
    var section: AgentFeedSection? = null
    for (row in rows) {
        if (row is AgentFeedRow.Section) section = row.section
        if (section == AgentFeedSection.Projects) continue
        if (section == AgentFeedSection.Places && row !is AgentFeedRow.Section && row !is AgentFeedRow.Conversation) continue
        out += row
    }
    // A heading with nothing under it goes.
    val kept = out.filterIndexed { i, row -> row !is AgentFeedRow.Section || out.getOrNull(i + 1).let { it != null && it !is AgentFeedRow.Section } }
    return copy(rows = kept)
}

/**
 * An agent connection's navigation drawer on a phone (Steve; iOS has the
 * same): a header with the open account's picture and name, which opens
 * the account menu ([AccountMenuDropdown]: switch, Add, Happy Cloud); Home
 * and the places ([AgentDrawerItems]), the [selected] one lit, Activity
 * with its unread count; then Settings at the foot. Home's bar has no
 * account button or Settings then: they are here.
 */
@Composable
fun AgentDrawer(
    name: String,
    accounts: AccountMenu,
    items: AgentDrawerItems,
    selected: String,
    onSwitchAccount: (String) -> Unit,
    onAdd: () -> Unit,
    onCloud: (() -> Unit)?,
    onHome: () -> Unit,
    onPlace: (AgentFeedRow) -> Unit,
    onSettings: () -> Unit,
) {
    val colors = HappyTheme.colors
    ModalDrawerSheet(
        modifier = Modifier.width(AgentDrawerSpec.width).testTag(AgentDrawerTags.SHEET),
        drawerContainerColor = colors.surface,
        drawerContentColor = colors.text,
    ) {
        Column(Modifier.fillMaxHeight()) {
            AgentDrawerHeader(name, accounts, onSwitchAccount, onAdd, onCloud)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = AgentDrawerSpec.inset)) {
                DrawerItem(stringResource(R.string.common_home), { TileMark(Ionicon.HomeOutline, RowTile.Gray) }, selected == AgentDrawerItems.HOME, AgentDrawerItems.HOME, onHome)
                for (row in items.places) {
                    val key = row.panelKey() ?: continue
                    DrawerItem(placeName(row), { PlaceMark(row) }, selected == key, key, { onPlace(row) }, count = (row as? AgentFeedRow.Feed)?.unread?.takeIf { it > 0 })
                }
                if (items.surfaces.isNotEmpty()) {
                    HorizontalDivider(Modifier.padding(vertical = 8.dp, horizontal = 12.dp), color = colors.divider)
                    for (row in items.surfaces) {
                        val key = row.panelKey() ?: continue
                        DrawerItem(row.name, { PlaceMark(row) }, selected == key, key, { onPlace(row) })
                    }
                }
            }
            HorizontalDivider(color = colors.divider)
            Box(Modifier.padding(horizontal = AgentDrawerSpec.inset, vertical = 8.dp)) {
                DrawerItem(stringResource(R.string.settings_title), { TileMark(Ionicon.SettingsOutline, RowTile.Teal) }, selected == MainPanelKey.SETTINGS, MainPanelKey.SETTINGS, onSettings, tag = AgentDrawerTags.SETTINGS)
            }
        }
    }
}

object AgentDrawerSpec {
    /** Material's modal drawer, at most 360 and 56 short of a narrow window. */
    val width = 320.dp
    val inset = 12.dp
    val headerAvatar = 40.dp
}

@Composable
private fun AgentDrawerHeader(name: String, accounts: AccountMenu, onSwitch: (String) -> Unit, onAdd: () -> Unit, onCloud: (() -> Unit)?) {
    val colors = HappyTheme.colors
    var open by remember { mutableStateOf(false) }
    val active = accounts.active
    val label = stringResource(R.string.account_menu_title)
    Box(Modifier.padding(horizontal = AgentDrawerSpec.inset, vertical = 12.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .clickable(role = Role.Button, onClickLabel = label) { open = true }
                .semantics { contentDescription = "$label, $name" }
                .padding(horizontal = 12.dp)
                .testTag(AgentDrawerTags.HEADER),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (active != null) {
                Avatar(active.seed, AgentDrawerSpec.headerAvatar, imageUri = active.imageUrl, thumbhash = active.thumbhash, animated = active.liveSeed != null)
            } else {
                Icon(Ionicon.PersonCircleOutline, AgentDrawerSpec.headerAvatar, colors.text)
            }
            Text(
                name,
                style = AgentHomeSpec.barTitle,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp).weight(1f),
            )
            Icon(Ionicon.ChevronDown, 18.dp, colors.textSecondary)
        }
        AccountMenuDropdown(accounts, open, { open = false }, onSwitch, onAdd, onCloud)
    }
}

@Composable
private fun DrawerItem(
    label: String,
    mark: @Composable () -> Unit,
    selected: Boolean,
    key: String,
    onClick: () -> Unit,
    count: Int? = null,
    tag: String = AgentDrawerTags.item(key),
) {
    val colors = HappyTheme.colors
    NavigationDrawerItem(
        label = { Text(label, style = AgentHomeSpec.title, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        icon = mark,
        badge = count?.let { { Text(it.toString(), style = AgentHomeSpec.title, color = colors.textSecondary) } },
        selected = selected,
        onClick = onClick,
        shape = RoundedCornerShape(AgentHomeSpec.cardRadius),
        colors = NavigationDrawerItemDefaults.colors(selectedContainerColor = colors.surfaceSelected, unselectedContainerColor = colors.surface),
        modifier = Modifier.testTag(tag),
    )
}

/** A place's name as home's row has it. */
@Composable
private fun placeName(row: AgentFeedRow): String = when (row) {
    AgentFeedRow.Artifacts -> stringResource(R.string.artifacts_title)
    AgentFeedRow.Plugins -> stringResource(R.string.plugins_title)
    AgentFeedRow.Pipelines -> stringResource(R.string.pipelines_title)
    is AgentFeedRow.Feed -> stringResource(R.string.feed_title)
    AgentFeedRow.Documents -> stringResource(R.string.surface_lists_documents)
    AgentFeedRow.Todos -> stringResource(R.string.surface_lists_todos)
    is AgentFeedRow.Surface -> row.name
    else -> ""
}

/**
 * [AgentDrawer] for the open agent connection [id] over [nav]: its feed's
 * places, the item for the stack's root lit, and each pick the stack's new
 * root through [panel]'s drawer opener ([route] says where a place goes;
 * a Surface opens as home opens one), the drawer closing as it opens.
 */
@Composable
fun AgentDrawerHost(
    graph: AppGraph,
    id: String,
    nav: NavHostController,
    panel: MainPanel,
    close: () -> Unit,
    route: (AgentFeedRow) -> Any?,
    onSettings: () -> Unit,
) {
    val session = remember(id) { graph.agentSessions.session(id) } ?: return
    val feed by session.feed.collectAsStateWithLifecycle()
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val stack by nav.backStackEntries.collectAsState()
    val root = MainPanel.root(stack.filter { it.destination !is NavGraph })?.let(MainPanelKey::of)
    val items = remember(feed) { AgentDrawerItems.of(feed) }
    val add = LocalAddFlow.current
    val switchAccount = rememberHomeAccountSwitch(graph)
    AgentDrawer(
        name = agents.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.account_kind_agent),
        accounts = rememberAccountMenu(graph),
        items = items,
        selected = remember(root, feed) { AgentDrawerItems.selected(root, feed) },
        onSwitchAccount = { close(); switchAccount(it) },
        onAdd = { close(); add?.scan() },
        onCloud = LocalCloudConnect.current?.let { cloud -> { close(); cloud() } },
        onHome = { close(); panel.showHome() },
        onPlace = { row ->
            close()
            panel.drawerOpener.open(row.panelKey()) {
                if (row is AgentFeedRow.Surface) nav.openSurface(graph, id, row.id) else route(row)?.let { nav.navigate(it) }
            }
        },
        onSettings = { close(); panel.drawerOpener.open(MainPanelKey.SETTINGS, onSettings) },
    )
}
