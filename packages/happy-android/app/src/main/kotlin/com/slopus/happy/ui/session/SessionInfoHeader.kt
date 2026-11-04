package com.slopus.happy.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.model.ProjectAvatar
import com.slopus.happy.model.Session
import com.slopus.happy.model.avatarId
import com.slopus.happy.model.displayName
import com.slopus.happy.model.isTask
import com.slopus.happy.model.rigIdentity
import com.slopus.happy.ui.chat.rememberComposerStatus
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.AvatarBadgeLocation
import com.slopus.happy.ui.components.ProfileHeader
import com.slopus.happy.ui.components.ProfileHeaderSpec
import com.slopus.happy.ui.components.ProfileTile
import com.slopus.happy.ui.components.profileStartedText
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth

/**
 * iOS 6baca0bec/60158d2ac: home's avatar, name and Bot/Task · status,
 * then Model and Started. Both chat profiles share ProfileHeader's 88 dp
 * avatar and 12/14/2 dp gaps, and 80 dp tiles 10 dp apart, 24 below it.
 * Avatar decoding stays in Avatar's background image pipeline.
 */
@Composable
internal fun SessionInfoHeader(session: Session, avatar: ProjectAvatar?) {
    val spec = ProfileHeaderSpec
    val status = rememberComposerStatus(session.state, session.activeAt).text
    val kind = when {
        session.metadata?.bot != null -> stringResource(R.string.new_work_bot)
        session.isTask -> stringResource(R.string.new_work_task)
        else -> null
    }
    Column(Modifier.contentMaxWidth(LocalWindowLayout.current)) {
        ProfileHeader(session.displayName() ?: stringResource(R.string.session_new_chat), listOfNotNull(kind, status).joinToString(" · ")) {
            Avatar(
                id = session.avatarId(),
                size = spec.mark,
                bot = session.metadata?.bot != null,
                flavor = session.metadata?.flavor,
                clientId = session.metadata?.client?.id,
                badgeLocation = if (session.isTask) AvatarBadgeLocation.None else AvatarBadgeLocation.SessionList,
                imageUri = avatar?.uri,
                thumbhash = avatar?.thumbhash,
            )
        }
        Row(Modifier.padding(top = spec.tilesTop).padding(horizontal = ContentTokens.inset).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(spec.tileGap)) {
            ProfileTile(session.metadata?.rigIdentity()?.modelName ?: stringResource(R.string.agent_page_none),
                stringResource(R.string.conversation_details_model), Modifier.weight(1f))
            ProfileTile(profileStartedText(session.createdAt, System.currentTimeMillis()),
                stringResource(R.string.agent_page_started), Modifier.weight(1f))
        }
    }
}