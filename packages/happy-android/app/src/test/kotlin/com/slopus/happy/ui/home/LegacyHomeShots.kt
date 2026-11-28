package com.slopus.happy.ui.home

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.data.MachineRecord
import com.slopus.happy.model.HomeFilter
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.ComposeChatTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.SessionRoute
import com.slopus.happy.ui.chat.chatRoutes
import com.slopus.happy.ui.chat.newComposeChatId
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset

/** Fixture renders of the legacy home and compose's empty chat for review, written only when HAPPY_SHOTS_DIR is set. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LegacyHomeShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val callbacks = HomeListCallbacks({}, {}, {}, {}, {}, {}, {}, { _, _ -> })
    private val actions = HomeScreenActions(onSettings = {}, onNewSession = {}, onTroubleshoot = {}, onOpenUrl = {}, onWhatsNew = {}, onLinkComputer = {})
    private val accounts = AccountMenu(listOf(AccountMenuEntry("acc", "Steve", active = true)))

    private fun titled(path: String, title: String, machineId: String = "m1") = metadata(path = path) {
        put("machineId", machineId)
        putJsonObject("summary") { put("text", title); put("updatedAt", 1) }
    }

    private val flat
        get() = flat(HomeFilter.All)

    private fun flat(filter: HomeFilter) = deriveHomeList(
        HomeListInputs(
            HomeSnapshot(
                listOf(
                    session("a", titled("/Users/dev/happy", "Port the legacy home to cards"), thinking = true, lastMessageSentAt = noon),
                    session("b", titled("/Users/dev/site", "Fix the pricing page"), lastMessageSentAt = noon - 60_000),
                    session("c", titled("/Users/dev/happy", "Release notes for 1.4"), lastMessageSentAt = noon - 86_400_000),
                    session("d", titled("/Users/dev/infra", "Rotate the staging keys"), active = false, lastMessageSentAt = noon - 2 * 86_400_000),
                ),
                listOf(machine("m1", machineMetadata { put("displayName", "Studio") })),
            ),
            SessionListGrouping.Flat, false, emptySet(), setOf("b"), emptySet(), filter,
        ),
        ZoneOffset.UTC,
        LocalDate.of(2026, 10, 16),
    )

    private val projects
        get() = deriveHomeList(
            HomeListInputs(
                HomeSnapshot(
                    listOf(
                        session("own", rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
                        session("wt", rigMetadata(projectId = "p1", projectName = "happy", workspaceId = "w1", workspaceName = "Gdansk"), lastMessageSentAt = noon),
                        session("site", rigMetadata(projectId = "p2", projectName = "site"), lastMessageSentAt = noon - 1),
                        session("cli", titled("/Users/dev/infra", "Rotate the staging keys", machineId = "m2"), lastMessageSentAt = noon - 2),
                    ),
                    listOf(
                        machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") }),
                        machine("m2", machineMetadata { put("displayName", "Laptop") }),
                    ),
                ),
                SessionListGrouping.Project, true, emptySet(), emptySet(), emptySet(),
            ),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )

    private fun save(name: String) {
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun show(state: HomeListState, status: ConnectionStatus = ConnectionStatus.CONNECTED, dark: Boolean = false) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark) { HomeScreen(state, status, state.grouping, callbacks, actions, accounts = accounts) }
    }

    @Test fun flatLight() { show(flat); save("legacy-home-flat-light") }
    @Test fun flatDark() { show(flat, dark = true); save("legacy-home-flat-dark") }
    @Test fun flatOffline() { show(flat, ConnectionStatus.DISCONNECTED); save("legacy-home-flat-offline") }
    @Test fun flatUnreadLight() { show(flat(HomeFilter.Unread)); save("legacy-home-flat-unread-light") }
    @Test fun flatFilteredEmptyLight() { show(flat(HomeFilter.Bots)); save("legacy-home-flat-empty-light") }
    @Test fun flatFilteredEmptyDark() { show(flat(HomeFilter.Bots), dark = true); save("legacy-home-flat-empty-dark") }
    @Test fun projectsLight() { show(projects); save("legacy-home-projects-light") }

    @Test fun composeChat() = composeChat(dark = false)
    @Test fun composeChatDark() = composeChat(dark = true)

    private fun composeChat(dark: Boolean) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        val graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = "http://127.0.0.1:1",
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        graph.store.upsertMachines(
            listOf(
                MachineRecord(
                    "m1", 1, 1, 1, true, 1,
                    """{"host":"studio","displayName":"Studio","platform":"darwin","happyCliVersion":"1.0.0","happyHomeDir":"/h/.happy","homeDir":"/h"}""",
                    1, null, 1, "",
                ),
            ),
        )
        rule.setHappyContent(dark) {
            val nav = rememberNavController()
            NavHost(nav, startDestination = SessionRoute(newComposeChatId())) { chatRoutes(graph, nav) }
        }
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(ComposeChatTags.TARGET), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.node(ComposerTags.INPUT).performTextInput("Plan the 1.4 release")
        val suffix = if (dark) "-dark" else ""
        save("compose-chat$suffix")
        rule.node(ComposeChatTags.TARGET).performClick()
        save("compose-chat-target-menu$suffix")
    }
}
