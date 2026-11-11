package com.slopus.happy.ui.start

import com.slopus.happy.ui.connection.LocalCloudConnect
import androidx.activity.compose.ReportDrawn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.connect.ConnectFlow
import com.slopus.happy.ui.onboarding.DESKTOP_URL
import kotlinx.serialization.Serializable

/** The screen after the first one's Start ([InstallDesktopScreen]). */
@Serializable data object InstallDesktopRoute

/**
 * The first screen: Start opens [InstallDesktopRoute], and Use Happy Cloud
 * opens Happy Cloud's welcome where the build offers it. The other ways in
 * are the next screen's ⋮.
 */
@Composable
@Suppress("UNUSED_PARAMETER")
fun Start(graph: AppGraph, nav: NavHostController, add: ConnectFlow) {
    // Nothing to read from disk: the first frame is the whole screen.
    ReportDrawn()

    StartScreen(
        connecting = add.isLoading,
        onStart = { nav.navigate(InstallDesktopRoute) },
        onCloud = LocalCloudConnect.current,
    )
}

/**
 * Getting Happy for the computer, then scanning its code: Scan QR code is
 * the app's Add flow ([add]), as Start's was; the ⋮ menu is the first
 * screen's.
 */
@Composable
fun InstallDesktop(graph: AppGraph, nav: NavHostController, add: ConnectFlow) {
    val customServerLabel = rememberCustomServerLabel(graph)
    val uriHandler = LocalUriHandler.current

    InstallDesktopScreen(
        scanning = add.isLoading,
        customServerLabel = customServerLabel,
        onBack = { nav.popBackStack() },
        onScan = add::scan,
        onOpenSite = { uriHandler.openUri(DESKTOP_URL) },
        onEnterLink = { add.enteringLink = true },
        onRestore = { nav.navigate(RestoreRoute) },
        onServer = { nav.navigate(ServerRoute) },
    )
}

/** The custom server's host, or null on the default one: what the menus show under Happy CLI server. */
@Composable
internal fun rememberCustomServerLabel(graph: AppGraph): String? {
    val serverUrl by graph.serverConfig.url.collectAsStateWithLifecycle()
    return remember(serverUrl) { graph.serverConfig.customHostLabel }
}
