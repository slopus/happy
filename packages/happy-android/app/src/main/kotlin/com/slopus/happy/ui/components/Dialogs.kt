package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

data class AlertButton(
    val text: String,
    val destructive: Boolean = false,
    val onClick: () -> Unit = {},
)

/** What `Modal.alert` / `Modal.confirm` show: a title, a message, up to three buttons. */
data class Alert(
    val title: String,
    val message: String? = null,
    val buttons: List<AlertButton>,
    /** False for `Modal.confirm` (`cancelable: false`): only a button closes it. */
    val cancelable: Boolean = true,
)

/**
 * ModalManager.confirm on Android: [cancelText] then [confirmText], not
 * dismissable; true when confirmed. [show] puts the alert up.
 */
suspend fun confirm(
    show: (Alert) -> Unit,
    title: String,
    message: String?,
    confirmText: String,
    cancelText: String,
    destructive: Boolean = false,
): Boolean = suspendCancellableCoroutine { continuation ->
    show(
        Alert(
            title,
            message,
            listOf(
                AlertButton(cancelText) { if (continuation.isActive) continuation.resume(false) },
                AlertButton(confirmText, destructive) { if (continuation.isActive) continuation.resume(true) },
            ),
            cancelable = false,
        ),
    )
}

/**
 * happy-app's Modal on Android is the platform alert; this is the Material 3
 * dialog with its own type and colours: title, message, then the actions
 * as text buttons bottom right in the given order (Android's neutral,
 * negative, positive), each closing the dialog before running its action.
 * A destructive action is in the error colour. More than three actions
 * stack, one per line.
 */
@Composable
fun HappyAlert(alert: Alert, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = { if (alert.cancelable) onDismiss() },
        title = { Text(alert.title) },
        text = alert.message?.let { message -> { Text(message) } },
        confirmButton = {
            val buttons: @Composable () -> Unit = {
                alert.buttons.forEach { button ->
                    TextButton(
                        onClick = {
                            onDismiss()
                            button.onClick()
                        },
                        colors = if (button.destructive) {
                            ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                        } else {
                            ButtonDefaults.textButtonColors()
                        },
                    ) {
                        Text(button.text)
                    }
                }
            }
            if (alert.buttons.size > 3) {
                Column(horizontalAlignment = Alignment.End) { buttons() }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { buttons() }
            }
        },
    )
}
