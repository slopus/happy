package com.slopus.happy.ui.call

import com.slopus.happy.call.CallControl
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import androidx.navigation.NavDestination.Companion.hasRoute
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallScreen
import com.slopus.happy.OpenAccount
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.isComposeChatId
import com.slopus.happy.ui.chat.shownSessionId
import com.slopus.happy.ui.conversation.ConversationRoute
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
 * one, the main panel's new root ([MainPanel.opener]). Back pops one page
 * and home pops to [HomeRoute], as the system's back and the sidebar do.
 * On a Happy CLI account the same, with its chats ([legacyCallScreen]).
 */
@Composable
fun CallScreenEffect(calls: CallController, nav: NavHostController, open: OpenAccount) {
    val panel = LocalMainPanel.current
    DisposableEffect(calls, nav, open, panel) {
        val screen = if (open is OpenAccount.Happy) legacyCallScreen(nav, panel) else callScreen(nav, (open as? OpenAccount.Agent)?.id, panel)
        calls.screen = screen
        onDispose { if (calls.screen === screen) calls.screen = null }
    }
    LaunchedEffect(calls, nav) {
        nav.currentBackStackEntryFlow.collect { calls.topDidChange() }
    }
}

/** [CallScreenEffect]'s [CallScreen] over [nav], on its own for a device check to drive. */
internal fun callScreen(nav: NavHostController, connectionId: String?, panel: MainPanel?): CallScreen = object : StackCallScreen(nav) {
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
}

/**
 * [CallScreenEffect]'s [CallScreen] on a Happy CLI account: the chat on top
 * is the focus (as it shows it, a compose screen's none), and a chat opens
 * in place of one on top, or over anything else; on the split, the main
 * panel's new root, as the sidebar opens it.
 */
internal fun legacyCallScreen(nav: NavHostController, panel: MainPanel?): CallScreen = object : StackCallScreen(nav) {
    override val focused: String?
        get() {
            val top = nav.currentBackStackEntry ?: return null
            if (!top.destination.hasRoute<SessionRoute>()) return null
            return top.shownSessionId().takeUnless(::isComposeChatId)
        }

    override fun open(agentId: String) {
        val go = panel?.opener ?: MainPanelOpener.Push
        go.open(MainPanelKey.session(agentId)) {
            val current = nav.currentBackStackEntry
            nav.navigate(SessionRoute(agentId)) {
                if (current?.destination?.hasRoute<SessionRoute>() == true) popUpTo(current.destination.id) { inclusive = true }
            }
        }
    }
}

/** Back, home and the pressed controls, the same over either account's stack. */
private abstract class StackCallScreen(private val nav: NavHostController) : CallScreen {
    override fun back(): Boolean {
        if (nav.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != false) return false
        return nav.popBackStack()
    }

    override val atHome: Boolean
        get() = nav.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true

    override fun home() {
        if (!atHome) nav.popBackStack<HomeRoute>(inclusive = false)
    }

    override suspend fun press(control: CallControl) {
        // Animations off (the animator duration scale at 0): the light shows still.
        val still = Settings.Global.getFloat(nav.context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        VoiceTouch.play(control, still)
    }
}
