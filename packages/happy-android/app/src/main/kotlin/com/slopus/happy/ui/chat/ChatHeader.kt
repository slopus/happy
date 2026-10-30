package com.slopus.happy.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.chat.resolveChatHeaderGit
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.compactCount
import com.slopus.happy.ui.components.HeaderSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.PickerSheetSection
import com.slopus.happy.ui.components.PickerSheetSpec
import com.slopus.happy.ui.conversation.ConversationPopup
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

/** Two 48 dp header actions; the overflow is 280 dp wide and scrolls within the window. */
@Composable
internal fun ChatHeaderActions(
    session: ChatSessionInfo?,
    modes: ComposerModes,
    metadata: SessionMetadata?,
    actions: ChatScreenActions,
) {
    val more = stringResource(R.string.conversation_composer_more)
    val compose = stringResource(R.string.session_new_chat)
    val details = stringResource(R.string.profile_details)
    val permissionTitle = composerPermissionTitle(metadata)
    val showPermission = metadata != null && modes.canChangePermission && modes.availableModes.isNotEmpty()
    val colors = HappyTheme.colors
    val haptics = LocalHapticFeedback.current
    Row {
        IconButton(onClick = actions.onCompose, modifier = Modifier.testTag(ChatScreenTags.COMPOSE).size(48.dp).semantics { contentDescription = compose }) {
            Icon(Ionicon.CreateOutline, 24.dp, colors.header.tint)
        }
        if (session != null || showPermission) {
            // Wait for this session's menu before consuming restored state:
            // the feed first emits an empty loading snapshot after recreation.
            var open by rememberSaveable(session?.id) { mutableStateOf(false) }
            Box {
                IconButton(onClick = { haptics.light(); open = !open }, modifier = Modifier.testTag(ChatScreenTags.MORE).size(48.dp).semantics { contentDescription = more }) {
                    Icon(Ionicon.EllipsisVertical, 24.dp, colors.header.tint)
                }
                if (open) ConversationPopup(
                    title = more,
                    onDismiss = { open = false },
                    alignEnd = true,
                    width = 280.dp,
                    belowAnchor = true,
                ) {
                    Column(Modifier.testTag(ChatScreenTags.MENU).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                        if (session != null) Row(
                            Modifier
                                .testTag(ChatScreenTags.INFO)
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clickable(role = Role.Button) { open = false; actions.onInfo() }
                                .padding(horizontal = 24.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Icon(Ionicon.InformationCircleOutline, 22.dp, colors.text)
                            Text(details, style = PickerSheetSpec.label, color = colors.text)
                        }
                        if (showPermission) {
                            PickerSheetSection("permissions", permissionTitle, separated = session != null)
                            ComposerPermissionOptions(modes, metadata) { field, option ->
                                haptics.light()
                                open = false
                                actions.onModeChange(field, option)
                            }
                        }
                    }
                }
            }
        }
    }
}
