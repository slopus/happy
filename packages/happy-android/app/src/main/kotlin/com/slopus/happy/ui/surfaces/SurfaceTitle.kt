package com.slopus.happy.ui.surfaces

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.chat.linkStatusWords
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.connection.rememberNetworkPath
import com.slopus.happy.ui.conversation.linkState

/** iOS 7aee3a9b8: brief link changes stay quiet; a sustained one replaces the title. */
@Composable
internal fun surfaceTitle(session: AgentSession, name: String): String {
    val status by session.status.collectAsStateWithLifecycle()
    val syncing by session.isSyncing.collectAsStateWithLifecycle()
    val link = rememberShownLinkState(status.linkState(syncing, rememberNetworkPath()))
    val locale = LocalConfiguration.current.locales[0]
    return linkStatusWords(link)?.replaceFirstChar { it.titlecase(locale) } ?: name
}