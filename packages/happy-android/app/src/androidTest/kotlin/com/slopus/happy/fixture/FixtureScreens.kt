package com.slopus.happy.fixture

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.conversation.ArtifactRouteContent
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.SecretRequestActions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.emptyFlow

/**
 * The real conversation screen and the real artifact loader over a
 * [FixtureTransport], in a navigation host of two destinations.
 *
 * What is real: Conversation, ConversationApi and its parsing, ConversationScreen
 * with its rows, the question card and secret form, the picture viewer, the
 * media opener (its staging, FileProvider grant and ACTION_VIEW), and
 * ArtifactRouteContent, the artifact route's own loader.
 *
 * What is not, and so not covered: the agent connection and its transport,
 * AppGraph, the app's own nav graph and ConversationEntry's wiring, which this
 * mirrors for the actions these checks use. Events never arrive here.
 */
@Composable
fun FixtureScreens(transport: FixtureTransport, scope: CoroutineScope, onConversation: (Conversation) -> Unit = {}) {
    val nav = rememberNavController()
    val conversation = remember {
        Conversation(
            api = ConversationApi(transport.request),
            signals = emptyFlow(),
            scope = scope,
            agentId = FixtureTransport.AGENT,
        ).also { onConversation(it) }
    }
    NavHost(nav, startDestination = "chat") {
        composable("chat") {
            val state by conversation.state.collectAsStateWithLifecycle()
            DisposableEffect(conversation) { onDispose { conversation.setVisible(false) } }
            ConversationScreen(
                state = state,
                connection = null,
                actions = remember(conversation, nav) {
                    ConversationScreenActions(
                        onBack = {},
                        onDraftChange = conversation::setDraft,
                        onAnswer = conversation::answer,
                        onOpenArtifact = { artifactId -> nav.navigate("artifact/$artifactId") },
                        onRetryLoad = conversation::retryLoad,
                        loadMedia = conversation::media,
                        onVisible = conversation::setVisible,
                        secrets = SecretRequestActions(
                            secrets = { ConversationApi(transport.request).secrets() },
                            create = { id, description, values -> ConversationApi(transport.request).createSecret(id, description, values) },
                        ),
                    )
                },
            )
        }
        composable("artifact/{id}") { entry ->
            val artifactId = entry.arguments?.getString("id").orEmpty()
            ArtifactRouteContent(transport, artifactId, onBack = { nav.popBackStack() }) {
                ConversationApi(transport.request)
            }
        }
    }
}
