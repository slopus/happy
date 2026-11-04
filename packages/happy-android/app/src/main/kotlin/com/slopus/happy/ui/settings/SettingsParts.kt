package com.slopus.happy.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.browser.rememberLinkMenu
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.avatar.AvatarPlaceholder
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.glass
import com.slopus.happy.ui.components.glassSource
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberGlassSource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * The pieces both kinds of profile's Settings are made of, as iOS's
 * SettingsViewController draws them: the picture, name and line at the top,
 * the accounts card, the coloured tiles, About, and the row that signs out
 * or disconnects.
 */
object SettingsPageTags {
    const val HEADER = "settings.header"
    const val PICTURE = "settings.picture"
    const val EDIT = "settings.edit"
    const val EDIT_AVATAR = "settings.edit.avatar"
    const val EDIT_NAME = "settings.edit.name"
    const val NAME = "settings.name"
    const val SUBTITLE = "settings.subtitle"
    const val ADD_AGENT = "settings.addAgent"
    const val REMOVE = "settings.remove"
    fun account(id: String) = "settings.account.$id"
}

/** SettingsLayout.swift and AgentEditButtonLayout.swift. */
object SettingsPageSpec {
    /** The picture: 8 under the bar, centred. */
    val pictureTop = 8.dp
    val picture = 100.dp
    /** The pencil badge in the picture's bottom-right corner, inside its square. */
    val badge = 32.dp
    val pencil = 16.dp
    val nameGap = 12.dp
    val subtitleGap = 2.dp
    val textSide = 24.dp
    /** From the line to the first card: 28 in all, [ItemGroup]'s 16 spacer included. */
    val cardsGap = 12.dp
    val name = happyTextStyle(fontSize = 28, lineHeight = 34, weight = FontWeight.Medium)
    val subtitle = happyTextStyle(fontSize = 17, lineHeight = 22)
    /** A row's coloured square and its glyph (Telegram's, as iOS's rows have them). */
    val tile = 30.dp
    val tileRadius = 8.dp
    val glyph = 20.dp
    /** An account's picture in its row: the tile's size, round. */
    val accountAvatar = 30.dp
    val check = 22.dp
}

/** iOS's tile colours (Palette.settingsTile*). */
object SettingsTiles {
    val orange = Color(0xFFFF9500)
    val gray = Color(0xFF8E8E93)
    val blue = Color(0xFF007AFF)
    val purple = Color(0xFFAF52DE)
    val green = Color(0xFF34C759)
    val red = Color(0xFFFF3B30)
    val teal = Color(0xFF30B0C7)
    val indigo = Color(0xFF5856D6)
}

/** A row's icon: a white [icon] on a rounded square of [color]. */
@Composable
fun SettingsTile(icon: Ionicon, color: Color) {
    Box(
        modifier = Modifier.size(SettingsPageSpec.tile).clip(RoundedCornerShape(SettingsPageSpec.tileRadius)).background(color),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, SettingsPageSpec.glyph, Color.White)
    }
}

/** Who the page is for, as its top shows them. */
@Immutable
data class SettingsProfile(
    /** The account's or agent connection's id. */
    val id: String,
    val name: String,
    /** The kind, then what else tells it apart: "Happy CLI · @login", "Happy Agent · Connected" ([kindSubtitle]). */
    val subtitle: String,
    val imageUri: String? = null,
    val thumbhash: String? = null,
    /** What picks the placeholder picture: an agent's own seed, else [id]. */
    val seed: String = id,
) {
    /** Its placeholder's seed when it has no picture: it moves with Animated Avatars on ([AvatarPlaceholder.liveSeed]). */
    val liveSeed: String? get() = AvatarPlaceholder.liveSeed(seed, imageUri, thumbhash)
}

/** The kind, then what else says which one it is (iOS's `AccountKind.subtitle`): "Happy CLI · @steve", "Happy Agent · Connected". */
fun kindSubtitle(kind: String, detail: String?): String = if (detail.isNullOrEmpty()) kind else "$kind · $detail"

/** One item of the picture's menu. */
@Immutable
data class SettingsEditItem(val title: String, val icon: Ionicon, val tag: String, val onClick: () -> Unit)

