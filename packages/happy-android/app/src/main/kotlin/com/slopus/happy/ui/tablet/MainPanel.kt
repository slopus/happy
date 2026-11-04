package com.slopus.happy.ui.tablet

import com.slopus.happy.ui.backStackEntries

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.R
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.artifacts.AgentArtifactsRoute
import com.slopus.happy.ui.feed.AgentFeedRoute
import com.slopus.happy.ui.chat.COMPOSE_STARTED
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.isComposeChatId
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.surfaces.SurfaceRoute
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.home.NewSessionRoute
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.onboarding.TroubleshootRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.settings.ChangelogRoute
import com.slopus.happy.ui.theme.HappyTheme

object MainPanelTags {
    const val PLACEHOLDER = "mainPanel.placeholder"
    const val TOGGLE = "mainPanel.sidebarToggle"
}

/**
 * Where a home sends what it opens ([HomeRoute]'s page and the sidebar
 * each have their own): [open] runs [navigate], the push a phone makes;
 * [key] names what it opens ([MainPanelKey]), null for something new
 * every time, like compose.
 */
fun interface MainPanelOpener {
    fun open(key: String?, navigate: () -> Unit)

    companion object {
        /** The phone's: every open is a push. */
        val Push = MainPanelOpener { _, navigate -> navigate() }
    }
}

/**
 * The main panel beside the tablet's sidebar (happy-ios docs/IPAD.md): the
 * navigation stack over [HomeRoute], whose page is then the empty panel's
 * owl ([MainPanelPlaceholder]). Its root is the first screen over home.
 *
 * The sidebar never pushes ([opener], iOS `ShellViewController.showInMain`):
 * what it opens becomes the panel's new root, at once, with no slide
 * (`setViewControllers(animated: false)`); opening what the root already
 * is goes back to that root instead of opening a second copy. The panel's
 * own screens push and pop as on a phone. A root the sidebar opened is
 * marked on its entry ([SIDEBAR_ROOT], kept with its saved state), and so
 * is a screen that takes its place (a chat's compose replacing it): that
 * root's back is the sidebar's toggle. Anything else over the empty panel
 * (Add's restore, a link) keeps its back to the owl, as on iOS, where it is
 * pushed over the placeholder.
 */
@Stable
class MainPanel internal constructor(internal val nav: NavHostController) {
    /** The shell shows: a sidebar is beside this panel, shown or hidden. */
    var split by mutableStateOf(false)
        internal set
    var sidebarHidden by mutableStateOf(false)
        internal set
    internal var onToggleSidebar: () -> Unit = {}

    /** The last open's change of top page, which [NavMotion] makes at once. */
    private var cut: Pair<String, String>? = null

    /** The root at the last change, and whether the sidebar opened it. */
    private var lastRoot: Pair<String, Boolean>? = null

    /** The entries marked [SIDEBAR_ROOT] while composed, so a page sees its mark change. */
    private var marked by mutableStateOf(emptySet<String>())

    private fun mark(entry: NavBackStackEntry) {
        entry.savedStateHandle[SIDEBAR_ROOT] = true
        if (entry.id !in marked) marked = marked + entry.id
    }

    /** Whether the sidebar opened [entry] as the root (or it took such a root's place). */
    internal fun opened(entry: NavBackStackEntry): Boolean = entry.id in marked || entry.opened

    init {
        nav.addOnDestinationChangedListener { _, _, _ ->
            val stack = nav.screens()
            val root = root(stack)
            val last = lastRoot
            // A sidebar root replaced in place hands its place on.
            if (root != null && last != null && last.second && root.id != last.first && stack.none { it.id == last.first }) {
                mark(root)
            }
            lastRoot = root?.let { it.id to it.opened }
        }
    }

    fun toggleSidebar() = onToggleSidebar()

    /** The sidebar's [MainPanelOpener]. Off the split it is a push. */
    val opener = MainPanelOpener { key, navigate ->
        if (!split) return@MainPanelOpener navigate()
        val from = nav.currentBackStackEntry?.id
        val root = root(nav.screens())
        if (key != null && root != null && MainPanelKey.of(root) == key) {
            while (nav.currentBackStackEntry?.id != root.id) if (!nav.popBackStack()) break
        } else {
            nav.popBackStack<HomeRoute>(inclusive = false)
            navigate()
        }
        root(nav.screens())?.let { opened ->
            mark(opened)
            lastRoot = opened.id to true
        }
        val to = nav.currentBackStackEntry?.id
        if (from != null && to != null && from != to) cut = from to to
    }

    /** Whether the page change from [from] to [to] is an open's, which shows at once. */
    internal fun cuts(from: NavBackStackEntry, to: NavBackStackEntry): Boolean = cut == (from.id to to.id)

    companion object {
        /** Saved on a main panel root's entry: the sidebar opened it. */
        const val SIDEBAR_ROOT = "mainPanel.sidebarRoot"

        /** The panel's root in [stack]: the first screen over home, if any. */
        fun root(stack: List<NavBackStackEntry>): NavBackStackEntry? {
            val home = stack.indexOfFirst { it.destination.hasRoute<HomeRoute>() }
            return if (home < 0) null else stack.getOrNull(home + 1)
        }
    }
}

private fun NavHostController.screens() = backStackEntries.value.filter { it.destination !is NavGraph }

private val NavBackStackEntry.opened: Boolean get() = savedStateHandle.get<Boolean>(MainPanel.SIDEBAR_ROOT) == true

/** The shell's main panel; provided around the navigation stack by [TabletShell], also on a phone. */
val LocalMainPanel = compositionLocalOf<MainPanel?> { null }

