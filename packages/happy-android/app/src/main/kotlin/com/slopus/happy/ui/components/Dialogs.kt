package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
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
 * happy-app's Modal on Android is the platform alert. This is its Compose
 * equivalent: buttons right-aligned in the given order (Android's neutral,
 * negative, positive), each closing the dialog before running its action.
 * An alert with more than three buttons stacks them, one per line.
 */
@Composable
fun HappyAlert(alert: Alert, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    AlertDialog(
        onDismissRequest = { if (alert.cancelable) onDismiss() },
        containerColor = colors.surface,
        title = { Text(alert.title, style = happyTextStyle(fontSize = 20, lineHeight = 26, weight = FontWeight.SemiBold), color = colors.text) },
        text = alert.message?.let { message ->
            { Text(message, style = happyTextStyle(fontSize = 16, lineHeight = 22), color = colors.textSecondary) }
        },
        confirmButton = {
            val buttons: @Composable () -> Unit = {
                alert.buttons.forEach { button ->
                    TextButton(onClick = {
                        onDismiss()
                        button.onClick()
                    }) {
                        Text(
                            text = button.text,
                            style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold),
                            color = if (button.destructive) colors.textDestructive else colors.text,
                        )
                    }
                }
            }
            // More than Android's three dialog slots: one action per line, in order.
            if (alert.buttons.size > 3) {
                Column(horizontalAlignment = Alignment.End) { buttons() }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { buttons() }
            }
        },
    )
}