/**
 * The top of the page (SettingsLayout's picture, name and subtitle): the
 * 100 picture centred 8 under the bar, the name (28 medium) 12 under it and
 * the line (17, secondary) 2 under that, both centred and one line, 24 from
 * the sides. With [edit] the picture wears a 32 pencil badge in its
 * bottom-right corner, round glass over the picture ([glass]), and a tap
 * on it opens [edit] as a menu (AgentEditButton); without, it is only the
 * picture.
 */
@Composable
fun SettingsHeader(profile: SettingsProfile, edit: List<SettingsEditItem>? = null) {
    val colors = HappyTheme.colors
    var open by remember { mutableStateOf(false) }
    val picture = rememberGlassSource()
    val blurs = rememberGlassBlur()
    val label = stringResource(R.string.settings_edit_agent)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(SettingsPageTags.HEADER)
            .padding(top = SettingsPageSpec.pictureTop, bottom = SettingsPageSpec.cardsGap),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(SettingsPageSpec.picture)
                .testTag(SettingsPageTags.PICTURE)
                .then(
                    if (edit != null) {
                        Modifier
                            .clip(CircleShape)
                            .clickable(role = Role.Button, onClickLabel = label) { open = true }
                            .semantics { contentDescription = label }
                    } else {
                        Modifier
                    },
                ),
        ) {
            Avatar(
                profile.seed,
                SettingsPageSpec.picture,
                modifier = if (edit != null) Modifier.glassSource(picture) else Modifier,
                imageUri = profile.imageUri,
                thumbhash = profile.thumbhash,
                animated = profile.liveSeed != null,
            )
            if (edit != null) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .size(SettingsPageSpec.badge)
                        .glass(picture, CircleShape, GlassColors.of(colors.dark), blurs)
                        .testTag(SettingsPageTags.EDIT),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Ionicon.Pencil, SettingsPageSpec.pencil, colors.text)
                }
                HappyDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    for (item in edit) {
                        HappyMenuItem(
                            label = item.title,
                            leading = { Icon(item.icon, MenuSpec.icon, colors.text) },
                            onClick = {
                                open = false
                                item.onClick()
                            },
                            modifier = Modifier.testTag(item.tag),
                        )
                    }
                }
            }
        }
        Text(
            text = profile.name,
            style = SettingsPageSpec.name,
            color = colors.text,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(top = SettingsPageSpec.nameGap, start = SettingsPageSpec.textSide, end = SettingsPageSpec.textSide)
                .fillMaxWidth()
                .testTag(SettingsPageTags.NAME),
        )
        Text(
            text = profile.subtitle,
            style = SettingsPageSpec.subtitle,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(top = SettingsPageSpec.subtitleGap, start = SettingsPageSpec.textSide, end = SettingsPageSpec.textSide)
                .fillMaxWidth()
                .testTag(SettingsPageTags.SUBTITLE),
        )
    }
}

/** What the accounts card does with a row. */
@Immutable
class AccountsCardActions(
    /** Opens the account or agent connection [id]; the open one stays open. */
    val onSwitch: (id: String) -> Unit,
    /** Add's one flow: scan a code, add what it is for. */
    val onAdd: () -> Unit,
    /**
     * Signs [entry] out or disconnects it, once confirmed; null where it
     * can't go from here. Offered by holding its row.
     */
    val onRemove: ((entry: AccountMenuEntry) -> Unit)? = null,
    /** Whether [onRemove] takes [entry]. */
    val canRemove: (entry: AccountMenuEntry) -> Boolean = { true },
)

/**
 * Every account and agent connection on the phone in one card (iOS's
 * `accountRows`): each its picture round in the tile's place, its name, a
 * check on the open one; a tap opens another, holding one offers Sign out
 * or Disconnect, after a confirm. "Add Agent" closes the card, in the link
 * colour, with no chevron.
 */
