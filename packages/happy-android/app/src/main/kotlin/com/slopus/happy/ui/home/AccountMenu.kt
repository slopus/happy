package com.slopus.happy.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.ui.connect.LocalAddFlow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

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
)

/** What Home's avatar menu lists: Happy accounts first, then agent connections, each oldest first. */
@Immutable
data class AccountMenu(val entries: List<AccountMenuEntry> = emptyList()) {
    val active: AccountMenuEntry? get() = entries.firstOrNull { it.active }
}

/** The account menu from the stored accounts and agent connections; [AppGraph.open] switches. */
@Composable
fun rememberAccountMenu(graph: AppGraph): AccountMenu {
    val registry by graph.accountStore.registry.collectAsStateWithLifecycle()
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val defaultUrl = graph.serverConfig.defaultUrl
    return remember(registry, agents, defaultUrl) {
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
                    name = agent.name,
                    agent = true,
                    active = registry.activeId == agent.id,
                    attention = agent.revoked,
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
    val button = 44.dp
    val avatar = 28.dp
    val rowAvatar = 28.dp
    val minWidth = 240.dp
    val name = happyTextStyle(fontSize = 16, lineHeight = 22, weight = FontWeight.Medium)
    val detail = happyTextStyle(fontSize = 13, lineHeight = 18)
}

/**
 * Home's top-left control (AGENTS.md, design decisions: Home's top bar): the
 * open account's avatar; tapped, a drop-down of every Happy account and
 * agent connection on the phone (avatar and name, a check on the open
 * one), then "Add", which scans a code and adds the Happy account or
 * agent connection it is for ([LocalAddFlow]). Picking one switches.
 */
@Composable
fun AccountMenuButton(
    menu: AccountMenu,
    onSwitch: (String) -> Unit,
    onAdd: () -> Unit = LocalAddFlow.current?.let { it::scan } ?: {},
) {
    val colors = HappyTheme.colors
    var open by remember { mutableStateOf(false) }
    val active = menu.active
    val label = stringResource(R.string.account_menu_title)
    Box {
        Box(
            modifier = Modifier
                .size(AccountMenuSpec.button)
                .clip(CircleShape)
                .clickable(role = Role.Button, onClickLabel = label) { open = true }
                .semantics { contentDescription = active?.name?.let { "$label, $it" } ?: label }
                .testTag(AccountMenuTags.BUTTON),
            contentAlignment = Alignment.Center,
        ) {
            if (active != null) {
                Avatar(active.id, AccountMenuSpec.avatar, imageUri = active.imageUrl, thumbhash = active.thumbhash)
            } else {
                Icon(Ionicon.PersonCircleOutline, AccountMenuSpec.avatar, colors.header.tint)
            }
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.widthIn(min = AccountMenuSpec.minWidth).testTag(AccountMenuTags.MENU),
        ) {
            for (entry in menu.entries) {
                DropdownMenuItem(
                    text = { EntryText(entry) },
                    leadingIcon = { Avatar(entry.id, AccountMenuSpec.rowAvatar, imageUri = entry.imageUrl, thumbhash = entry.thumbhash) },
                    trailingIcon = when {
                        entry.active -> { { Icon(Ionicon.Checkmark, 20.dp, colors.text) } }
                        entry.attention -> { { Icon(Ionicon.AlertCircleOutline, 20.dp, colors.textDestructive) } }
                        else -> null
                    },
                    onClick = {
                        open = false
                        if (!entry.active) onSwitch(entry.id)
                    },
                    modifier = Modifier.testTag(AccountMenuTags.entry(entry.id)).semantics { selected = entry.active },
                )
            }
            if (menu.entries.isNotEmpty()) HorizontalDivider(color = colors.divider)
            DropdownMenuItem(
                text = { Text(stringResource(R.string.account_menu_add), style = AccountMenuSpec.name, color = colors.text) },
                leadingIcon = { Icon(Ionicon.QrCodeOutline, 22.dp, colors.text) },
                onClick = {
                    open = false
                    onAdd()
                },
                modifier = Modifier.testTag(AccountMenuTags.ADD),
            )
        }
    }
}

@Composable
private fun EntryText(entry: AccountMenuEntry) {
    val colors = HappyTheme.colors
    val name = entry.name ?: stringResource(if (entry.agent) R.string.account_menu_unnamed_agent else R.string.account_menu_unnamed_account)
    val detail = entry.detail ?: if (entry.agent) stringResource(R.string.account_menu_agent) else null
    Column(verticalArrangement = Arrangement.Center) {
        Text(name, style = AccountMenuSpec.name, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (detail != null) {
            Text(detail, style = AccountMenuSpec.detail, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
