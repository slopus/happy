package com.slopus.happy.ui.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import androidx.navigation.NavDestination.Companion.hasRoute
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallScreen
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.conversation.heldConversation
import com.slopus.happy.ui.conversation.openConversation

/**
 * The back stack as the call sees it ([CallScreen]): the conversation on
 * top is its focus, told to it whenever the top changes, and its tools open
 * a conversation of [connectionId] the way a home row does.
 */
@Composable
fun CallScreenEffect(calls: CallController, nav: NavHostController, connectionId: String?) {
    DisposableEffect(calls, nav, connectionId) {
        val screen = object : CallScreen {
            override val focused: String?
                get() {
                    val top = nav.currentBackStackEntry ?: return null
                    if (!top.destination.hasRoute<ConversationRoute>()) return null
                    val route = top.toRoute<ConversationRoute>()
                    return route.agentId?.takeIf { route.connectionId == connectionId }
                }

            override fun shown(agentId: String): Conversation? = if (focused == agentId) nav.heldConversation(agentId) else null

            override fun open(agentId: String) {
                connectionId?.let { nav.openConversation(it, agentId) }
            }
        }
        calls.screen = screen
        onDispose { if (calls.screen === screen) calls.screen = null }
    }
    LaunchedEffect(calls, nav) {
        nav.currentBackStackEntryFlow.collect { calls.topDidChange() }
    }
}