@Composable
fun AccountsCard(accounts: AccountMenu, actions: AccountsCardActions) {
    val colors = HappyTheme.colors
    var confirming by remember { mutableStateOf<AccountMenuEntry?>(null) }
    ItemGroup {
        for (entry in accounts.entries) {
            var menu by remember(entry.id) { mutableStateOf(false) }
            val removable = actions.onRemove != null && actions.canRemove(entry)
            val name = entry.name ?: stringResource(if (entry.agent) R.string.account_kind_agent else R.string.account_kind_cli)
            Box {
                Item(
                    title = name,
                    subtitle = entry.detail,
                    icon = { Avatar(entry.seed, SettingsPageSpec.accountAvatar, imageUri = entry.imageUrl, thumbhash = entry.thumbhash, animated = entry.liveSeed != null) },
                    rightElement = when {
                        entry.active -> { { Icon(Ionicon.Checkmark, SettingsPageSpec.check, colors.textLink) } }
                        entry.attention -> { { Icon(Ionicon.AlertCircleOutline, SettingsPageSpec.check, colors.textDestructive) } }
                        else -> null
                    },
                    showChevron = false,
                    onClick = { if (!entry.active) actions.onSwitch(entry.id) },
                    onLongClick = if (removable) { { menu = true } } else null,
                    modifier = Modifier.testTag(SettingsPageTags.account(entry.id)).semantics { selected = entry.active },
                )
                HappyDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    HappyMenuItem(
                        label = stringResource(if (entry.agent) R.string.modals_disconnect else R.string.settings_account_logout),
                        leading = { Icon(Ionicon.LogOutOutline, MenuSpec.icon, colors.textDestructive) },
                        destructive = true,
                        onClick = {
                            menu = false
                            confirming = entry
                        },
                    )
                }
            }
        }
        SettingsRow(addAgentEntry(actions))
    }
    confirming?.let { entry -> RemoveConfirm(entry.agent, entry.name, onConfirm = { actions.onRemove?.invoke(entry) }, onDismiss = { confirming = null }) }
}

/** The accounts card's last row: "Add Agent" in the link colour, no chevron; Add's one flow. */
@Composable
fun addAgentEntry(actions: AccountsCardActions): SettingsEntry {
    val colors = HappyTheme.colors
    return SettingsEntry(
        id = SettingsPageTags.ADD_AGENT,
        title = stringResource(R.string.settings_add_agent),
        titleColor = colors.textLink,
        icon = { Icon(Ionicon.Add, 26.dp, colors.textLink) },
        chevron = false,
        onClick = actions.onAdd,
    )
}

/**
 * Asks before an account goes (iOS's `remove`): "Disconnect Happy Agent?"
 * with what that does here, or "Sign out of Happy CLI?" with happy-app's
 * backup warning.
 */
@Composable
fun RemoveConfirm(agent: Boolean, name: String?, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val action = stringResource(if (agent) R.string.modals_disconnect else R.string.settings_account_logout)
    HappyAlert(
        Alert(
            title = stringResource(if (agent) R.string.account_kind_disconnect_agent_title else R.string.account_kind_sign_out_cli_title),
            message = if (agent) stringResource(R.string.agent_settings_remove_message) else stringResource(R.string.settings_account_logout_confirm),
            buttons = listOf(
                AlertButton(stringResource(R.string.common_cancel)),
                AlertButton(action, destructive = true, onClick = onConfirm),
            ),
            cancelable = false,
        ),
        onDismiss = onDismiss,
    )
}

/** The page's last card: Sign out or Disconnect, red, after a confirm. */
@Composable
fun RemoveCard(agent: Boolean, name: String?, onRemove: () -> Unit) {
    var confirming by remember { mutableStateOf(false) }
    ItemGroup {
        Item(
            title = stringResource(if (agent) R.string.modals_disconnect else R.string.settings_account_logout),
            destructive = true,
            showChevron = false,
            onClick = { confirming = true },
            modifier = Modifier.testTag(SettingsPageTags.REMOVE),
        )
    }
    if (confirming) RemoveConfirm(agent, name, onConfirm = onRemove, onDismiss = { confirming = false })
}

/** What About shows: the build. */
@Immutable
data class AboutInfo(val versionName: String, val versionSubtitle: String? = null, val isPro: Boolean = false)

/** What About and Support us do. */
@Immutable
class AboutActions(
    val onOpenUrl: (String) -> Unit = {},
    val onWhatsNew: () -> Unit = {},
    /** A tap on Version; ten in a row toggle developer mode (useMultiClick). */
    val onVersion: () -> Unit = {},
    val onSupport: () -> Unit = {},
)

