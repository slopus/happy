package com.slopus.happy.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.resolveChatHeaderGit
import com.slopus.happy.connection.LinkState
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.compactCount
import com.slopus.happy.ui.components.HeaderSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.ShimmerText
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

@Composable
internal fun ChatHeaderTitle(
    title: String,
    session: ChatSessionInfo?,
    gitStatus: GitStatus?,
    onClick: (() -> Unit)?,
    subtitleOverride: String? = null,
    /** The agent is working: the title shimmers, desktop's busy tab. */
    working: Boolean = false,
    /** The account's link as headers show it: on its way, it takes the subtitle's place with a spinner (iOS 7aee3a9b8). */
    link: LinkState = LinkState.Online,
) {
    val colors = HappyTheme.colors
    val header = remember(session?.metadata, gitStatus) { resolveChatHeaderGit(session?.metadata, gitStatus) }
    val linkWords = linkStatusWords(link)
    val subtitle = linkWords ?: subtitleOverride ?: header.subtitle
    val git = header.changes.takeIf { linkWords == null }
    Column(
        modifier = Modifier
            .testTag(ChatScreenTags.TITLE_BUTTON)
            .fillMaxHeight()
            .then(
                if (onClick != null) {
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
                } else {
                    Modifier
                },
            ),
        verticalArrangement = Arrangement.Center,
    ) {
        ShimmerText(
            text = title.ifEmpty { subtitle.orEmpty() },
            style = HeaderSpec.title,
            baseColor = colors.header.tint,
            highlightColor = ShimmerSpec.sheen(colors.header.tint, colors.header.background),
            shimmering = working,
            modifier = Modifier.testTag(HeaderTags.TITLE),
        )
        if (subtitle != null || git != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (linkWords != null) LinkStatusSpec.gap else ChatScreenSpec.gitGap)) {
                if (linkWords != null) LinkSpinner(colors.textSecondary)
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        style = HeaderSpec.subtitle,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).testTag(HeaderTags.SUBTITLE),
                    )
                }
                if (git != null) {
                    Row(
                        modifier = Modifier.testTag(ChatScreenTags.GIT_CHANGES),
                        horizontalArrangement = Arrangement.spacedBy(ChatScreenSpec.gitGap),
                    ) {
                        if (git.approximate) Text("≈", style = happyTextStyle(fontSize = 11), color = colors.textSecondary)
                        if (git.insertions > 0) Text("+${compactCount(git.insertions)}", style = ChatScreenSpec.gitText, color = ChatTheme.colors.gitAdded)
                        if (git.deletions > 0) Text("-${compactCount(git.deletions)}", style = ChatScreenSpec.gitText, color = ChatTheme.colors.gitRemoved)
                    }
                }
            }
        }
    }
}

/**
 * The header's one action, compose, 48 dp. The More menu is gone, as iOS
 * da5fda505 took it: the details open from the name, and the permission
 * mode is their first row ([com.slopus.happy.ui.session.SessionInfoScreen]).
 */
@Composable
internal fun ChatHeaderActions(actions: ChatScreenActions) {
    val compose = stringResource(R.string.session_new_chat)
    IconButton(onClick = actions.onCompose, modifier = Modifier.testTag(ChatScreenTags.COMPOSE).size(48.dp).semantics { contentDescription = compose }) {
        Icon(Ionicon.CreateOutline, 24.dp, HappyTheme.colors.header.tint)
    }
}
