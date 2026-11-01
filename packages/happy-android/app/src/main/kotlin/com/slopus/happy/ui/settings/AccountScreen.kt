package com.slopus.happy.ui.settings

import android.content.ClipData
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.settings.PushPermission
import com.slopus.happy.model.settings.PushPermissionStatus
import com.slopus.happy.model.settings.PushText
import com.slopus.happy.model.settings.PushToken
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.revealRow
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

object AccountTags {
    const val NAME = "account.name"
    const val USERNAME = "account.username"
    const val ANALYTICS = "account.analytics"
    const val PUSH_PERMISSION = "account.pushPermission"
    const val PUSH_REQUEST = "account.pushRequest"
    const val PUSH_REREGISTER = "account.pushReregister"
    const val ANALYTICS_ID = "account.analyticsId"
    const val PUBLIC_ID = "account.publicId"
    const val SERVER = "account.server"
    const val ANALYTICS_SWITCH = "account.analyticsSwitch"
    const val SECRET_KEY = "account.secretKey"
    const val SECRET_KEY_TEXT = "account.secretKeyText"
    const val COPY_SECRET_KEY = "account.copySecretKey"
    const val LINK_DEVICE = "account.linkDevice"
    const val RESTORE = "account.restore"
}

/** settings/account.tsx's revealed key, as iOS's Backup & Restore shows it: a code row the card's width. */
object AccountSpec {
    val secretPaddingHorizontal = 16.dp
    val secretPaddingVertical = 14.dp
    val secretText = happyTextStyle(fontSize = 15, lineHeight = 22, letterSpacing = 0.5f, family = AppMono)
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

/** Copies [text]; a clipboard that refuses calls [failed] instead of crashing. */
@Composable
private fun rememberCopy(): (text: String, failed: () -> Unit, then: () -> Unit) -> Unit {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    return { text, failed, then ->
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
}

/**
 * Settings › Account, as iOS's AccountSettingsViewController has it: who the
 * account is (its name and username when the profile has them, the
 * Analytics and Public IDs, a tap copying one, and its server; "Tap an ID to
 * copy it." under the card); Analytics, a switch, with what it shares under
 * it; this phone's push permission with Request Permission Again and
 * Re-register This Device, what the permission means under them; and every
 * push token on the account, another device's deleted on a tap after a
 * confirm, the count under them. What happy-app's page also had moved: the
 * secret key and Link New Device to Backup & Restore, Logout to Settings'
 * last row; connected services are gone, as on iOS.
 */
@Composable
fun AccountScreen(
    anonId: String?,
    publicId: String?,
    analyticsOptOut: Boolean,
    onAnalyticsOptOutChange: (Boolean) -> Unit,
    onBack: () -> Unit,
    displayName: String? = null,
    username: String? = null,
    /** The server's host; null is the default server. */
    server: String? = null,
    push: PushState = PushState(),
    onRequestPush: () -> Unit = {},
    onRefreshPush: () -> Unit = {},
    onDeletePushToken: (PushToken) -> Unit = {},
) {
    val colors = HappyTheme.colors
    val copy = rememberCopy()
    var alert by remember { mutableStateOf<Alert?>(null) }
    val ok = stringResource(R.string.common_ok)
    val copiedTitle = stringResource(R.string.common_copied)
    val notAvailable = stringResource(R.string.settings_account_not_available)
    val resources = LocalResources.current
    fun copied(label: String, value: String) = copy(value, {}) { alert = Alert(copiedTitle, resources.getString(R.string.items_copied_to_clipboard, label), listOf(AlertButton(ok))) }

    Screen(header = { StackHeader(stringResource(R.string.settings_account), onBack) }) {
        ItemList {
            ItemGroup(footer = stringResource(R.string.settings_copy_id_footer)) {
                if (displayName != null) {
                    Item(title = stringResource(R.string.settings_account_name), detail = displayName, showChevron = false, modifier = Modifier.revealRow(AccountTags.NAME))
                }
                if (username != null) {
                    Item(title = stringResource(R.string.profile_username), detail = "@$username", showChevron = false, modifier = Modifier.revealRow(AccountTags.USERNAME))
                }
                val analyticsId = stringResource(R.string.settings_account_anonymous_id)
                Item(
                    title = analyticsId,
                    detail = anonId ?: notAvailable,
                    showChevron = false,
                    onClick = anonId?.let { { copied(analyticsId, it) } },
                    modifier = Modifier.revealRow(AccountTags.ANALYTICS_ID),
                )
                val publicIdTitle = stringResource(R.string.settings_account_public_id)
                Item(
                    title = publicIdTitle,
                    detail = publicId ?: notAvailable,
                    showChevron = false,
                    onClick = publicId?.let { { copied(publicIdTitle, it) } },
                    modifier = Modifier.revealRow(AccountTags.PUBLIC_ID),
                )
                Item(
                    title = stringResource(R.string.settings_account_server),
                    detail = server ?: stringResource(R.string.settings_default_server),
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.SERVER),
                )
            }

            ItemGroup(footer = stringResource(R.string.settings_account_privacy_description)) {
                val analytics = stringResource(R.string.settings_account_analytics)
                Item(
                    title = analytics,
                    icon = { SettingsTile(Ionicon.AnalyticsOutline, SettingsTiles.blue) },
                    rightElement = {
                        HappySwitch(
                            checked = !analyticsOptOut,
                            onCheckedChange = { enabled -> onAnalyticsOptOutChange(!enabled) },
                            modifier = Modifier.testTag(AccountTags.ANALYTICS_SWITCH),
                            label = analytics,
                        )
                    },
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.ANALYTICS),
                )
            }

            // account.tsx's push rows.
            ItemGroup(footer = stringResource(PushText.subtitle(push.permission)) + " " + stringResource(R.string.push_tokens_hint)) {
                val unsupported = push.permission?.status == PushPermissionStatus.Unsupported
                Item(
                    title = stringResource(R.string.push_permission),
                    detail = stringResource(PushText.label(push.permission)),
                    icon = { SettingsTile(Ionicon.NotificationsOutline, SettingsTiles.red) },
                    loading = push.loading,
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.PUSH_PERMISSION),
                )
                Item(
                    title = stringResource(R.string.push_request_again),
                    icon = { SettingsTile(Ionicon.ShieldCheckmarkOutline, SettingsTiles.green) },
                    onClick = onRequestPush,
                    loading = push.requesting,
                    enabled = !(push.requesting || push.loading || unsupported),
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.PUSH_REQUEST),
                )
                Item(
                    title = stringResource(R.string.push_reregister),
                    subtitle = push.currentToken?.let { stringResource(R.string.push_current_token, PushText.fingerprint(it)) },
                    icon = { SettingsTile(Ionicon.RefreshOutline, SettingsTiles.orange) },
                    onClick = onRefreshPush,
                    loading = push.refreshing,
                    enabled = !(push.refreshing || push.loading),
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.PUSH_REREGISTER),
                )
            }

            ItemGroup(
                footer = stringResource(R.string.push_tokens_footer, push.tokens.size),
            ) {
                if (push.tokens.isEmpty()) {
                    Item(title = stringResource(R.string.push_no_tokens), titleColor = colors.textSecondary, showChevron = false)
                }
                val cancel = stringResource(R.string.common_cancel)
                val delete = stringResource(R.string.common_delete)
                val thisDevice = stringResource(R.string.push_this_device)
                val deleteTitle = stringResource(R.string.push_delete_title)
                for (token in push.tokens) {
                    val current = push.currentToken == token.token
                    val fingerprint = PushText.fingerprint(token.token)
                    Item(
                        title = fingerprint,
                        detail = if (current) thisDevice else null,
                        subtitle = PushText.tokenSubtitle(resources, token, current, push.deviceLabel, push.appLabel),
                        subtitleLines = 0,
                        icon = { SettingsTile(if (current) Ionicon.PhonePortraitOutline else Ionicon.TrashOutline, if (current) SettingsTiles.gray else SettingsTiles.red) },
                        onClick = if (current) {
                            { copied(fingerprint, token.token) }
                        } else {
                            {
                                alert = Alert(
                                    deleteTitle,
                                    resources.getString(R.string.push_delete_message, fingerprint),
                                    listOf(AlertButton(cancel), AlertButton(delete, destructive = true) { onDeletePushToken(token) }),
                                    cancelable = false,
                                )
                            }
                        },
                        loading = push.deletingToken == token.token,
                        enabled = push.deletingToken == null,
                        showChevron = false,
                    )
                }
            }
        }
    }

    alert?.let { HappyAlert(alert = it, onDismiss = { alert = null }) }
}

