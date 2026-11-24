package com.slopus.happy.push

import androidx.compose.runtime.Composable
import com.slopus.happy.connection.AgentConnection

/**
 * Whether [connection]'s home asks for the notification permission
 * unprompted, where nothing else would.
 */
@Suppress("UNUSED_PARAMETER")
internal fun asksForPushPermission(connection: AgentConnection?, happyAccount: Boolean): Boolean = false

/** The ask itself, with its parts passed in, for tests. */
@Suppress("UNUSED_PARAMETER")
@Composable
internal fun PushPermissionPromptEffect(asks: Boolean, supported: () -> Boolean, permission: NotificationPermission, onGranted: () -> Unit) {
}
