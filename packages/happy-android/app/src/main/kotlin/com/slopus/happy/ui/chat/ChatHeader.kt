package com.slopus.happy.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
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
import com.slopus.happy.R
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.resolveChatHeaderGit
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.avatarId
import com.slopus.happy.model.compactCount
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.AvatarBadgeLocation
import com.slopus.happy.ui.components.HeaderSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

@Composable
internal fun ChatHeaderTitle(
    title: String,
    session: ChatSessionInfo?,
    gitStatus: GitStatus?,
    onClick: (() -> Unit)?,
    subtitleOverride: String? = null,
) {
    val colors = HappyTheme.colors
    val header = remember(session?.metadata, gitStatus) { resolveChatHeaderGit(session?.metadata, gitStatus) }
    val subtitle = subtitleOverride ?: header.subtitle
    val git = header.changes
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
        Text(
            text = title.ifEmpty { subtitle.orEmpty() },
            style = HeaderSpec.title,
            color = colors.header.tint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(HeaderTags.TITLE),
        )
        if (subtitle != null || git != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ChatScreenSpec.gitGap)) {
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

@Composable
internal fun HeaderAvatar(session: ChatSessionInfo, online: Boolean, onClick: () -> Unit) {
    val metadata = session.metadata
    // Unnamed in happy-app; it opens what the home menu calls Details.
    val details = stringResource(R.string.profile_details)
    Box(
        modifier = Modifier
            .testTag(ChatScreenTags.AVATAR)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = details },
    ) {
        Avatar(
            id = session.session.avatarId(),
            size = ChatScreenSpec.avatar,
            bot = metadata?.bot != null,
            monochrome = !online,
            flavor = metadata?.flavor,
            clientId = metadata?.client?.id,
            badgeLocation = AvatarBadgeLocation.SessionHeader,
            imageUri = session.session.avatar?.uri,
            thumbhash = session.session.avatar?.thumbhash,
        )
    }
}
