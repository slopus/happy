package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

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
)

/**
 * happy-app's Modal on Android is the platform alert. This is its Compose
 * equivalent: buttons right-aligned in the given order (Android's neutral,
 * negative, positive), each closing the dialog before running its action.
 */
@Composable
fun HappyAlert(alert: Alert, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surface,
        title = { Text(alert.title, style = happyTextStyle(fontSize = 20, lineHeight = 26, weight = FontWeight.SemiBold), color = colors.text) },
        text = alert.message?.let { message ->
            { Text(message, style = happyTextStyle(fontSize = 16, lineHeight = 22), color = colors.textSecondary) }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
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
        },
    )
}
