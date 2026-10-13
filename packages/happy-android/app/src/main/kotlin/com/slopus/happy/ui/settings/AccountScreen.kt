package com.slopus.happy.ui.settings

import android.content.ClipData
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object AccountTags {
    const val SECRET_KEY = "account.secretKey"
    const val SECRET_KEY_TEXT = "account.secretKeyText"
    const val ANALYTICS_SWITCH = "account.analyticsSwitch"
}

/** settings/account.tsx */
object AccountSpec {
    val secretPaddingHorizontal = 16.dp
    val secretPaddingVertical = 14.dp
    val secretLabelGap = 10.dp
    val secretIcon = 18.dp
    val secretLabel = happyTextStyle(fontSize = 11, letterSpacing = 0.5f, weight = FontWeight.SemiBold)
    val secretText = happyTextStyle(fontSize = 13, lineHeight = 20, letterSpacing = 0.5f, family = PlexMono)
    val copiedGreen = Color(0xFF34C759)
}

/**
 * Settings > Account, the parts that exist without push, GitHub and service
 * connections: account information, the secret key backup, analytics
 * opt-out, logout.
 *
 * "Link New Device" scans the new device's QR code in happy-app. STUB: there
 * is no scanner here, so it explains that and points to the secret key.
 */
@Composable
fun AccountScreen(
    anonId: String?,
    publicId: String?,
    formattedSecretKey: String,
    analyticsOptOut: Boolean,
    onAnalyticsOptOutChange: (Boolean) -> Unit,
    onLogout: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var showSecret by remember { mutableStateOf(false) }
    var copiedRecently by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }

    val ok = stringResource(R.string.common_ok)
    val copiedTitle = stringResource(R.string.common_copied)
    val successTitle = stringResource(R.string.common_success)
    val secretCopied = stringResource(R.string.settings_account_secret_key_copied)
    val notAvailable = stringResource(R.string.settings_account_not_available)
    val resources = LocalResources.current
    fun copiedMessage(label: String): String = resources.getString(R.string.items_copied_to_clipboard, label)

    fun copy(text: String, then: () -> Unit) {
        scope.launch {
            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(text, text)))
            then()
        }
    }

    LaunchedEffect(copiedRecently) {
        if (copiedRecently) {
            delay(2000)
            copiedRecently = false
        }
    }

    Screen(header = { StackHeader(stringResource(R.string.settings_account), onBack) }) {
        ItemList {
            ItemGroup(title = stringResource(R.string.settings_account_account_information)) {
                Item(
                    title = stringResource(R.string.settings_account_status),
                    detail = stringResource(R.string.settings_account_status_active),
                    showChevron = false,
                )
                CopyableItem(stringResource(R.string.settings_account_anonymous_id), anonId, notAvailable) { title, value ->
                    copy(value) { alert = Alert(copiedTitle, copiedMessage(title), listOf(AlertButton(ok))) }
                }
                CopyableItem(stringResource(R.string.settings_account_public_id), publicId, notAvailable) { title, value ->
                    copy(value) { alert = Alert(copiedTitle, copiedMessage(title), listOf(AlertButton(ok))) }
                }
                val linkTitle = stringResource(R.string.settings_account_link_new_device)
                val linkUnavailable = stringResource(R.string.settings_account_link_new_device_unavailable)
                Item(
                    title = linkTitle,
                    subtitle = stringResource(R.string.settings_account_link_new_device_subtitle),
                    icon = { ItemIcon(Ionicon.QrCodeOutline, SettingsSpec.blue) },
                    onClick = { alert = Alert(linkTitle, linkUnavailable, listOf(AlertButton(ok))) },
                    showChevron = false,
                )
            }

            ItemGroup(
                title = stringResource(R.string.settings_account_backup),
                footer = stringResource(R.string.settings_account_backup_description),
            ) {
                Item(
                    title = stringResource(R.string.settings_account_secret_key),
                    subtitle = stringResource(if (showSecret) R.string.settings_account_tap_to_hide else R.string.settings_account_tap_to_reveal),
                    icon = { ItemIcon(if (showSecret) Ionicon.EyeOffOutline else Ionicon.EyeOutline, SettingsSpec.orange) },
                    onClick = { showSecret = !showSecret },
                    showChevron = false,
                )
            }

            if (showSecret) {
                ItemGroup {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                copy(formattedSecretKey) {
                                    copiedRecently = true
                                    alert = Alert(successTitle, secretCopied, listOf(AlertButton(ok)))
                                }
                            }
                            .testTag(AccountTags.SECRET_KEY)
                            .padding(horizontal = AccountSpec.secretPaddingHorizontal, vertical = AccountSpec.secretPaddingVertical),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(bottom = AccountSpec.secretLabelGap),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(R.string.settings_account_secret_key_label).uppercase(),
                                style = AccountSpec.secretLabel,
                                color = colors.textSecondary,
                            )
                            Icon(
                                icon = if (copiedRecently) Ionicon.CheckmarkCircle else Ionicon.CopyOutline,
                                size = AccountSpec.secretIcon,
                                color = if (copiedRecently) AccountSpec.copiedGreen else colors.textSecondary,
                            )
                        }
                        Text(
                            text = formattedSecretKey,
                            style = AccountSpec.secretText,
                            color = colors.text,
                            modifier = Modifier.testTag(AccountTags.SECRET_KEY_TEXT),
                        )
                    }
                }
            }

            ItemGroup(
                title = stringResource(R.string.settings_account_privacy),
                footer = stringResource(R.string.settings_account_privacy_description),
            ) {
                Item(
                    title = stringResource(R.string.settings_account_analytics),
                    subtitle = stringResource(
                        if (analyticsOptOut) R.string.settings_account_analytics_disabled else R.string.settings_account_analytics_enabled,
                    ),
                    rightElement = {
                        Switch(
                            checked = !analyticsOptOut,
                            onCheckedChange = { enabled -> onAnalyticsOptOutChange(!enabled) },
                            colors = SwitchDefaults.colors(
                                checkedTrackColor = colors.switch.trackActive,
                                checkedThumbColor = colors.switch.thumbActive,
                                checkedBorderColor = Color.Transparent,
                                uncheckedTrackColor = colors.switch.trackInactive,
                                uncheckedThumbColor = colors.switch.thumbActive,
                                uncheckedBorderColor = Color.Transparent,
                            ),
                            modifier = Modifier.testTag(AccountTags.ANALYTICS_SWITCH),
                        )
                    },
                    showChevron = false,
                )
            }

            val logoutTitle = stringResource(R.string.common_logout)
            val logoutConfirm = stringResource(R.string.settings_account_logout_confirm)
            val cancel = stringResource(R.string.common_cancel)
            ItemGroup(title = stringResource(R.string.settings_account_danger_zone)) {
                Item(
                    title = stringResource(R.string.settings_account_logout),
                    subtitle = stringResource(R.string.settings_account_logout_subtitle),
                    icon = { ItemIcon(Ionicon.LogOutOutline, SettingsSpec.red) },
                    destructive = true,
                    onClick = {
                        alert = Alert(
                            logoutTitle,
                            logoutConfirm,
                            listOf(AlertButton(cancel), AlertButton(logoutTitle, destructive = true, onClick = onLogout)),
                        )
                    },
                )
            }
        }
    }

    alert?.let { HappyAlert(alert = it, onDismiss = { alert = null }) }
}

/** An Item showing a value in its detail; long press copies it (Item.tsx `copy`). */
@Composable
private fun CopyableItem(title: String, value: String?, placeholder: String, onCopy: (title: String, value: String) -> Unit) {
    Item(
        title = title,
        detail = value ?: placeholder,
        showChevron = false,
        onLongClick = value?.let { { onCopy(title, it) } },
    )
}
