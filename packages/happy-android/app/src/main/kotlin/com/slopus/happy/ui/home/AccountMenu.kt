package com.slopus.happy.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.ui.connect.LocalAddFlow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.avatar.AvatarPlaceholder
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuDivider
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme

/** One entry of the account menu: a Happy account or an agent connection. */
@Immutable
data class AccountMenuEntry(
    val id: String,
    /** The account's or agent's own name; null until known. */
    val name: String?,
    /** A Happy account's server host, shown under its name when it isn't the default. */
    val detail: String? = null,
    val imageUrl: String? = null,
    val thumbhash: String? = null,
    val agent: Boolean = false,
    val active: Boolean = false,
    /** Can't open as it is: revoked, or its server needs confirming. */
    val attention: Boolean = false,
    /** What its placeholder is picked by: a Happy account its id, an agent connection its computer's address ([AgentConnections.placeholderSeed]). */
    val seed: String = id,
) {
    /** Its placeholder's seed when it has no picture: it moves with Animated Avatars on ([AvatarPlaceholder.liveSeed]). */
    val liveSeed: String? get() = AvatarPlaceholder.liveSeed(seed, imageUrl, thumbhash)
}

/** What Home's avatar menu lists: Happy accounts first, then agent connections, each oldest first. */
@Immutable
data class AccountMenu(val entries: List<AccountMenuEntry> = emptyList()) {
    val active: AccountMenuEntry? get() = entries.firstOrNull { it.active }

    /** The check on [id], the account a page shows, also in the moment before a switch to it lands. */
    fun shownAs(id: String): AccountMenu =
        if (entries.all { it.active == (it.id == id) }) this else copy(entries = entries.map { it.copy(active = it.id == id) })
}

/** The account menu from the stored accounts and agent connections; [AppGraph.open] switches. */
@Composable
fun rememberAccountMenu(graph: AppGraph): AccountMenu {
    val registry by graph.accountStore.registry.collectAsStateWithLifecycle()
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val seeds by produceState(emptyMap<String, String>(), agents) {
        value = agents.mapNotNull { agent -> graph.agentConnections.placeholderSeed(agent.id)?.let { agent.id to it } }.toMap()
    }
    val defaultUrl = graph.serverConfig.defaultUrl
    return remember(registry, agents, seeds, defaultUrl) {
        AccountMenu(
            registry.ordered.map { entry ->
                AccountMenuEntry(
                    id = entry.id,
                    name = entry.display?.name ?: entry.display?.username,
                    detail = entry.serverUrl.takeIf { it != defaultUrl }?.let { url -> runCatching { java.net.URI(url).host }.getOrNull() ?: url },
                    imageUrl = entry.display?.avatarUrl,
                    thumbhash = entry.display?.avatarThumbhash,
                    active = registry.activeId == entry.id,
                    attention = !entry.serverConfirmed,
                )
            } + agents.sortedBy { it.addedAt }.map { agent ->
                AccountMenuEntry(
                    id = agent.id,
                    seed = seeds[agent.id] ?: agent.id,
                    name = agent.name,
                    imageUrl = agent.avatarFile?.let { "file://$it" },
                    thumbhash = agent.thumbhash,
                    agent = true,
                    active = registry.activeId == agent.id,
                    attention = agent.revoked || agent.signInRequired,
                    detail = agent.server?.removePrefix("https://"),
                )
            },
        )
    }
}

object AccountMenuTags {
    const val BUTTON = "accountMenu.button"
    const val MENU = "accountMenu.menu"
    const val ADD = "accountMenu.add"
    fun entry(id: String) = "accountMenu.entry.$id"
}

object AccountMenuSpec {
    /** The touch target: 48 high, and 4 + 48 + 4 wide in a top app bar's navigation slot. */
    val button = 48.dp
    val buttonInset = 4.dp
    val avatar = 32.dp
    /** The pressed circle round the avatar. */
    val ripple = 44.dp
    val rowAvatar = 32.dp
    /** The menu's start, from the button's: 8 from the window's edge in a top app bar. */
    val menuOffset = DpOffset(4.dp, 4.dp)
    val attentionIcon = 20.dp
    val addIcon = 22.dp
}

