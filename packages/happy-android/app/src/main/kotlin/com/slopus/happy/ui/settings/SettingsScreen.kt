package com.slopus.happy.ui.settings

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.connection.DataStorageTags
import com.slopus.happy.model.Profile
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.SettingsDissolveBox
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

object SettingsTags {
    const val ACCOUNT = "settings.row.account"
    const val BACKUP = "settings.row.backup"
    const val APPEARANCE = "settings.row.appearance"
    const val LANGUAGE = "settings.row.language"
    const val VOICE = "settings.row.voice"
    const val AGENTS = "settings.row.agents"
    const val SCAN_TERMINAL = "settings.row.scanTerminal"
    const val ENTER_TERMINAL = "settings.row.enterTerminal"
    const val VERSION = "settings.version"
    const val SUPPORT = "settings.support"
    const val MANAGE_SUBSCRIPTIONS = "settings.manageSubscriptions"
    const val WHATS_NEW = "settings.row.whatsNew"
    const val GITHUB = "settings.row.github"
    const val REPORT_ISSUE = "settings.row.reportIssue"
    const val PRIVACY = "settings.row.privacy"
    const val TERMS = "settings.row.terms"
}

/** SettingsView.tsx, Android: the links and the icon colours the older pages still use. */
object SettingsSpec {
    /** Item icons are 29 Ionicons in the 32 icon slot. */
    val itemIcon = 29.dp

    val blue = Color(0xFF007AFF)
    val indigo = Color(0xFF5856D6)
    val red = Color(0xFFFF3B30)
    val orange = Color(0xFFFF9500)
    val teal = Color(0xFF5AC8FA)

    const val GITHUB_URL = "https://github.com/slopus/happy"
    const val ISSUES_URL = "https://github.com/slopus/happy/issues"
    const val PRIVACY_URL = "https://happy.engineering/privacy/"
    const val TERMS_URL = "https://happy.engineering/terms/"
    const val SUBSCRIPTIONS_URL = "https://play.google.com/store/account/subscriptions"
}

/** A settings row icon: a 29 Ionicon in [color]. */
@Composable
fun ItemIcon(icon: Ionicon, color: Color) {
    Icon(icon = icon, size = SettingsSpec.itemIcon, color = color)
}

/** The profile avatar: the uploaded or GitHub picture when there is one, else generated from the account id. */
@Composable
fun ProfileAvatar(profile: Profile, size: Dp) {
    Avatar(id = profile.id, size = size, imageUri = profile.avatarUrl, thumbhash = profile.avatar?.thumbhash)
}

/**
 * formatBuildSubtitle: "Commit 2026-10-16 03:12 UTC / abc1234" from the
 * build's commit, either part optional; null without both.
 */
