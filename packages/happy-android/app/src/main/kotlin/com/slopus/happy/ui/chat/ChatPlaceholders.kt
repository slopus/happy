package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.model.formatPathRelativeToHome
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.launch

@Composable
internal fun Spinner(modifier: Modifier = Modifier) {
    CircularProgressIndicator(modifier.size(20.dp), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
}

@Composable
internal fun DeletedSession() {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier.testTag(ChatScreenTags.DELETED).fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Ionicon.TrashOutline, ChatScreenSpec.deletedIcon, colors.textSecondary, Modifier.testTag(ChatScreenTags.DELETED_ICON))
        Text(
            stringResource(R.string.errors_session_deleted),
            style = ChatScreenSpec.deletedTitle,
            color = colors.text,
            modifier = Modifier.padding(top = ChatScreenSpec.deletedTitleMarginTop).testTag(ChatScreenTags.DELETED_TITLE),
        )
        Text(
            stringResource(R.string.errors_session_deleted_description),
            style = ChatScreenSpec.deletedDescription,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .padding(top = ChatScreenSpec.deletedDescriptionMarginTop)
                .testTag(ChatScreenTags.DELETED_DESCRIPTION)
                .padding(horizontal = ChatScreenSpec.deletedDescriptionPadding),
        )
    }
}

private fun osIcon(os: String?): Ionicon {
    val lower = os?.lowercase() ?: return Ionicon.HardwareChipOutline
    return when {
        "darwin" in lower || "mac" in lower -> Ionicon.LaptopOutline
        "win" in lower -> Ionicon.DesktopOutline
        "linux" in lower -> Ionicon.TerminalOutline
        else -> Ionicon.HardwareChipOutline
    }
}

/**
 * EmptyMessages.tsx. Spec: centred with 48 side padding: the machine's OS
 * icon 72 (textSecondary, 12 below), the host 18 semibold (4 below), the
 * path relative to home 14 secondary (40 below), then "No messages yet"
 * 20 secondary (8 below) once the server has no older page; while it may,
 * pages are fetched (a spinner; Retry after a failure; Load more after
 * five empty pages). Last, "Created {relative time}" 16/24 secondary.
 */
@Composable
fun EmptyMessages(
    session: ChatSessionInfo,
    hasMoreOlder: Boolean,
    isLoadingOlder: Boolean,
    pager: OlderPager,
    now: Long = System.currentTimeMillis(),
) {
    val colors = HappyTheme.colors
    val metadata = session.metadata
    val scope = rememberCoroutineScope()
    val resources = LocalResources.current
    val blocked = pager.blocked
    LaunchedEffect(hasMoreOlder, isLoadingOlder, blocked) {
        if (hasMoreOlder && !isLoadingOlder && blocked == null) scope.launch { pager.request { null } }
    }
    Column(
        modifier = Modifier
            .testTag(ChatScreenTags.EMPTY)
            .fillMaxSize()
            .padding(horizontal = ChatScreenSpec.emptyPaddingHorizontal),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            osIcon(metadata?.os),
            ChatScreenSpec.emptyIcon,
            colors.textSecondary,
            Modifier.padding(bottom = ChatScreenSpec.emptyIconMarginBottom).testTag(ChatScreenTags.EMPTY_ICON),
        )
        val host = metadata?.host
        val path = metadata?.path
        if (!host.isNullOrEmpty()) {
            Text(
                host,
                style = ChatScreenSpec.emptyHost,
                color = colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = ChatScreenSpec.emptyHostMarginBottom).testTag(ChatScreenTags.EMPTY_HOST),
            )
        }
        if (!path.isNullOrEmpty()) {
            Text(
                formatPathRelativeToHome(path, metadata.homeDir),
                style = ChatScreenSpec.emptyPath,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = ChatScreenSpec.emptyPathMarginBottom).testTag(ChatScreenTags.EMPTY_PATH),
            )
        }
        Box(modifier = Modifier.testTag(ChatScreenTags.EMPTY_STATUS), contentAlignment = Alignment.Center) {
            when {
                !hasMoreOlder -> Text(
                    // Literal in happy-app (EmptyMessages.tsx).
                    "No messages yet",
                    style = ChatScreenSpec.emptyNoMessages,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = ChatScreenSpec.emptyNoMessagesMarginBottom),
                )
                blocked == OlderBlock.Error -> RoundButton(
                    stringResource(R.string.common_retry),
                    pager::retry,
                    size = RoundButtonSize.Small,
                    display = RoundButtonDisplay.Inverted,
                )
                blocked == OlderBlock.Limit -> RoundButton(
                    stringResource(R.string.common_load_more),
                    pager::loadMore,
                    size = RoundButtonSize.Small,
                    display = RoundButtonDisplay.Inverted,
                )
                else -> Spinner(Modifier.padding(bottom = ChatScreenSpec.emptyNoMessagesMarginBottom))
            }
        }
        Text(
            // "Created" is literal in happy-app (EmptyMessages.tsx).
            "Created ${formatRelativeTime(resources, session.session.createdAt, now)}",
            style = ChatScreenSpec.emptyCreated,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(ChatScreenTags.EMPTY_CREATED),
        )
    }
}
