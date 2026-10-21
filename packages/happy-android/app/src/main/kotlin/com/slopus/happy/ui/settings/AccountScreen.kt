package com.slopus.happy.ui.settings

import android.content.ClipData
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import com.slopus.happy.model.Profile
import com.slopus.happy.model.settings.PushPermission
import com.slopus.happy.model.settings.PushPermissionStatus
import com.slopus.happy.model.settings.PushText
import com.slopus.happy.model.settings.PushToken
import com.slopus.happy.ui.components.HappySwitch
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.semantics.Role
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
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object AccountTags {
    const val SECRET_KEY = "account.secretKey"
    const val SECRET_KEY_TEXT = "account.secretKeyText"
    const val ANALYTICS_SWITCH = "account.analyticsSwitch"
    const val GITHUB_AVATAR = "account.githubAvatar"
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

/** What the push rows show (account.tsx's push state). */
data class PushState(
    val permission: PushPermission? = null,
    val loading: Boolean = false,
    val requesting: Boolean = false,
    val refreshing: Boolean = false,
    val currentToken: String? = null,
    val tokens: List<PushToken> = emptyList(),
    val deletingToken: String? = null,
    val deviceLabel: String = "android device",
    val appLabel: String? = null,
)

/** account.tsx `knownServices`: id, name, icon, and whether the icon takes the text colour. */
private data class KnownService(val id: String, val name: String, val icon: Int, val tinted: Boolean)

private val knownServices = listOf(
    KnownService("anthropic", "Claude Code", R.drawable.icon_claude, tinted = false),
    KnownService("gemini", "Google Gemini", R.drawable.icon_gemini, tinted = false),
    KnownService("openai", "OpenAI Codex", R.drawable.icon_gpt, tinted = true),
)

/**
 * Settings > Account (settings/account.tsx, native rows): account
 * information, the profile (name, GitHub with disconnect), connected
 * services with disconnect, the secret key backup, analytics, push
 * notifications and registered tokens, logout.
 *
 * Spec: standard [ItemGroup]s of [Item]s with 29 icons. The profile group
 * shows when there is a name or GitHub login; connected services only those
 * account.tsx knows (Claude Code, Google Gemini, OpenAI Codex) with "Active"
 * as detail. The revealed secret key is a block with 16/14 padding: an 11
 * semibold uppercase label and an 18 copy icon 10 above the 13/20 mono key.
 * Registered tokens list every token with an unlimited subtitle; another
 * device's token deletes on tap after a confirm.
 *
 * "Link New Device" scans the new device's QR code ([onLinkNewDevice]); while
 * [linkingDevice] it reads "Scanning..." and takes no taps.
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
    profile: Profile = Profile.Defaults,
    gitHubBusy: Boolean = false,
    onDisconnectGitHub: () -> Unit = {},
    disconnectingService: String? = null,
    onDisconnectService: (service: String, name: String) -> Unit = { _, _ -> },
    push: PushState = PushState(),
    onRequestPush: () -> Unit = {},
    onRefreshPush: () -> Unit = {},
    onDeletePushToken: (PushToken) -> Unit = {},
    linkingDevice: Boolean = false,
    onLinkNewDevice: () -> Unit = {},
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

    val errorTitle = stringResource(R.string.common_error)
    val secretCopyFailed = stringResource(R.string.settings_account_secret_key_copy_failed)

    /** Copies [text]; a clipboard that refuses calls [failed] instead of crashing. */
    fun copy(text: String, failed: () -> Unit = {}, then: () -> Unit) {
        scope.launch {
            try {
                clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(text, text)))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                failed()
                return@launch
            }
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
                Item(
                    title = stringResource(R.string.settings_account_link_new_device),
                    subtitle = stringResource(
                        if (linkingDevice) R.string.common_scanning else R.string.settings_account_link_new_device_subtitle,
                    ),
                    icon = { ItemIcon(Ionicon.QrCodeOutline, SettingsSpec.blue) },
                    onClick = onLinkNewDevice,
                    enabled = !linkingDevice,
                    showChevron = false,
                )
            }

            val cancel = stringResource(R.string.common_cancel)
            val disconnect = stringResource(R.string.modals_disconnect)
            val resourcesForConfirm = LocalResources.current
            fun confirmDisconnect(title: String, message: String, action: () -> Unit) {
                alert = Alert(title, message, listOf(AlertButton(cancel), AlertButton(disconnect, destructive = true, onClick = action)), cancelable = false)
            }

            val displayName = profile.displayName
            val gitHubLogin = profile.github?.login
            if (displayName != null || gitHubLogin != null || profile.avatar != null) {
                ItemGroup(title = stringResource(R.string.settings_account_profile)) {
                    if (displayName != null) {
                        Item(title = stringResource(R.string.settings_account_name), detail = displayName, showChevron = false)
                    }
                    if (gitHubLogin != null) {
                        val title = stringResource(R.string.modals_disconnect_github)
                        val message = stringResource(R.string.modals_disconnect_github_confirm)
                        Item(
                            title = stringResource(R.string.settings_account_github),
                            detail = "@$gitHubLogin",
                            subtitle = stringResource(R.string.settings_account_tap_to_disconnect),
                            // The uploaded avatar when there is one (no thumbhash placeholder), else the logo.
                            icon = {
                                val url = profile.avatar?.url?.takeIf { it.isNotEmpty() }
                                if (url != null) {
                                    RemoteImage(url, contentDescription = null, modifier = Modifier.size(SettingsSpec.itemIcon).clip(CircleShape).testTag(AccountTags.GITHUB_AVATAR))
                                } else {
                                    ItemIcon(Ionicon.LogoGithub, colors.textSecondary)
                                }
                            },
                            onClick = { confirmDisconnect(title, message, onDisconnectGitHub) },
                            loading = gitHubBusy,
                            showChevron = false,
                        )
                    }
                }
            }

            val services = knownServices.filter { it.id in profile.connectedServices }
            if (services.isNotEmpty()) {
                ItemGroup(title = stringResource(R.string.settings_connected_accounts)) {
                    for (service in services) {
                        val busy = disconnectingService == service.id
                        Item(
                            title = service.name,
                            detail = stringResource(R.string.settings_account_status_active),
                            subtitle = stringResource(R.string.settings_account_tap_to_disconnect),
                            icon = {
                                Image(
                                    painter = painterResource(service.icon),
                                    contentDescription = null,
                                    contentScale = ContentScale.Fit,
                                    colorFilter = if (service.tinted) ColorFilter.tint(colors.text) else null,
                                    modifier = Modifier.size(SettingsSpec.itemIcon),
                                )
                            },
                            onClick = {
                                confirmDisconnect(
                                    resourcesForConfirm.getString(R.string.modals_disconnect_service, service.name),
                                    resourcesForConfirm.getString(R.string.modals_disconnect_service_confirm, service.name),
                                ) { onDisconnectService(service.id, service.name) }
                            },
                            loading = busy,
                            enabled = !busy,
                            showChevron = false,
                        )
                    }
                }
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
                            .clickable(role = Role.Button) {
                                copy(formattedSecretKey, failed = { alert = Alert(errorTitle, secretCopyFailed, listOf(AlertButton(ok))) }) {
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
                val analytics = stringResource(R.string.settings_account_analytics)
                Item(
                    title = analytics,
                    subtitle = stringResource(
                        if (analyticsOptOut) R.string.settings_account_analytics_disabled else R.string.settings_account_analytics_enabled,
                    ),
                    rightElement = {
                        HappySwitch(
                            checked = !analyticsOptOut,
                            onCheckedChange = { enabled -> onAnalyticsOptOutChange(!enabled) },
                            modifier = Modifier.testTag(AccountTags.ANALYTICS_SWITCH),
                            label = analytics,
                        )
                    },
                    showChevron = false,
                )
            }

            ItemGroup(
                title = "Push Notifications",
                footer = "Shows every push token registered on your account. Tap an old token to delete it.",
            ) {
                val unsupported = push.permission?.status == PushPermissionStatus.Unsupported
                Item(
                    title = "Permission",
                    detail = PushText.label(push.permission),
                    subtitle = PushText.subtitle(push.permission),
                    icon = { ItemIcon(Ionicon.NotificationsOutline, SettingsSpec.blue) },
                    loading = push.loading,
                    showChevron = false,
                )
                Item(
                    title = "Request Permission Again",
                    subtitle = PushText.requestSubtitle(push.permission),
                    icon = { ItemIcon(Ionicon.ShieldCheckmarkOutline, AccountSpec.copiedGreen) },
                    onClick = onRequestPush,
                    loading = push.requesting,
                    enabled = !(push.requesting || push.loading || unsupported),
                    showChevron = false,
                )
                Item(
                    title = "Re-register This Device",
                    subtitle = push.currentToken?.let { "Current token ${PushText.fingerprint(it)}" }
                        ?: "Fetches the current Expo token and registers it again.",
                    icon = { ItemIcon(Ionicon.RefreshOutline, SettingsSpec.orange) },
                    onClick = onRefreshPush,
                    loading = push.refreshing,
                    enabled = !(push.refreshing || push.loading),
                    showChevron = false,
                )
            }

            ItemGroup(
                title = "Registered Tokens (${push.tokens.size})",
                footer = "Current-device metadata comes from this phone. Older tokens use their token fingerprint plus server timestamps.",
            ) {
                if (push.tokens.isEmpty()) {
                    Item(
                        title = "No registered push tokens",
                        subtitle = "Once this device is registered, it will appear here.",
                        showChevron = false,
                    )
                }
                val delete = stringResource(R.string.common_delete)
                for (token in push.tokens) {
                    val current = push.currentToken == token.token
                    val fingerprint = PushText.fingerprint(token.token)
                    Item(
                        title = fingerprint,
                        detail = if (current) "This device" else null,
                        subtitle = PushText.tokenSubtitle(token, current, push.deviceLabel, push.appLabel),
                        subtitleLines = 0,
                        icon = {
                            ItemIcon(
                                if (current) Ionicon.PhonePortraitOutline else Ionicon.TrashOutline,
                                if (current) colors.textSecondary else SettingsSpec.red,
                            )
                        },
                        onClick = if (current) {
                            null
                        } else {
                            {
                                alert = Alert(
                                    "Delete Push Token",
                                    "Remove $fingerprint from your account?",
                                    listOf(AlertButton(cancel), AlertButton(delete, destructive = true) { onDeletePushToken(token) }),
                                    cancelable = false,
                                )
                            }
                        },
                        onLongClick = if (current) {
                            { copy(token.token) { alert = Alert(copiedTitle, copiedMessage(fingerprint), listOf(AlertButton(ok))) } }
                        } else {
                            null
                        },
                        loading = push.deletingToken == token.token,
                        enabled = push.deletingToken == null,
                        showChevron = false,
                    )
                }
            }

            val logoutTitle = stringResource(R.string.common_logout)
            val logoutConfirm = stringResource(R.string.settings_account_logout_confirm)
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
                            cancelable = false,
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