/** Support us (29 heart in a red tile; Pro gets the thanks and no action). */
@Composable
fun supportEntry(about: AboutInfo, actions: AboutActions) = SettingsEntry(
    id = SettingsTags.SUPPORT,
    title = stringResource(R.string.settings_support_us),
    subtitle = stringResource(if (about.isPro) R.string.settings_support_us_subtitle_pro else R.string.settings_support_us_subtitle),
    icon = { SettingsTile(Ionicon.HeartOutline, SettingsTiles.red) },
    onClick = if (about.isPro) null else actions.onSupport,
    chevron = false,
)

@Composable
fun SupportCard(about: AboutInfo, actions: AboutActions) {
    SettingsCard(supportSection(about, actions))
}

/** Store subscription management is available regardless of this account's entitlement. */
@Composable
fun supportSection(about: AboutInfo, actions: AboutActions) = SettingsSection(
    listOf(
        supportEntry(about, actions),
        SettingsEntry(
            id = SettingsTags.MANAGE_SUBSCRIPTIONS,
            title = stringResource(R.string.settings_manage_subscriptions),
            icon = { SettingsTile(Ionicon.CardOutline, SettingsTiles.blue) },
            onClick = { actions.onOpenUrl(SettingsSpec.SUBSCRIPTIONS_URL) },
        ),
    ),
)

/**
 * About (iOS's `aboutRows`, SettingsView.tsx's About without its title):
 * What's New, GitHub with "slopus/happy", Report an Issue, Privacy Policy,
 * Terms of Service and Version, the app's line under the card. No EULA:
 * happy-app shows Apple's on iOS only. The four rows that open a page
 * offer the link menu on a long press, as links in text do.
 */
@Composable
fun aboutSection(about: AboutInfo, actions: AboutActions) = SettingsSection(
    listOf(
        SettingsEntry(
            id = SettingsTags.WHATS_NEW,
            title = stringResource(R.string.settings_whats_new),
            icon = { SettingsTile(Ionicon.SparklesOutline, SettingsTiles.orange) },
            onClick = actions.onWhatsNew,
        ),
        SettingsEntry(
            id = SettingsTags.GITHUB,
            title = stringResource(R.string.settings_github),
            icon = { SettingsTile(Ionicon.LogoGithub, SettingsTiles.gray) },
            detail = "slopus/happy",
            onClick = { actions.onOpenUrl(SettingsSpec.GITHUB_URL) },
            onLongClick = rememberLinkMenu(SettingsSpec.GITHUB_URL),
        ),
        SettingsEntry(
            id = SettingsTags.REPORT_ISSUE,
            title = stringResource(R.string.settings_report_issue),
            icon = { SettingsTile(Ionicon.BugOutline, SettingsTiles.red) },
            onClick = { actions.onOpenUrl(SettingsSpec.ISSUES_URL) },
            onLongClick = rememberLinkMenu(SettingsSpec.ISSUES_URL),
        ),
        SettingsEntry(
            id = SettingsTags.PRIVACY,
            title = stringResource(R.string.settings_privacy_policy),
            icon = { SettingsTile(Ionicon.ShieldCheckmarkOutline, SettingsTiles.blue) },
            onClick = { actions.onOpenUrl(SettingsSpec.PRIVACY_URL) },
            onLongClick = rememberLinkMenu(SettingsSpec.PRIVACY_URL),
        ),
        SettingsEntry(
            id = SettingsTags.TERMS,
            title = stringResource(R.string.settings_terms_of_service),
            icon = { SettingsTile(Ionicon.DocumentTextOutline, SettingsTiles.gray) },
            onClick = { actions.onOpenUrl(SettingsSpec.TERMS_URL) },
            onLongClick = rememberLinkMenu(SettingsSpec.TERMS_URL),
        ),
        SettingsEntry(
            id = SettingsTags.VERSION,
            title = stringResource(R.string.common_version),
            subtitle = about.versionSubtitle,
            subtitleLines = 2,
            detail = about.versionName,
            icon = { SettingsTile(Ionicon.InformationCircleOutline, SettingsTiles.gray) },
            chevron = false,
            onClick = actions.onVersion,
        ),
    ),
    footer = stringResource(R.string.settings_about_footer),
)

@Composable
fun AboutCard(about: AboutInfo, actions: AboutActions) {
    SettingsCard(aboutSection(about, actions))
}
