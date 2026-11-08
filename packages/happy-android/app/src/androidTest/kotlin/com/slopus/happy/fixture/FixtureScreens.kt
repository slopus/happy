package com.slopus.happy.fixture

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.artifacts.ArtifactActions
import com.slopus.happy.ui.artifacts.ArtifactLoader
import com.slopus.happy.ui.artifacts.ArtifactScreen
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.SecretRequestActions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.Json

/**
 * The real conversation screen and the real artifact loader over a
 * [FixtureTransport], in a navigation host of two destinations.
 *
 * What is real: Conversation, ConversationApi and its parsing, ConversationScreen
 * with its rows, the question card and secret form, the picture viewer, the
 * media opener (its staging, FileProvider grant and ACTION_VIEW), and
 * ArtifactLoader and ArtifactScreen, the artifact route's own loader and screen.
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
                actions = remember(conversation, nav) {
                    ConversationScreenActions(
                        onBack = {},
                        onDraftChange = conversation::setDraft,
                        onSend = { words, attachments -> conversation.send(words, attachments) },
                        onAnswer = conversation::answer,
                        onOpenArtifact = { row -> nav.navigate("artifact/${row.artifactId}") },
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
            val loader = remember(artifactId) {
                ArtifactLoader(files(transport), null, scope, ArtifactRef(artifactId, 1, "", "", followsLatest = true)).also(ArtifactLoader::load)
            }
            DisposableEffect(loader) { onDispose { loader.close() } }
            val ui by loader.state.collectAsStateWithLifecycle()
            val title by loader.title.collectAsStateWithLifecycle()
            ArtifactScreen(
                title = title,
                ui = ui,
                media = loader.media,
                computer = "Fixture",
                actions = remember(loader, nav) {
                    ArtifactActions(
                        onBack = { nav.popBackStack() },
                        link = loader::link,
                        fileReader = { file, progress -> files(transport).bytes(artifactId, loader.version!!.number, file.path, progress = progress) },
                        artifactKey = "artifact-$artifactId",
                    )
                },
            )
        }
    }
}

private fun files(transport: FixtureTransport) = ArtifactClient(AgentClient(FixtureAgent(transport), "fixture"))

/** The fixture's answers as a [Transport], for the artifact client, which speaks to one. */
private class FixtureAgent(private val transport: FixtureTransport) : Transport {
    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
        transport.request(method, path, body?.let { Json.parseToJsonElement(it.decodeToString()) }, category)

    override suspend fun close() {}
}
