package com.slopus.happy.ui.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import androidx.navigation.NavDestination.Companion.hasRoute
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallScreen
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.conversation.composeConversation
import com.slopus.happy.ui.conversation.openConversationInPlace
import com.slopus.happy.ui.conversation.shownConversation
import com.slopus.happy.ui.tablet.LocalMainPanel
import com.slopus.happy.ui.tablet.MainPanel
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.tablet.MainPanelOpener

/**
 * The back stack as the call sees it ([CallScreen]): the conversation on
 * top is its focus (new work's too, once its screen holds it), told to it
 * whenever the top changes, and its tools open a conversation of
 * [connectionId] in place of one on top, or over anything else
 * ([openConversationInPlace]); on a tablet's split, as the sidebar opens
 * one, the main panel's new root ([MainPanel.opener]). New work opens as
 * compose opens it ([composeConversation]); back pops one page and home
 * pops to [HomeRoute], as the system's back and the sidebar do.
 */
@Composable
fun CallScreenEffect(calls: CallController, nav: NavHostController, connectionId: String?) {
    val panel = LocalMainPanel.current
    DisposableEffect(calls, nav, connectionId, panel) {
        val screen = callScreen(nav, connectionId, panel)
        calls.screen = screen
        onDispose { if (calls.screen === screen) calls.screen = null }
    }
    LaunchedEffect(calls, nav) {
        nav.currentBackStackEntryFlow.collect { calls.topDidChange() }
    }
}

/** [CallScreenEffect]'s [CallScreen] over [nav], on its own for a device check to drive. */
internal fun callScreen(nav: NavHostController, connectionId: String?, panel: MainPanel?): CallScreen = object : CallScreen {
    override val focused: String?
        get() {
            val top = nav.currentBackStackEntry ?: return null
            if (!top.destination.hasRoute<ConversationRoute>()) return null
            val route = top.toRoute<ConversationRoute>()
            if (route.connectionId != connectionId) return null
            return route.agentId ?: top.shownConversation()?.agentId
        }

    override fun open(agentId: String) {
        val connection = connectionId ?: return
        val go = panel?.opener ?: MainPanelOpener.Push
        go.open(MainPanelKey.conversation(agentId)) { nav.openConversationInPlace(connection, agentId) }
    }

    override fun compose(choice: WorkChoice) {
        val connection = connectionId ?: return
        val go = panel?.opener ?: MainPanelOpener.Push
        go.open(null) { nav.composeConversation(connection, choice = choice) }
    }

    override fun back(): Boolean {
        if (nav.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != false) return false
        return nav.popBackStack()
    }

    override val atHome: Boolean
        get() = nav.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true

    override fun home() {
        if (!atHome) nav.popBackStack<HomeRoute>(inclusive = false)
    }
}