/**
 * Settings › Backup & Restore (iOS's BackupSettingsViewController): the
 * secret key, shown on a tap as a code row the card's width and copied by a
 * tap on it or Copy Secret Key, with the warning that it is the account
 * under the card; Link New Device, which scans the code another phone shows
 * under Restore (it reads "Scanning..." meanwhile); and Restore an Account,
 * which signs in to another account by its key, this one staying.
 */
@Composable
fun BackupScreen(
    formattedSecretKey: String,
    onBack: () -> Unit,
    linkingDevice: Boolean = false,
    onLinkNewDevice: () -> Unit = {},
    onRestore: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    val copy = rememberCopy()
    var revealed by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val ok = stringResource(R.string.common_ok)
    val successTitle = stringResource(R.string.common_success)
    val errorTitle = stringResource(R.string.common_error)
    val secretCopied = stringResource(R.string.settings_account_secret_key_copied)
    val secretCopyFailed = stringResource(R.string.settings_account_secret_key_copy_failed)
    fun copyKey() = copy(formattedSecretKey, { alert = Alert(errorTitle, secretCopyFailed, listOf(AlertButton(ok))) }) {
        alert = Alert(successTitle, secretCopied, listOf(AlertButton(ok)))
    }

    Screen(header = { StackHeader(stringResource(R.string.settings_backup_restore), onBack) }) {
        ItemList {
            ItemGroup(footer = stringResource(R.string.settings_account_backup_description)) {
                Item(
                    title = stringResource(if (revealed) R.string.settings_hide_secret_key else R.string.settings_show_secret_key),
                    icon = { SettingsTile(if (revealed) Ionicon.EyeOffOutline else Ionicon.EyeOutline, SettingsTiles.orange) },
                    onClick = { revealed = !revealed },
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.SECRET_KEY),
                )
                if (revealed) {
                    Text(
                        text = formattedSecretKey,
                        style = AccountSpec.secretText,
                        color = colors.text,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button, onClick = ::copyKey)
                            .testTag(AccountTags.SECRET_KEY_TEXT)
                            .padding(horizontal = AccountSpec.secretPaddingHorizontal, vertical = AccountSpec.secretPaddingVertical),
                    )
                    Item(
                        title = stringResource(R.string.settings_copy_secret_key),
                        titleColor = colors.textLink,
                        icon = { Icon(Ionicon.CopyOutline, 22.dp, colors.textLink) },
                        onClick = ::copyKey,
                        showChevron = false,
                        modifier = Modifier.testTag(AccountTags.COPY_SECRET_KEY),
                    )
                }
            }
            ItemGroup(footer = stringResource(R.string.settings_link_device_footer)) {
                Item(
                    title = stringResource(R.string.settings_account_link_new_device),
                    detail = if (linkingDevice) stringResource(R.string.common_scanning) else null,
                    icon = { SettingsTile(Ionicon.QrCodeOutline, SettingsTiles.indigo) },
                    onClick = onLinkNewDevice,
                    enabled = !linkingDevice,
                    showChevron = false,
                    modifier = Modifier.revealRow(AccountTags.LINK_DEVICE),
                )
            }
            ItemGroup(footer = stringResource(R.string.settings_restore_account_footer)) {
                Item(
                    title = stringResource(R.string.settings_restore_account),
                    icon = { SettingsTile(Ionicon.KeyOutline, SettingsTiles.blue) },
                    onClick = onRestore,
                    modifier = Modifier.revealRow(AccountTags.RESTORE),
                )
            }
        }
    }

    alert?.let { HappyAlert(alert = it, onDismiss = { alert = null }) }
}