fun buildSubtitle(commitSha: String?, commitTimestamp: String?, commit: String = "Commit", commitAt: (String) -> String = { "Commit $it" }): String? {
    val time = commitTimestamp?.takeIf { it.isNotEmpty() }?.let { value ->
        try {
            OffsetDateTime.parse(value).withOffsetSameInstant(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'"))
        } catch (_: DateTimeParseException) {
            value
        }
    }
    val sha = commitSha?.takeIf { it.isNotEmpty() }?.take(7)
    if (time == null && sha == null) return null
    return listOfNotNull(if (time != null) commitAt(time) else commit, sha).joinToString(" / ")
}

/** Everything a Happy account's Settings asks of the app. */
@Immutable
class HappySettingsActions(
    val onBack: () -> Unit = {},
    val onAccount: () -> Unit = {},
    val onBackup: () -> Unit = {},
    val onAppearance: () -> Unit = {},
    val onLanguage: () -> Unit = {},
    val onVoice: () -> Unit = {},
    val onAgents: () -> Unit = {},
    val onDataStorage: () -> Unit = {},
    val onScanTerminal: () -> Unit = {},
    val onEnterTerminal: () -> Unit = {},
    /** Signs this account out, once confirmed. */
    val onSignOut: () -> Unit = {},
)

/**
 * A Happy account's cards between the accounts card and Support us
 * (iOS's `rowsFor`): Account and Backup & Restore; Appearance, Language,
 * Voice Assistant and Agents; the terminal's Scan QR code and Enter URL.
 */
@Composable
fun happySettingsSections(actions: HappySettingsActions, connectingTerminal: Boolean): List<SettingsSection> = listOf(
    SettingsSection(
        listOf(
            SettingsEntry(
                id = SettingsTags.ACCOUNT,
                title = stringResource(R.string.settings_account),
                icon = { SettingsTile(Ionicon.PersonCircleOutline, SettingsTiles.blue) },
                onClick = actions.onAccount,
            ),
            SettingsEntry(
                id = SettingsTags.BACKUP,
                title = stringResource(R.string.settings_backup_restore),
                icon = { SettingsTile(Ionicon.KeyOutline, SettingsTiles.green) },
                onClick = actions.onBackup,
            ),
        ),
    ),
    SettingsSection(
        listOf(
            SettingsEntry(
                id = SettingsTags.APPEARANCE,
                title = stringResource(R.string.settings_appearance),
                icon = { SettingsTile(Ionicon.ColorPaletteOutline, SettingsTiles.purple) },
                onClick = actions.onAppearance,
            ),
            SettingsEntry(
                id = SettingsTags.LANGUAGE,
                title = stringResource(R.string.settings_language_title),
                icon = { SettingsTile(Ionicon.LanguageOutline, SettingsTiles.green) },
                onClick = actions.onLanguage,
            ),
            SettingsEntry(
                id = SettingsTags.VOICE,
                title = stringResource(R.string.settings_voice_assistant),
                icon = { SettingsTile(Ionicon.MicOutline, SettingsTiles.orange) },
                onClick = actions.onVoice,
            ),
            SettingsEntry(
                id = SettingsTags.AGENTS,
                title = stringResource(R.string.settings_agents),
                icon = { SettingsTile(Ionicon.OptionsOutline, SettingsTiles.teal) },
                onClick = actions.onAgents,
            ),
            SettingsEntry(
                id = DataStorageTags.ROW,
                title = stringResource(R.string.data_storage_title),
                icon = { SettingsTile(Ionicon.ServerOutline, SettingsTiles.green) },
                onClick = actions.onDataStorage,
            ),
        ),
    ),
    SettingsSection(
        listOf(
            SettingsEntry(
                id = SettingsTags.SCAN_TERMINAL,
                title = stringResource(R.string.settings_scan_qr_code_to_authenticate),
                icon = { SettingsTile(Ionicon.QrCodeOutline, SettingsTiles.indigo) },
                onClick = actions.onScanTerminal,
                loading = connectingTerminal,
                chevron = false,
            ),
            SettingsEntry(
                id = SettingsTags.ENTER_TERMINAL,
                title = stringResource(R.string.connect_enter_url_manually),
                icon = { SettingsTile(Ionicon.LinkOutline, SettingsTiles.indigo) },
                onClick = actions.onEnterTerminal,
                chevron = false,
            ),
        ),
    ),
)

/**
 * A Happy account's Settings, as iOS's SettingsViewController lays out a
 * Happy account's page: its picture, name and "Happy CLI · @username"
 * (an account with no name goes by "Happy CLI", iOS 64edb6a34) at the top
 * ([SettingsHeader]); every account on the phone with
 * Add Agent ([AccountsCard]); Account and Backup & Restore; Appearance,
 * Language, Voice Assistant and Agents; the terminal's Scan QR code and
 * Enter URL; Support us; About; and Logout. Rows carry iOS's coloured
 * tiles ([SettingsTile]). happy-app's Connected Accounts (Claude Code,
 * GitHub) are gone from here, as from iOS.
 *
 * Search is the bar's (iOS's integrated search button): the bar becomes a
 * field and the page what it finds ([SettingsSearchResults]): the accounts
 * by name, this page's rows and [pages], the rows of Account, Backup &
 * Restore, Voice and Language, which open their page at the row.
 *
 * The Version detail is "versionName (versionCode)": happy-app shows
 * "version / runtime N", its OTA runtime, and a native build has none; the
 * version code is what identifies this build instead.
 */
@Composable
fun SettingsScreen(
    profile: SettingsProfile,
    about: AboutInfo,
    accounts: AccountMenu = AccountMenu(),
    accountActions: AccountsCardActions = AccountsCardActions({}, {}),
    actions: HappySettingsActions = HappySettingsActions(),
    aboutActions: AboutActions = AboutActions(),
    connectingTerminal: Boolean = false,
    pages: List<SettingsEntry> = emptyList(),
    /** Where the page is scrolled; shared with the other kind's page, so a switch keeps it ([AccountSettings]). */
    scroll: ScrollState = rememberScrollState(),
) {
    val search = rememberSettingsSearch()
    val sections = happySettingsSections(actions, connectingTerminal) +
        supportSection(about, aboutActions) +
        aboutSection(about, aboutActions)
    Screen(
        header = {
            if (search.searching) {
                SettingsSearchBar(search, HeaderTags.BAR)
            } else {
                StackHeader(stringResource(R.string.settings_title), actions.onBack) { SettingsSearchButton(search) }
            }
        },
        avoidKeyboard = search.searching,
    ) {
        if (search.searching) {
            val profiles = settingsProfileEntries(accounts, accountActions.onSwitch)
            val rows = listOf(addAgentEntry(accountActions)) + sections.flatMap { it.rows } + pages
            SettingsSearchResults(search, settingsSearchResults(search.query, profiles, emptyList(), rows))
        } else {
            SettingsDissolveBox {
                ItemList(scrollState = scroll) {
                    SettingsHeader(profile)
                    AccountsCard(accounts, accountActions)
                    for (section in sections) SettingsCard(section)
                    RemoveCard(agent = false, name = profile.name, onRemove = actions.onSignOut)
                }
            }
        }
    }
}
