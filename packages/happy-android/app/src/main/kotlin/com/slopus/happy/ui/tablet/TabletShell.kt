package com.slopus.happy.ui.tablet

import com.slopus.happy.ui.backStackEntries

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import com.slopus.happy.AppGraph
import com.slopus.happy.ui.chat.COMPOSE_STARTED
import com.slopus.happy.ui.chat.SHOWN_CHAT
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.home.LocalHomeInSidebar
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.layout.WindowLayout
import com.slopus.happy.ui.onboarding.OnboardingSettingsRoute
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.floor
import kotlinx.coroutines.flow.flowOf

object TabletShellTags {
    const val DETAIL = "tablet.detail"
}

/** happy-ios SplitRules.swift and MainPanelPlaceholderLayout.swift. */
object TabletShellSpec {
    const val SIDEBAR_FRACTION = 0.3f
    /** The least that keeps the account's name and link state whole beside the switcher (iOS 4690d1c91). */
    val sidebarMinWidth = 340.dp
    val sidebarMaxWidth = 360.dp
    /** Desktop's panel square for an empty state's scene. */
    val placeholderScene = 128.dp
    /** A Material top app bar's, where a root's back would stand. */
    val barHeight = 64.dp

    /** 30% of the window, as happy-app's drawer, floored, held to 340–360. */
    fun sidebarWidth(windowWidth: Dp): Dp =
        floor(windowWidth.value * SIDEBAR_FRACTION).dp.coerceIn(sidebarMinWidth, sidebarMaxWidth)
}

/**
 * When the window splits: an account's home to show, a window at least
 * 840 wide (Material expanded), and not on an `onboarding/` route. Signed
 * out it is the first screen, full window. Happy Agent and Happy CLI split
 * alike (iOS 366a43cd0).
 */
object TabletShellRule {
    fun showsShell(hasHome: Boolean, isTablet: Boolean, isOnboardingRoute: Boolean): Boolean =
        hasHome && isTablet && !isOnboardingRoute
}

/**
 * The window around the navigation stack ([content]); happy-ios
 * docs/IPAD.md. On a phone, signed out, or on the first-run screens it is
 * just the stack. Otherwise it splits:
 *
 *     +-----------+---------------------------
 *     |  sidebar: |  main panel: the stack;
 *     |  the      |  Home's page is the owl
 *     |  account's|  (MainPanelPlaceholder)
 *     |  home     |
 *     | 30%,      |
 *     | 340…360   |
 *
 * The sidebar is the account's home itself ([sidebar], under
 * [LocalSidebarHome], so it wears the sidebar's chrome), sending what it
 * opens through the [MainPanel]'s opener: the main panel's new root, at
 * once. The main panel's screens keep their own back; its root's is the
 * sidebar's toggle ([BackOrSidebarToggle]), which hides the sidebar and
 * gives the panel the whole window, kept in local settings (zen mode, the
 * old shell's, so a hidden sidebar stays hidden). The stack keeps its place
 * in the tree whichever way the shell goes, so crossing 840 (rotation, a
 * fold, a resized window) keeps every screen's state.
 */
@Composable
fun TabletShell(
    graph: AppGraph,
    nav: NavHostController,
    hasHome: Boolean,
    sidebar: @Composable (MainPanelOpener) -> Unit,
    content: @Composable () -> Unit,
) {
    ProvideWindowLayout {
        val window = LocalWindowLayout.current
        val direction = LocalLayoutDirection.current
        val entry by nav.currentBackStackEntryAsState()
        val onboardingRoute = entry?.destination?.hasRoute<OnboardingSettingsRoute>() == true
        val shows = TabletShellRule.showsShell(hasHome, window.isTablet, onboardingRoute)
        val local by graph.localSettings.values.collectAsStateWithLifecycle()
        val hidden = local.zenMode
        val panel = remember(nav, graph) {
            MainPanel(nav).apply { onToggleSidebar = { graph.localSettings.change { it.copy(zenMode = !it.zenMode) } } }
        }
        // Read by the pages below in this same pass.
        if (panel.split != shows) panel.split = shows
        if (panel.sidebarHidden != hidden) panel.sidebarHidden = hidden

        Row(Modifier.fillMaxSize()) {
            if (shows && !hidden) {
                val width = TabletShellSpec.sidebarWidth(window.width)
                val stack by nav.backStackEntries.collectAsState()
                val root = MainPanel.root(stack.filter { it.destination !is NavGraph })
                // The session a compose chat at the root has started, or the tab it switched to in place, so its row shows selected.
                val chat = root?.takeIf { it.destination.hasRoute<SessionRoute>() }?.savedStateHandle
                val started by remember(root) { chat?.getStateFlow<String?>(COMPOSE_STARTED, null) ?: flowOf(null) }.collectAsStateWithLifecycle(null)
                val shown by remember(root) { chat?.getStateFlow<String?>(SHOWN_CHAT, null) ?: flowOf(null) }.collectAsStateWithLifecycle(null)
                val selected = remember(root, started, shown) { root?.let(MainPanelKey::of) }
                Box(Modifier.width(width).fillMaxHeight().testTag(SidebarTags.SIDEBAR)) {
                    CompositionLocalProvider(
                        LocalWindowLayout provides window.sidebar(width, direction),
                        LocalSidebarHome provides SidebarHome(selected),
                    ) { sidebar(panel.opener) }
                    Box(Modifier.align(Alignment.CenterEnd).width(hairline()).fillMaxHeight().background(HappyTheme.colors.divider))
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight().testTag(TabletShellTags.DETAIL)) {
                // Beside the sidebar, the main panel's inner side is no edge of the window.
                val detail = if (shows && !hidden) window.besideSidebar(direction) else window
                CompositionLocalProvider(
                    LocalWindowLayout provides detail,
                    LocalHomeInSidebar provides shows,
                    LocalMainPanel provides panel,
                    content = content,
                )
            }
        }
    }
}

/** The window as the pane beside the sidebar sees it: its sidebar side is safe. */
private fun WindowLayout.besideSidebar(direction: LayoutDirection): WindowLayout =
    if (direction == LayoutDirection.Ltr) copy(safeLeft = 0.dp) else copy(safeRight = 0.dp)

/** The sidebar as its home sees it: a phone-wide column, its window side unsafe as the window's is. */
private fun WindowLayout.sidebar(width: Dp, direction: LayoutDirection): WindowLayout =
    if (direction == LayoutDirection.Ltr) WindowLayout.of(width, height, safeLeft = safeLeft) else WindowLayout.of(width, height, safeRight = safeRight)