/**
 * Account's rows as Settings' search finds them (iOS's page rows less the
 * push tokens, which are read only once the page shows): found, [open]
 * opens the page at the row.
 */
@Composable
fun accountPageEntries(
    anonId: String?,
    publicId: String?,
    displayName: String?,
    username: String?,
    server: String?,
    open: (row: String) -> Unit,
): List<SettingsEntry> {
    val notAvailable = stringResource(R.string.settings_account_not_available)
    fun row(id: String, title: String, detail: String? = null, icon: (@Composable () -> Unit)? = null) =
        SettingsEntry(id = id, title = title, detail = detail, icon = icon, onClick = { open(id) }, page = true)
    return listOfNotNull(
        displayName?.let { row(AccountTags.NAME, stringResource(R.string.settings_account_name), it) },
        username?.let { row(AccountTags.USERNAME, stringResource(R.string.profile_username), "@$it") },
        row(AccountTags.ANALYTICS_ID, stringResource(R.string.settings_account_anonymous_id), anonId ?: notAvailable),
        row(AccountTags.PUBLIC_ID, stringResource(R.string.settings_account_public_id), publicId ?: notAvailable),
        row(AccountTags.SERVER, stringResource(R.string.settings_account_server), server ?: stringResource(R.string.settings_default_server)),
        row(AccountTags.ANALYTICS, stringResource(R.string.settings_account_analytics)) { SettingsTile(Ionicon.AnalyticsOutline, SettingsTiles.blue) },
        row(AccountTags.PUSH_PERMISSION, stringResource(R.string.push_permission)) { SettingsTile(Ionicon.NotificationsOutline, SettingsTiles.red) },
        row(AccountTags.PUSH_REQUEST, stringResource(R.string.push_request_again)) { SettingsTile(Ionicon.ShieldCheckmarkOutline, SettingsTiles.green) },
        row(AccountTags.PUSH_REREGISTER, stringResource(R.string.push_reregister)) { SettingsTile(Ionicon.RefreshOutline, SettingsTiles.orange) },
    )
}

/** Backup & Restore's rows as Settings' search finds them (the key hidden, as the page opens). */
@Composable
fun backupPageEntries(open: (row: String) -> Unit): List<SettingsEntry> = listOf(
    SettingsEntry(
        id = AccountTags.SECRET_KEY,
        title = stringResource(R.string.settings_show_secret_key),
        icon = { SettingsTile(Ionicon.EyeOutline, SettingsTiles.orange) },
        onClick = { open(AccountTags.SECRET_KEY) },
        page = true,
    ),
    SettingsEntry(
        id = AccountTags.LINK_DEVICE,
        title = stringResource(R.string.settings_account_link_new_device),
        icon = { SettingsTile(Ionicon.QrCodeOutline, SettingsTiles.indigo) },
        onClick = { open(AccountTags.LINK_DEVICE) },
        page = true,
    ),
    SettingsEntry(
        id = AccountTags.RESTORE,
        title = stringResource(R.string.settings_restore_account),
        icon = { SettingsTile(Ionicon.KeyOutline, SettingsTiles.blue) },
        onClick = { open(AccountTags.RESTORE) },
        page = true,
    ),
)
