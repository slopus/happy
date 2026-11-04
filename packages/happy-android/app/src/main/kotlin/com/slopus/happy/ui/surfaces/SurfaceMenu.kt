package com.slopus.happy.ui.surfaces

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.size
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.launch

/** A Surface's 48 dp More target, using the same confirmation and durable leave as home's menu. */
@Composable
fun SurfaceMenu(
    session: AgentSession,
    surfaceId: String,
    onBack: () -> Unit,
    extraItems: @Composable ColumnScope.(close: () -> Unit) -> Unit = {},
) {
    val catalog by session.surfaces.collectAsStateWithLifecycle()
    val surface = catalog[surfaceId] ?: return
    SurfaceLeaveMenu(surface.name, onBack, extraItems) { session.leaveSurface(surfaceId) }
}

@Composable
internal fun SurfaceLeaveMenu(
    name: String,
    onBack: () -> Unit,
    extraItems: @Composable ColumnScope.(close: () -> Unit) -> Unit = {},
    leave: suspend () -> String?,
) {
    var expanded by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) }
    var leaving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Box {
        IconButton(onClick = { expanded = true }, enabled = !leaving, modifier = Modifier.size(48.dp).testTag("surface.more")) {
            Icon(Ionicon.EllipsisVertical, 24.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.conversation_composer_more))
        }
        HappyDropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            extraItems { expanded = false }
            HappyMenuItem(stringResource(R.string.surface_leave), onClick = { expanded = false; confirming = true })
        }
    }
    if (confirming) HappyAlert(
        Alert(
            title = stringResource(R.string.surface_leave_title, name),
            message = stringResource(R.string.surface_leave_message),
            buttons = listOf(
                AlertButton(stringResource(R.string.common_cancel)),
                AlertButton(stringResource(R.string.surface_leave)) {
                    confirming = false
                    leaving = true
                    scope.launch {
                        try {
                            val reason = leave()
                            if (reason == null) onBack() else refused = reason
                        } finally { leaving = false }
                    }
                },
            ),
        ),
        onDismiss = { confirming = false },
    )
    refused?.let { reason ->
        HappyAlert(
            Alert(
                title = stringResource(R.string.surface_leave_failed, name),
                message = reason.ifEmpty { stringResource(R.string.surface_leave_no_answer) },
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { refused = null },
        )
    }
}