/**
 * Home's top-left control (AGENTS.md, design decisions: Home's top bar): the
 * open account's 32 avatar, in a 48 target with 4 either side, so in a
 * Material top app bar's navigation slot (itself 4 in) the avatar's left
 * edge is on the bar's keyline (home's bar is 16 further in, so that is
 * the left edge of the rows' avatars and marks inside the cards), and the
 * title follows 12 after it. Tapped, a Material menu ([HappyDropdownMenu])
 * of every Happy account and agent connection on the phone (avatar, name,
 * the server or kind under it; the open one checked, one needing attention
 * flagged), then Add, which scans a code and adds the Happy account or
 * agent connection it is for ([LocalAddFlow]). Picking one switches.
 * Outside a top app bar, where the slot is not already 4 in, pass a 0 [inset].
 */
@Composable
fun AccountMenuButton(
    menu: AccountMenu,
    onSwitch: (String) -> Unit,
    onAdd: () -> Unit = LocalAddFlow.current?.let { it::scan } ?: {},
    inset: Dp = AccountMenuSpec.buttonInset,
) {
    val colors = HappyTheme.colors
    var open by remember { mutableStateOf(false) }
    val active = menu.active
    val label = stringResource(R.string.account_menu_title)
    val interaction = remember { MutableInteractionSource() }
    Box(Modifier.padding(horizontal = inset)) {
        Box(
            modifier = Modifier
                .size(AccountMenuSpec.button)
                .clickable(interaction, indication = null, role = Role.Button, onClickLabel = label) { open = true }
                .semantics { contentDescription = active?.name?.let { "$label, $it" } ?: label }
                .testTag(AccountMenuTags.BUTTON),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier.size(AccountMenuSpec.ripple).clip(CircleShape).indication(interaction, ripple()),
                contentAlignment = Alignment.Center,
            ) {
                if (active != null) {
                    // The button moves; the menu's rows stay still, as happy-ios's system menu does.
                    Avatar(active.seed, AccountMenuSpec.avatar, imageUri = active.imageUrl, thumbhash = active.thumbhash, animated = active.liveSeed != null)
                } else {
                    Icon(Ionicon.PersonCircleOutline, AccountMenuSpec.avatar, colors.header.tint)
                }
            }
        }
        HappyDropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            offset = AccountMenuSpec.menuOffset,
            modifier = Modifier.testTag(AccountMenuTags.MENU),
        ) {
            for (entry in menu.entries) {
                // The two kinds (iOS 64edb6a34): an agent connection is Happy Agent, a relay account Happy CLI. One
                // with no name of its own goes by its kind; the rows look alike, so TalkBack hears the kind after the name.
                val kind = stringResource(if (entry.agent) R.string.account_kind_agent else R.string.account_kind_cli)
                val name = entry.name ?: kind
                HappyMenuItem(
                    label = name,
                    supporting = entry.detail,
                    leading = { Avatar(entry.seed, AccountMenuSpec.rowAvatar, imageUri = entry.imageUrl, thumbhash = entry.thumbhash, animated = false) },
                    trailing = if (entry.attention && !entry.active) {
                        { Icon(Ionicon.AlertCircleOutline, AccountMenuSpec.attentionIcon, colors.textDestructive) }
                    } else {
                        null
                    },
                    selected = entry.active,
                    onClick = {
                        open = false
                        if (!entry.active) onSwitch(entry.id)
                    },
                    modifier = Modifier
                        .semantics { contentDescription = if (name == kind) name else "$name, $kind" }
                        .testTag(AccountMenuTags.entry(entry.id)),
                )
            }
            if (menu.entries.isNotEmpty()) HappyMenuDivider()
            HappyMenuItem(
                label = stringResource(R.string.account_menu_add),
                leading = {
                    Box(Modifier.size(AccountMenuSpec.rowAvatar), contentAlignment = Alignment.Center) {
                        Icon(Ionicon.QrCodeOutline, AccountMenuSpec.addIcon, colors.text)
                    }
                },
                onClick = {
                    open = false
                    onAdd()
                },
                modifier = Modifier.testTag(AccountMenuTags.ADD),
            )
        }
    }
}
