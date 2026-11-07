package com.slopus.happy.fixture

import android.content.ClipboardManager
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.HappyApplication
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.references.ReferenceReader
import com.slopus.happy.ui.artifacts.ArtifactActions
import com.slopus.happy.ui.artifacts.ArtifactLoader
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.artifacts.ArtifactScreen
import com.slopus.happy.ui.artifacts.ArtifactsScreen
import com.slopus.happy.ui.artifacts.ArtifactsTags
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.connection.LocalHappyLinks
import com.slopus.happy.ui.connection.rememberHappyLinks
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.references.ProvideReferenceWords
import com.slopus.happy.ui.references.ReferenceOpener
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Share links on a device: the Artifacts list's held row copies an
 * artifact's link.happy.page link, and a chat's share links read and open
 * in the app through the real [com.slopus.happy.ui.connection.HappyLinks]:
 * the one naming this installation by its live title and opening the
 * artifact, another server's saying it isn't connected.
 *
 * What is real: ArtifactsScreen, ConversationScreen over a real Conversation
 * and ReferenceReader, ArtifactScreen and ArtifactLoader, HappyLinks and the
 * app's AgentConnections, which hold one made-up connection for the test
 * (removed after). What is not: the daemon, which is [FixtureTransport] in
 * this test's memory, so nothing here is anyone's. Captures go to the test
 * app's files under `device-evidence/share-links-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class ShareLinksDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val transport = FixtureTransport()
    private val graph = runBlocking { (app.applicationContext as HappyApplication).graphReady.await() }
    private var connection: String? = null

    @After fun tearDown() {
        scope.cancel()
        connection?.let { runBlocking { graph.agentConnections.remove(it) } }
    }

    private fun capture(name: String, settle: Long = 700) {
        // The test's clock draws the frames: move it on, then give the system's own overlays real time.
        rule.mainClock.advanceTimeBy(settle)
        rule.waitForIdle()
        SystemClock.sleep(settle)
        device.takeScreenshot(File(evidence, "share-links-$name.png"))
        android.util.Log.i("FixtureEvidence", "share-links-$name captured; in front: ${device.currentPackageName}")
    }

    /** The fixture, and an agent message naming the notes here (labelled and bare) and a plan on another server. */
    private val request: AgentRequest = { method, path, body, category ->
        if (path.substringBefore('?') == "/v0/agents/${FixtureTransport.AGENT}/messages") json(PAGE) else transport.request(method, path, body, category)
    }

    @Test fun copyAndOpenShareLinks() {
        val id = runBlocking {
            val added = graph.agentConnections.add(AgentConnectionCredentials("127.0.0.1", 9, "fx-share-links", "fx-token"), "Fixture server")
            graph.agentConnections.update(added.id) { it.copy(instanceId = INSTANCE) }
            added.id
        }
        connection = id
        val files = ArtifactClient(AgentClient(Agent(request), "fixture"))
        val reader = ReferenceReader(scope, MutableStateFlow(AgentCatalog()), emptyFlow(), readArtifact = { files.artifact(it) }, readUsers = { emptyMap() })
        val conversation = Conversation(
            api = ConversationApi(request),
            signals = emptyFlow(),
            scope = scope,
            agentId = FixtureTransport.AGENT,
            references = reader,
            here = { it == INSTANCE },
        ).also { it.start() }
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme {
                val nav = rememberNavController()
                val happyLinks = rememberHappyLinks(graph, nav, id)
                CompositionLocalProvider(LocalHappyLinks provides happyLinks) {
                    ProvideReferenceWords(reader)
                    val context = LocalContext.current
                    // As ConversationEntry wires its chat: a name opens what it names, a Happy URL or share link goes to HappyLinks.
                    val references = remember(nav) { ReferenceOpener(nav, id, reader, happyLinks) }
                    val links = remember(references) { LinkOpener.agent(context, "Fixture", app = references::open, opens = references::opens) {} }
                    ProvideLinks(links) {
                        NavHost(nav, startDestination = "artifacts") {
                            composable("artifacts") {
                                ArtifactsScreen(
                                    ArtifactCatalogFeed.State(ARTIFACTS, loaded = true),
                                    onBack = {},
                                    onOpen = {},
                                    shareLink = { com.slopus.happy.agent.HappyShareLinks.format(com.slopus.happy.agent.HappyLink.Reference(com.slopus.happy.agent.HappyReferenceKind.Artifact, it.id), INSTANCE) },
                                )
                            }
                            composable("chat") {
                                val state by conversation.state.collectAsStateWithLifecycle()
                                DisposableEffect(conversation) { onDispose { conversation.setVisible(false) } }
                                ConversationScreen(
                                    state = state,
                                    actions = remember(conversation) {
                                        ConversationScreenActions(
                                            onBack = { nav.popBackStack() },
                                            onDraftChange = conversation::setDraft,
                                            onRetryLoad = conversation::retryLoad,
                                            onVisible = conversation::setVisible,
                                        )
                                    },
                                )
                            }
                            composable<ArtifactRoute> { entry ->
                                val route = entry.toRoute<ArtifactRoute>()
                                val loader = remember(route) {
                                    ArtifactLoader(files, null, scope, ArtifactRef(route.artifactId, route.version, route.type, route.title, route.followsLatest)).also(ArtifactLoader::load)
                                }
                                DisposableEffect(loader) { onDispose { loader.close() } }
                                val ui by loader.state.collectAsStateWithLifecycle()
                                val title by loader.title.collectAsStateWithLifecycle()
                                ArtifactScreen(title, ui, loader.media, "Fixture", ArtifactActions(onBack = { nav.popBackStack() }, link = loader::link))
                            }
                        }
                    }
                    androidx.compose.runtime.SideEffect { navigator = nav }
                }
            }
        }
        rule.waitForIdle()

        // 1. The held row's menu: Copy link to artifact.
        rule.onNodeWithText("Fixture notes").performTouchInput { longClick() }
        rule.waitForIdle()
        capture("1-copy-menu")
        rule.onNodeWithTag(ArtifactsTags.MENU_LINK, useUnmergedTree = true).performClick()
        // 2. The system's own note of what was copied.
        capture("2-copied", settle = 1_200)
        val clip = app.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()
        assertEquals("https://link.happy.page/#1/$INSTANCE/artifacts/fx-notes", clip)
        // The system's note sits over the composer: put it away.
        device.findObject(By.pkg("com.android.systemui").desc("Dismiss"))?.click()
        device.wait(Until.gone(By.pkg("com.android.systemui").res("com.android.systemui", "clipboard_preview")), 8_000)

        // 3. The chat: the bare link here by its live title, a labelled one, another server's.
        rule.runOnUiThread { navigator!!.navigate("chat") }
        rule.waitUntil(15_000) { rule.onAllNodes(hasTestTag(PROSE) and hasText("They are here: Fixture notes"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("3-chat")

        // 4. A tap on the labelled share link opens the artifact in the app.
        tapRowStart("Open the notes")
        rule.waitUntil(15_000) { navigator!!.currentBackStackEntry?.destination?.route?.contains("ArtifactRoute") == true }
        rule.waitUntil(15_000) { rule.onAllNodes(hasText("A test fixture", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("4-opened-artifact")
        assertEquals("fx-notes", navigator!!.currentBackStackEntry!!.toRoute<ArtifactRoute>().artifactId)

        // 5. Another server's share link: not connected, and nothing opens.
        rule.runOnUiThread { navigator!!.popBackStack() }
        rule.waitForIdle()
        tapRowStart("The other team")
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("Can't open this link", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("5-other-server")
    }

    private var navigator: androidx.navigation.NavHostController? = null

    /** A tap on the first letters of the chat text starting with [words], where its link is. */
    private fun tapRowStart(words: String) {
        val density = app.resources.displayMetrics.density
        rule.onNode(hasTestTag(PROSE) and hasText(words, substring = true), useUnmergedTree = true).performTouchInput {
            click(androidx.compose.ui.geometry.Offset(24 * density, 14 * density))
        }
        rule.waitForIdle()
    }

    /** The fixture's answers as a [Transport], for the artifact client. */
    private class Agent(private val request: AgentRequest) : Transport {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
            request(method, path, body?.let { Json.parseToJsonElement(it.decodeToString()) }, category)

        override suspend fun close() {}
    }

    private companion object {
        const val INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2"
        /** A message's drawn text (ProseViews). */
        const val PROSE = "conversation.prose"
        const val OTHER = "m1n2b3v4c5x6z7l8k9j0h1g2"
        const val NOTES = "https://link.happy.page/#1/$INSTANCE/artifacts/fx-notes"
        const val PLAN = "https://link.happy.page/#1/$OTHER/agents/t7bgxjt05aexj73frl6ul37e?as=task"

        val ARTIFACTS = listOf(
            ArtifactSummary("fx-notes", "markdown", "Fixture notes", 1, ArtifactFile("index.md", "text/markdown", 1), createdAt = System.currentTimeMillis() - 3_600_000, updatedAt = System.currentTimeMillis() - 3_600_000),
            ArtifactSummary("fx-picture", "image", "Fixture picture", 1, ArtifactFile("sample.png", "image/png", 1), createdAt = System.currentTimeMillis() - 7_200_000, updatedAt = System.currentTimeMillis() - 7_200_000),
        )

        fun json(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())

        val PAGE = """{"hasMore":false,"runs":[{"id":"r1","status":"completed","startedAt":1,"messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Where did we put the notes?"}],"metadata":{}},
            {"id":"m2","role":"agent","createdAt":2,"content":[
                {"type":"text","text":"They are here: $NOTES"},
                {"type":"text","text":"[Open the notes]($NOTES)"},
                {"type":"text","text":"[The other team's plan]($PLAN) is on a server this phone isn't connected to."}
            ],"metadata":{}}
        ]}]}"""
    }
}
