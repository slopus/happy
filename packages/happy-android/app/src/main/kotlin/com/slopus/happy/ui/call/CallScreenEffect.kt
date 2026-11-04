package com.slopus.happy.ui.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import androidx.navigation.NavDestination.Companion.hasRoute
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallScreen
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.conversation.openConversationInPlace
import com.slopus.happy.ui.tablet.LocalMainPanel
import com.slopus.happy.ui.tablet.MainPanel
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.tablet.MainPanelOpener

/**
 * The back stack as the call sees it ([CallScreen]): the conversation on
 * top is its focus, told to it whenever the top changes, and its tools open
 * a conversation of [connectionId] in place of one on top, or over anything
 * else ([openConversationInPlace]); on a tablet's split, as the sidebar
 * opens one, the main panel's new root ([MainPanel.opener]).
 */
@Composable
fun CallScreenEffect(calls: CallController, nav: NavHostController, connectionId: String?) {
    val panel = LocalMainPanel.current
    DisposableEffect(calls, nav, connectionId, panel) {
        val screen = object : CallScreen {
            override val focused: String?
                get() {
                    val top = nav.currentBackStackEntry ?: return null
                    if (!top.destination.hasRoute<ConversationRoute>()) return null
                    val route = top.toRoute<ConversationRoute>()
                    return route.agentId?.takeIf { route.connectionId == connectionId }
                }

            override fun open(agentId: String) {
                val connection = connectionId ?: return
                val go = panel?.opener ?: MainPanelOpener.Push
                go.open(MainPanelKey.conversation(agentId)) { nav.openConversationInPlace(connection, agentId) }
            }
        }
        calls.screen = screen
        onDispose { if (calls.screen === screen) calls.screen = null }
    }
    LaunchedEffect(calls, nav) {
        nav.currentBackStackEntryFlow.collect { calls.topDidChange() }
    }
}
