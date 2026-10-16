package com.slopus.happy.ui.tablet

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.files.MessageDetailRoute
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.files.SessionFileRoute
import com.slopus.happy.ui.home.HomeNavigation
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.LocalHomeInSidebar
import com.slopus.happy.ui.layout.LocalTabletShell
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.onboarding.OnboardingSettingsRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.floor

object TabletShellTags {
    const val DETAIL = "tablet.detail"
    const val HEADER = "tablet.header"
    const val ZEN = "tablet.zen"
    const val BACK = "tablet.back"
}

/** SidebarNavigator.tsx. */
object TabletShellSpec {
    const val SIDEBAR_FRACTION = 0.3f
    val sidebarMinWidth = 250.dp
    val sidebarMaxWidth = 360.dp
    /** PersistentHeader's `paddingLeft`. */
    val headerPaddingStart = 16.dp
    val control = 28.dp
    val controlGap = 4.dp
    val zenIcon = 18.dp
    val backIcon = 20.dp
    const val DISABLED_ALPHA = 0.3f

    /** `fullDrawerWidth`: 30% of the window, floored, held to 250–360. */
    fun sidebarWidth(windowWidth: Dp): Dp =
        floor(windowWidth.value * SIDEBAR_FRACTION).dp.coerceIn(sidebarMinWidth, sidebarMaxWidth)
}

/**
 * SidebarNavigator.tsx `isDesktopLayout`, with firstRunOnboarding.ts
 * `shouldSuppressTabletShell` on native Android: signed in, a window at least
 * 768 wide, and not on the first-run screens (the link page that takes the
 * home over while no computer is linked, or an `onboarding/` route).
 */
object TabletShellRule {
    fun suppressesShell(signedIn: Boolean, isTablet: Boolean, showsInstallStep: Boolean, isOnboardingRoute: Boolean): Boolean =
        signedIn && isTablet && (showsInstallStep || isOnboardingRoute)

    fun showsShell(signedIn: Boolean, isTablet: Boolean, showsInstallStep: Boolean, isOnboardingRoute: Boolean): Boolean =
        signedIn && isTablet && !suppressesShell(signedIn, isTablet, showsInstallStep, isOnboardingRoute)

    /**
     * SessionsList.tsx `selectedSessionId`: the session under `/session/<id>/…`,
     * the chat and every screen under it (info, changes, a file, a message).
     */
    fun selectedSessionId(entry: NavBackStackEntry?): String? {
        val destination = entry?.destination ?: return null
        return when {
            destination.hasRoute<SessionRoute>() -> entry.toRoute<SessionRoute>().id
            destination.hasRoute<SessionInfoRoute>() -> entry.toRoute<SessionInfoRoute>().id
            destination.hasRoute<SessionChangesRoute>() -> entry.toRoute<SessionChangesRoute>().id
            destination.hasRoute<SessionFileRoute>() -> entry.toRoute<SessionFileRoute>().id
            destination.hasRoute<MessageDetailRoute>() -> entry.toRoute<MessageDetailRoute>().id
            else -> null
        }
    }
}

/**
 * The window around the navigation stack ([content]). On a phone, signed
 * out, or on the first-run screens it is just the stack. Otherwise
 * (SidebarNavigator.tsx):
 *
 *     |16|(zen)|4|(‹)            …
 *     +-----------+---------------------------
 *     |  sidebar  |  the stack; Home itself is blank here
 *     | 30% of the|
 *     | window,   |
 *     | 250…360   |
 *
 * Zen mode (local settings) collapses the sidebar, without animating, as RN
 * snaps the drawer; the header's 28 controls stay put, centred in the header
 * row under the status bar. Back is dimmed to 0.3 with nothing to go back to.
 * The stack keeps its place in the tree whichever way the shell goes, so
 * crossing 768 (rotation, a fold, a resized window) keeps every screen's state.
 */
@Composable
fun TabletShell(
    graph: AppGraph,
    nav: NavHostController,
    signedIn: Boolean,
    onOpenSession: (String) -> Unit,
    onTroubleshoot: () -> Unit,
    content: @Composable () -> Unit,
) {
    ProvideWindowLayout {
        val window = LocalWindowLayout.current
        val entry by nav.currentBackStackEntryAsState()
        val wide = signedIn && window.isTablet
        val showsInstallStep = if (wide) {
            val services = remember(graph) { HomeServices.of(graph) }
            val state by services.list.state.collectAsStateWithLifecycle()
            state?.showsInstallStep == true
        } else {
            false
        }
        val onboardingRoute = entry?.destination?.hasRoute<OnboardingSettingsRoute>() == true
        val shows = TabletShellRule.showsShell(signedIn, window.isTablet, showsInstallStep, onboardingRoute)
        val local by graph.localSettings.values.collectAsStateWithLifecycle()
        val zen = local.zenMode

        Box(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxSize()) {
                if (shows && !zen) {
                    val navigation = remember(nav, onOpenSession, onTroubleshoot) { HomeNavigation.of(nav, onOpenSession, onTroubleshoot) }
                    TabletSidebar(
                        graph = graph,
                        navigation = navigation,
                        selectedSessionId = TabletShellRule.selectedSessionId(entry),
                        headerHeight = window.headerHeight,
                        modifier = Modifier.width(TabletShellSpec.sidebarWidth(window.width)).fillMaxHeight(),
                    )
                }
                Box(Modifier.weight(1f).fillMaxHeight().testTag(TabletShellTags.DETAIL)) {
                    CompositionLocalProvider(LocalTabletShell provides shows, LocalHomeInSidebar provides shows, content = content)
                }
            }
            if (shows) {
                PersistentHeader(
                    headerHeight = window.headerHeight,
                    zen = zen,
                    canGoBack = entry != null && nav.previousBackStackEntry != null,
                    onZen = { graph.localSettings.change { it.copy(zenMode = !it.zenMode) } },
                    onBack = { nav.popBackStack() },
                )
            }
        }
    }
}

/** SidebarNavigator.tsx PersistentHeader on native Android: zen and back, no forward. */
@Composable
fun PersistentHeader(headerHeight: Dp, zen: Boolean, canGoBack: Boolean, onZen: () -> Unit, onBack: () -> Unit) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.statusBars)
            .height(headerHeight)
            .testTag(TabletShellTags.HEADER)
            .padding(start = TabletShellSpec.headerPaddingStart, end = 16.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(TabletShellSpec.controlGap), verticalAlignment = Alignment.CenterVertically) {
            HeaderControl(TabletShellTags.ZEN, stringResource(R.string.zen_toggle), enabled = true, onClick = onZen) {
                Image(
                    painter = painterResource(R.drawable.zen_icon),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(if (zen) colors.textLink else colors.header.tint),
                    modifier = Modifier.size(TabletShellSpec.zenIcon),
                )
            }
            HeaderControl(TabletShellTags.BACK, stringResource(R.string.common_back), enabled = canGoBack, onClick = onBack) {
                Icon(Ionicon.ChevronBack, TabletShellSpec.backIcon, colors.header.tint)
            }
        }
    }
}

@Composable
private fun HeaderControl(tag: String, label: String, enabled: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .testTag(tag)
            .size(TabletShellSpec.control)
            .alpha(if (enabled) 1f else TabletShellSpec.DISABLED_ALPHA)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                // hitSlop 10: the ripple and the reach run 10 past the 28 box.
                indication = ripple(bounded = false, radius = TabletShellSpec.control / 2 + 10.dp, color = colors.text),
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { content() }
}
