package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performTouchInput
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.HappyApplication
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.ReferenceReader
import com.slopus.happy.ui.artifacts.ArtifactActions
import com.slopus.happy.ui.artifacts.ArtifactLoader
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.artifacts.ArtifactScreen
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.connection.LocalHappyLinks
import com.slopus.happy.ui.connection.rememberHappyLinks
import com.slopus.happy.ui.components.LocalShimmerPhase
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.references.ProvideBusyLinks
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Happy links in a chat and in a Markdown artifact on a device, as every
 * client reads them now: a task's share link, a bot's `happy://` link and an
 * artifact's link each by the current name of what it names, whatever its
 * label, the bot's shimmering while it works; a bold link bold; one naming
 * what this phone doesn't hold, and another server's, as the placeholder
 * ("an unavailable agent"), the share link saying it isn't connected when
 * tapped; a bare share link as its address; a tag by its live name. The
 * person's own message reads its links the same way; an artifact's document
 * keeps the labels it gave its links and names only `[](…)`.
 *
 * What is real: ConversationScreen over a real Conversation and
 * ReferenceReader (over a made-up catalog), ArtifactScreen and ArtifactLoader,
 * ReferenceOpener and HappyLinks over the app's AgentConnections, which hold
 * one made-up connection for the test (removed after). The daemon is
 * [FixtureTransport] and this test's own answers, in memory. Captures go to
 * the test app's files under `device-evidence/link-chips-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class LinkChipsDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val transport = FixtureTransport()
    private val graph = runBlocking { (app.applicationContext as HappyApplication).graphReady.await() }
    private var connection: String? = null
    private var navigator: androidx.navigation.NavHostController? = null

    @After fun tearDown() {
        scope.cancel()
        connection?.let { runBlocking { graph.agentConnections.remove(it) } }
    }

    private fun capture(name: String, settle: Long = 700) {
        rule.mainClock.advanceTimeBy(settle)
        rule.waitForIdle()
        SystemClock.sleep(settle)
        device.takeScreenshot(File(evidence, "link-chips-$name.png"))
        android.util.Log.i("FixtureEvidence", "link-chips-$name captured; in front: ${device.currentPackageName}")
    }

    private val request: AgentRequest = { method, path, body, category ->
        when (path.substringBefore('?')) {
            "/v0/agents/${FixtureTransport.AGENT}/messages" -> json(PAGE)
            "/v0/artifacts/fx-brief" -> json("""{"artifact":{"id":"fx-brief","type":"markdown","title":"Launch brief","status":"active","deletedAt":null,"latestVersion":1}}""")
            "/v0/artifacts/fx-brief/versions/latest", "/v0/artifacts/fx-brief/versions/1" ->
                json("""{"version":{"number":1,"title":"Launch brief","live":null,"entry":{"path":"brief.md"},"files":[{"path":"brief.md","mimeType":"text/markdown","size":${BRIEF.length}}]}}""")
            "/v0/artifacts/fx-brief/versions/1/files/brief.md" -> TransportResponse(200, body = BRIEF.toByteArray())
            else -> transport.request(method, path, body, category)
        }
    }

    @Test fun linksReadAsTheirNames() {
        val id = runBlocking {
            val added = graph.agentConnections.add(AgentConnectionCredentials("127.0.0.1", 9, "fx-link-chips", "fx-token"), "Fixture server")
            graph.agentConnections.update(added.id) { it.copy(instanceId = INSTANCE) }
            added.id
        }
        connection = id
        val here = { instanceId: String -> instanceId == INSTANCE }
        val catalog = MutableStateFlow(CATALOG)
        val files = ArtifactClient(AgentClient(Agent(request), "fixture"))
        val reader = ReferenceReader(scope, catalog, emptyFlow(), readArtifact = { files.artifact(it) }, readUsers = { emptyMap() })
        val conversation = Conversation(
            api = ConversationApi(request),
            signals = emptyFlow(),
            scope = scope,
            agentId = FixtureTransport.AGENT,
            references = reader,
            here = here,
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
                    val references = remember(nav) { ReferenceOpener(nav, id, reader, happyLinks, here) }
                    val links = remember(references) { LinkOpener.agent(context, "Fixture", app = references::open, opens = references::opens) {} }
                    // The sweep held where it crosses the middle of a link, since a test runs no infinite frames.
                    ProvideLinks(links) { ProvideBusyLinks(references, reader) { CompositionLocalProvider(LocalShimmerPhase provides 0.45f) {
                        NavHost(nav, startDestination = "chat") {
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
                                // As ArtifactEntry wires it: the document's links read and open as the chat's.
                                val loader = remember(route) {
                                    ArtifactLoader(
                                        files, null, scope, ArtifactRef(route.artifactId, route.version, route.type, route.title, route.followsLatest),
                                        resolve = { text ->
                                            reader.read(HappyReferences.linkTags(text, here))
                                            HappyReferences.markdown(text, reader.references.value, here = here, labels = true)
                                        },
                                    ).also(ArtifactLoader::load)
                                }
                                DisposableEffect(loader) { onDispose { loader.close() } }
                                val ui by loader.state.collectAsStateWithLifecycle()
                                val title by loader.title.collectAsStateWithLifecycle()
                                ArtifactScreen(
                                    title, ui, loader.media, "Fixture",
                                    ArtifactActions(
                                        onBack = { nav.popBackStack() },
                                        link = loader::link,
                                        references = reader.references,
                                        resolve = { text, now -> HappyReferences.markdown(text, now, here = here, labels = true) },
                                        openApp = references::open,
                                    ),
                                )
                            }
                        }
                    } } }
                    androidx.compose.runtime.SideEffect { navigator = nav }
                }
            }
        }

        // 1. The chat: every link by its current name, the busy bot's shimmering, the bare share link as its address.
        rule.waitUntil(20_000) { rule.onAllNodes(hasTestTag(PROSE) and hasText("Launch brief is ready", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.waitUntil(10_000) { rule.onAllNodes(hasTestTag(PROSE) and hasText("Bot: Chef is cooking", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNode(hasTestTag(PROSE) and hasText("Unresolved: an unavailable agent", substring = true), useUnmergedTree = true).assertExists()
        rule.onNode(hasTestTag(PROSE) and hasText("Bare: $TASK", substring = true), useUnmergedTree = true).assertExists()
        assertEquals(setOf("ab"), reader.busy.value)
        capture("1-chat")

        // 2. A tap on the artifact's name opens it; its document keeps the labels it gave its links (the busy one shimmering) and names the rest.
        tapRowStart("Launch brief is ready")
        rule.waitUntil(15_000) { navigator!!.currentBackStackEntry?.destination?.route?.contains("ArtifactRoute") == true }
        assertEquals("fx-brief", navigator!!.currentBackStackEntry!!.toRoute<ArtifactRoute>().artifactId)
        rule.waitUntil(15_000) { rule.onAllNodes(hasText("Owner: Ship the release", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("2-document")

        // 3. Back in the chat, another server's share link reads as the placeholder and says it isn't connected.
        rule.runOnUiThread { navigator!!.popBackStack() }
        rule.waitForIdle()
        tapRowStart("an unavailable agent is on a server")
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("Can't open this link", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("3-other-server")
    }

    /** A tap on the first letters of the chat text holding [words], where its link is. */
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
        const val OTHER = "m1n2b3v4c5x6z7l8k9j0h1g2"
        const val PROSE = "conversation.prose"
        const val TASK = "https://link.happy.page/#1/$INSTANCE/agents/at?as=task"
        const val GONE = "https://link.happy.page/#1/$INSTANCE/agents/zz9?as=session"
        const val THEIRS = "https://link.happy.page/#1/$OTHER/agents/t7bgxjt05aexj73frl6ul37e?as=task"
        const val BRIEF_SHARE = "https://link.happy.page/#1/$INSTANCE/artifacts/fx-brief"

        fun json(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())

        private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

        /** A bot at work, a task and a Surface the person is in, as a catalog holds them. Nobody's. */
        val CATALOG = AgentCatalog(
            bots = mapOf("b1" to obj("""{"id":"b1","name":"Chef","workspaceId":"wb","agent":{"id":"ab","workspaceId":"wb","subtasks":[]}}""")),
            tasks = mapOf("t1" to obj("""{"id":"t1","name":"Ship the release","workspaceId":"wt","agent":{"id":"at","workspaceId":"wt","subtasks":[]}}""")),
            memberships = mapOf("t1" to obj("""{"taskId":"t1","orderKey":"a"}""")),
            agents = mapOf(
                "ab" to obj("""{"id":"ab","workspaceId":"wb","version":"1","status":"working","subtasks":[]}"""),
                "at" to obj("""{"id":"at","workspaceId":"wt","version":"1","status":"idle","subtasks":[]}"""),
            ),
            surfaces = mapOf("s1" to obj("""{"id":"s1","type":"todo","name":"Groceries","members":[{"userId":"u1","orderKey":"a"}]}""")),
            userId = "u1",
            loaded = true,
        )

        val BRIEF = """
            # Launch brief

            Owner: []($TASK)

            Ask [the chef](happy://agents/ab) about the menu, and tick off [the shopping list](happy://$INSTANCE/surfaces/s1).

            Archived, still by its label: [last week's session]($GONE)

            Unlabelled and gone: []($GONE)

            Their plan: []($THEIRS)

            Bare: $TASK
        """.trimIndent()

        val PAGE = """{"hasMore":false,"runs":[{"id":"r1","status":"completed","startedAt":1,"messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"How is []($TASK) going?"}],"metadata":{}},
            {"id":"m2","role":"agent","createdAt":2,"content":[
                {"type":"text","text":"Task: []($TASK) is on track (its label is ignored: [old name]($TASK))."},
                {"type":"text","text":"Bot: [](happy://agents/ab) is cooking. Tag: <happy-agent id=\"ab\"/> is cooking too."},
                {"type":"text","text":"[](happy://artifacts/fx-brief) is ready to read."},
                {"type":"text","text":"Bold: **[]($BRIEF_SHARE)**"},
                {"type":"text","text":"Unresolved: [an old session]($GONE)"},
                {"type":"text","text":"[Their plan]($THEIRS) is on a server this phone isn't connected to."},
                {"type":"text","text":"Bare: $TASK"}
            ],"metadata":{}}
        ]}]}"""
    }
}
