package com.slopus.happy.ui.start

import androidx.activity.compose.ReportDrawn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.accounts.LockedAccount
import com.slopus.happy.ui.RestoreManualRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.components.TopBar
import com.slopus.happy.ui.connect.ConnectFlow
import com.slopus.happy.ui.connection.LocalCloudConnect
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.rememberHomeAccountSwitch
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.Serializable

/** The page of a Happy account that can't be unlocked ([AppGraph.requestUnlock]); [id] null for the React Native item no entry has. */
@Serializable data class UnlockAccountRoute(val id: String?)

object UnlockFailedTags {
    const val PAGE = "unlockFailed.page"
}

/**
 * The open Happy account (or the React Native app's, on the first start
 * after the upgrade) is on the phone but its credentials can't be read,
 * and no other account can open in its place ([AppGraph.locked]): in the
 * first screen's place, which would look like being signed out. The
 * account menu stays at the top (switching, Add, Happy Cloud), and under
 * the account's actions ([UnlockActions]) Add account goes where the first
 * screen's Start does, with Use Happy Cloud where the first screen offers
 * it. [unlocking] holds the Retry spinning; a connection [add] makes,
 * everything.
 */
@Composable
fun UnlockFailed(graph: AppGraph, nav: NavHostController, add: ConnectFlow, locked: LockedAccount, unlocking: Boolean) {
    ReportDrawn()
    val cloud = LocalCloudConnect.current
    Column(Modifier.fillMaxSize().background(HappyTheme.colors.surface).windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))) {
        TopBar(
            navigationIcon = { AccountMenuButton(rememberAccountMenu(graph), rememberHomeAccountSwitch(graph)) },
            title = {},
        )
        UnlockActions(
            graph = graph,
            nav = nav,
            locked = locked,
            busy = unlocking || add.isLoading,
            more = listOfNotNull(
                stringResource(R.string.account_unlock_failed_add) to { nav.navigate(InstallDesktopRoute) },
                cloud?.let { stringResource(R.string.start_cloud) to it },
            ),
        )
    }
}

/**
 * The page of an account that can't be unlocked, picked from the account
 * menu or Settings' accounts card: its error and actions, under its name.
 * It goes back once the account reads again or is removed.
 */
@Composable
fun UnlockAccount(graph: AppGraph, nav: NavHostController, id: String?) {
    val registry by graph.accountStore.registry.collectAsStateWithLifecycle()
    val unreadable by graph.accountStore.unreadable.collectAsStateWithLifecycle()
    val unlocking by graph.unlocking.collectAsStateWithLifecycle()
    val reason = unreadable.reason(registry, id)
    LaunchedEffect(reason == null, unlocking) { if (reason == null && !unlocking) nav.popBackStack() }
    val display = id?.let { registry.entry(it)?.display }
    Screen(header = { StackHeader(display?.name ?: display?.username ?: stringResource(R.string.account_kind_cli), onBack = { nav.popBackStack() }) }) {
        if (reason != null) UnlockActions(graph, nav, LockedAccount(id, reason), busy = unlocking, more = emptyList())
    }
}

/**
 * What can be done about [locked], as a [StatePage]. When a later read may
 * open it: Retry. When none will: Restore with secret key, and Remove from
 * this phone after a confirm. Then [more]. Nothing here touches the item
 * but Remove.
 */
@Composable
private fun UnlockActions(graph: AppGraph, nav: NavHostController, locked: LockedAccount, busy: Boolean, more: List<Pair<String, () -> Unit>>) {
    val permanent = locked.reason.permanent
    var removing by rememberSaveable { mutableStateOf(false) }
    StatePage(
        title = stringResource(R.string.account_unlock_failed_title),
        body = stringResource(if (permanent) R.string.account_unlock_failed_body_permanent else R.string.account_unlock_failed_body),
        icon = Ionicon.LockClosedOutline,
        action = if (permanent) {
            stringResource(R.string.account_unlock_failed_restore) to { nav.navigate(RestoreManualRoute) }
        } else {
            stringResource(R.string.common_retry) to { graph.retryUnlock(locked.id) }
        },
        secondary = more + listOfNotNull(if (permanent) stringResource(R.string.account_unlock_failed_remove) to { removing = true } else null),
        busy = busy,
        tag = UnlockFailedTags.PAGE,
    )
    if (removing) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.account_unlock_failed_remove_title),
                message = stringResource(R.string.account_unlock_failed_remove_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.account_unlock_failed_remove_confirm), destructive = true) { graph.removeUnreadable(locked.id) },
                ),
            ),
            onDismiss = { removing = false },
        )
    }
}
