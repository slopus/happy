package com.slopus.happy.push

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.model.settings.PushPermissionStatus
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.LocalAfterStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Whether [connection]'s home asks for the notification permission
 * unprompted, where nothing else would: a paired Happy Agent, or a server
 * of the person's own, that this phone registers with ([cloudPushAccount]).
 * A Happy Cloud server asks in its onboarding (the mobileApp gate), and a
 * Happy account at every foreground ([PushRegistrationEffect]); neither is
 * asked a second way. The same rule as iOS's.
 */
internal fun asksForPushPermission(connection: AgentConnection?, happyAccount: Boolean): Boolean =
    connection != null && !happyAccount && !HappyCloud.isServer(connection.server) && cloudPushAccount(connection) != null

/**
 * Asks once, while the open connection [connectionId]'s home is on screen
 * and the system was never asked (Android 13 on; before it there is nothing
 * to ask, and the phone registers as soon as it is connected). A yes
 * registers at once. Whatever the answer, nothing asks again: Settings ›
 * Notifications is the way back.
 */
@Composable
fun PushPermissionPromptEffect(graph: AppGraph, nav: NavHostController, connectionId: String?) {
    val context = LocalContext.current
    val accounts by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val auth by graph.auth.state.collectAsStateWithLifecycle()
    val entry by nav.currentBackStackEntryAsState()
    val home = entry?.destination?.hasRoute<HomeRoute>() == true
    val services = remember(context) { PushServices.get(context) }
    PushPermissionPromptEffect(
        asks = home && asksForPushPermission(accounts.firstOrNull { it.id == connectionId }, happyAccount = auth is AuthState.SignedIn),
        supported = { services.fcm.supported },
        permission = rememberNotificationPermission(),
        onGranted = graph.cloudPush::refresh,
    )
}

/** The ask itself, with its parts passed in, for tests. */
@Composable
internal fun PushPermissionPromptEffect(asks: Boolean, supported: () -> Boolean, permission: NotificationPermission, onGranted: () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val afterStart = LocalAfterStart.current
    val granted by rememberUpdatedState(onGranted)
    LaunchedEffect(asks, permission, lifecycle) {
        if (!asks) return@LaunchedEffect
        afterStart.await()
        // Started, not resumed: the system's prompt pauses the activity, and its answer has to be heard.
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (!withContext(Dispatchers.IO) { supported() }) return@repeatOnLifecycle
            // Undetermined is "never asked"; a refusal the system would still ask about again is not.
            if (permission.info().status != PushPermissionStatus.Undetermined) return@repeatOnLifecycle
            if (permission.request().granted) granted()
        }
    }
}