/**
 * What a main panel's root is, so the sidebar can say "this is open"
 * (iOS `MainPanelKey`: the route, the agent, the Surface): the row it
 * selects, and the open that goes back to the root instead of opening it
 * again. Null for what has no row, which is always opened afresh.
 */
object MainPanelKey {
    const val SETTINGS = "settings"
    const val ARTIFACTS = "artifacts"
    const val FEED = "feed"
    const val TODOS = "todos"
    const val NEW_SESSION = "newSession"
    const val CHANGELOG = "changelog"
    const val TROUBLESHOOT = "troubleshoot"
    fun session(id: String) = "session:$id"
    fun conversation(agentId: String) = "conversation:$agentId"
    fun surface(id: String) = "surface:$id"
    fun machine(id: String) = "machine:$id"
    fun info(id: String) = "info:$id"

    /** The session [key] is of, if it is one's chat. */
    fun sessionId(key: String?): String? = key?.takeIf { it.startsWith("session:") }?.removePrefix("session:")

    fun of(entry: NavBackStackEntry): String? {
        val destination = entry.destination
        return when {
            // A compose chat is the session its first send started, and nothing before.
            destination.hasRoute<SessionRoute>() -> entry.toRoute<SessionRoute>().id
                .let { if (isComposeChatId(it)) entry.savedStateHandle.get<String>(COMPOSE_STARTED) else it }
                ?.let(::session)
            destination.hasRoute<ConversationRoute>() -> entry.toRoute<ConversationRoute>().agentId?.let(::conversation)
            destination.hasRoute<SurfaceRoute>() -> surface(entry.toRoute<SurfaceRoute>().surfaceId)
            destination.hasRoute<AgentArtifactsRoute>() -> ARTIFACTS
            destination.hasRoute<AgentFeedRoute>() -> FEED
            destination.hasRoute<com.slopus.happy.ui.todos.TodoListsRoute>() -> TODOS
            destination.hasRoute<SettingsRoute>() -> SETTINGS
            destination.hasRoute<MachineRoute>() -> machine(entry.toRoute<MachineRoute>().id)
            destination.hasRoute<SessionInfoRoute>() -> info(entry.toRoute<SessionInfoRoute>().id)
            destination.hasRoute<NewSessionRoute>() -> NEW_SESSION
            destination.hasRoute<ChangelogRoute>() -> CHANGELOG
            destination.hasRoute<TroubleshootRoute>() -> TROUBLESHOOT
            else -> null
        }
    }
}

/** True on the page that is the split main panel's root the sidebar opened, whose back is the sidebar's toggle. */
@Composable
fun rememberMainPanelRoot(): Boolean {
    val panel = LocalMainPanel.current ?: return false
    val entry = LocalViewModelStoreOwner.current as? NavBackStackEntry ?: return false
    val stack by panel.nav.backStackEntries.collectAsState()
    return panel.split && MainPanel.root(stack.filter { it.destination !is NavGraph })?.id == entry.id && panel.opened(entry)
}

/**
 * A screen's back where it may be the main panel's root (iOS
 * `placeToggle`): [back] everywhere else, the sidebar's toggle there.
 */
@Composable
fun BackOrSidebarToggle(tint: Color = LocalContentColor.current, back: @Composable () -> Unit) {
    if (rememberMainPanelRoot()) SidebarToggle(tint) else back()
}

/** The sidebar's button, as iPadOS names it: Hide Sidebar, or Show Sidebar while it is hidden. A 48 target, its 24 glyph [tint]. */
@Composable
fun SidebarToggle(tint: Color = LocalContentColor.current, modifier: Modifier = Modifier) {
    val panel = LocalMainPanel.current ?: return
    IconButton(onClick = panel::toggleSidebar, modifier = modifier.testTag(MainPanelTags.TOGGLE)) {
        androidx.compose.material3.Icon(
            MaterialSymbols.Sidebar,
            stringResource(if (panel.sidebarHidden) R.string.tablet_show_sidebar else R.string.tablet_hide_sidebar),
            tint = tint,
        )
    }
}

/**
 * The main panel with nothing open (iOS 75715e1c0): desktop's owl in its
 * 128 panel square, centred in the safe area, no words, on the chat's
 * ground. It plays once each time the panel empties and holds its last
 * frame; a tap plays it again. The sidebar's toggle stands where a root's
 * back would.
 */
@Composable
fun MainPanelPlaceholder() {
    val colors = HappyTheme.colors
    val panel = LocalMainPanel.current
    val entry = LocalViewModelStoreOwner.current as? NavBackStackEntry
    val stack = panel?.nav?.backStackEntries?.collectAsState()?.value
    val empty = stack?.lastOrNull { it.destination !is NavGraph }?.id == entry?.id
    // Plays asked for, and whether the panel was empty at the last look: kept through recreation, so a rotation doesn't replay it.
    var requested by rememberSaveable { mutableIntStateOf(0) }
    var wasEmpty by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(empty) {
        if (empty && !wasEmpty) requested++
        wasEmpty = empty
    }
    Box(Modifier.fillMaxSize().background(colors.surface).testTag(MainPanelTags.PLACEHOLDER)) {
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.Center) {
            SceneAnimation(StateArt.Owl.raw, requested, onReplay = { requested = it + 1 }, size = TabletShellSpec.placeholderScene)
        }
        Box(
            Modifier.windowInsetsPadding(WindowInsets.statusBars).height(TabletShellSpec.barHeight).padding(start = 4.dp),
            contentAlignment = Alignment.CenterStart,
        ) { SidebarToggle(colors.text) }
    }
}
