package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert

/**
 * The account menu's "Connect to Happy Cloud", provided at the app's root;
 * null where the build has no cloud address, and the row is left out.
 */
val LocalCloudConnect: ProvidableCompositionLocal<(() -> Unit)?> = compositionLocalOf { null }

/**
 * Connecting to Happy Cloud ([connectToCloud]): with a cloud team already
 * here it opens at once; otherwise it asks first ("Connect to Happy
 * Cloud?", Cancel / Connect) and Connect starts the sign-in. Composes its
 * own alert while it asks.
 */
@Composable
fun rememberCloudConnect(graph: AppGraph, nav: NavHostController): (() -> Unit)? {
    if (HappyCloud.origin == null) return null
    var asking by remember { mutableStateOf(false) }
    if (asking) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.cloud_connect_title),
                message = stringResource(R.string.cloud_connect_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.cloud_connect_confirm)) { nav.connectToCloud(graph) },
                ),
            ),
            onDismiss = { asking = false },
        )
    }
    return remember(graph, nav) {
        {
            if (HappyCloud.connection(graph.agentConnections.accounts.value) != null) nav.connectToCloud(graph) else asking = true
        }
    }
}
