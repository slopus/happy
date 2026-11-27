package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performClick
import androidx.core.view.WindowCompat
import androidx.navigation.NavGraph
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.backStackEntries
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.AgentDrawer
import com.slopus.happy.ui.connection.AgentDrawerItems
import com.slopus.happy.ui.connection.AgentDrawerTags
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.connection.panelKey
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.tablet.LocalMainPanel
import com.slopus.happy.ui.tablet.MainPanel
import com.slopus.happy.ui.tablet.MainPanelKey
import com.slopus.happy.ui.tablet.MainPanelTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.todos.DocumentListsRoute
import com.slopus.happy.ui.todos.SurfaceList
import com.slopus.happy.ui.todos.SurfaceListEntry
import com.slopus.happy.ui.todos.SurfaceListsContent
import kotlinx.coroutines.launch
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * An agent connection's phone drawer on a device: home (bots and tasks
 * alone, ☰ at the bar's start), the drawer open over it, Documents picked
 * from it (the stack's new root, its back the drawer's button), and the
 * drawer again with Documents lit. The real drawer, home, list and
 * [MainPanel] drawer opener as `TabletShell` and `AgentDrawerHost` put
 * them together, over made-up rows. Shots go to the app's external files
 * under `phone-drawer/<screen>-<theme>.png`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class PhoneDrawerDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "phone-drawer").apply { mkdirs() }

    private val feed = AgentFeed(
        loaded = true,
        rows = listOf(
            AgentFeedRow.Section(AgentFeedSection.Places),
            AgentFeedRow.Feed(2),
            AgentFeedRow.Artifacts,
            AgentFeedRow.Documents,
            AgentFeedRow.Todos,
            AgentFeedRow.Surface("cal", "Team calendar", "calendar"),
            AgentFeedRow.Surface("vault", "Company Drive", "vault"),
            AgentFeedRow.Conversation("chief", "Chief of Staff", ConversationKind.Bot, 0, seed = "chief", happy = true),
            AgentFeedRow.Section(AgentFeedSection.Bots),
            AgentFeedRow.Conversation("bot-1", "Release captain", ConversationKind.Bot, 0, seed = "bot-1"),
            AgentFeedRow.Conversation("bot-2", "Inbox triage", ConversationKind.Bot, 0, seed = "bot-2"),
            AgentFeedRow.Section(AgentFeedSection.Tasks),
            AgentFeedRow.Conversation("task-1", "Fix the login redirect", ConversationKind.Task, 0, seed = "task-1"),
            AgentFeedRow.Conversation("task-2", "Write the release notes", ConversationKind.Task, 0, seed = "task-2"),
            AgentFeedRow.Section(AgentFeedSection.Projects),
            AgentFeedRow.Folder("p1", "happy", 0),
            AgentFeedRow.Conversation("proj-1", "Android home feed", ConversationKind.Project, 1),
        ),
    )
    private val documents = listOf(SurfaceListEntry("d1", "Launch plan"), SurfaceListEntry("d2", "Meeting notes"), SurfaceListEntry("d3", "Onboarding guide"))
    private val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio", agent = true, active = true)))

    @Test fun light() = walk(dark = false)

    @Test fun dark() = walk(dark = true)

    private fun walk(dark: Boolean) {
        val theme = if (dark) "dark" else "light"
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            WindowCompat.getInsetsController(rule.activity.window, rule.activity.window.decorView).isAppearanceLightStatusBars = !dark
        }
        rule.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                ProvideWindowLayout {
                    val nav = rememberNavController()
                    val scope = rememberCoroutineScope()
                    val state = rememberDrawerState(DrawerValue.Closed)
                    val panel = remember(nav) { MainPanel(nav) }
                    panel.drawer = true
                    panel.onOpenDrawer = { scope.launch { state.open() } }
                    val stack by nav.backStackEntries.collectAsState()
                    val root = MainPanel.root(stack.filter { it.destination !is NavGraph })?.let(MainPanelKey::of)
                    val close = { scope.launch { state.close() }; Unit }
                    ModalNavigationDrawer(
                        drawerState = state,
                        drawerContent = {
                            AgentDrawer(
                                name = "Studio", accounts = accounts, items = AgentDrawerItems.of(feed), selected = AgentDrawerItems.selected(root, feed),
                                onSwitchAccount = {}, onAdd = {}, onCloud = null,
                                onHome = { close(); panel.showHome() },
                                onPlace = { row ->
                                    close()
                                    if (row == AgentFeedRow.Documents) panel.drawerOpener.open(row.panelKey()) { nav.navigate(DocumentListsRoute("fx")) }
                                },
                                onSettings = { close() },
                            )
                        },
                    ) {
                        CompositionLocalProvider(LocalMainPanel provides panel) {
                            RetainedNavHost(nav, HomeRoute, rememberNavMotion(), modifier = androidx.compose.ui.Modifier.backdrop(nav)) {
                                page<HomeRoute> { AgentHomeScreen("Studio", feed, AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {})) }
                                page<DocumentListsRoute> {
                                    PlaceScaffold(stringResource(SurfaceList.Documents.title), { nav.popBackStack() }, tag = "document.lists.screen", actions = {
                                        BarIconButton(Ionicon.Add, stringResource(SurfaceList.Documents.create), {})
                                    }) { SurfaceListsContent(SurfaceList.Documents, documents, loaded = true, unsupported = false, onOpen = {}, onRefresh = {}) }
                                }
                            }
                        }
                    }
                }
            }
        }
        capture("home-$theme")
        drawerButton().performClick()
        capture("drawer-on-home-$theme")
        rule.onNode(hasTestTag(AgentDrawerTags.item(MainPanelKey.DOCUMENTS))).performClick()
        capture("documents-from-drawer-$theme")
        drawerButton().performClick()
        capture("drawer-on-documents-$theme")
        rule.onNode(hasTestTag(AgentDrawerTags.item(AgentDrawerItems.HOME))).performClick()
        capture("home-again-$theme")
    }

    /** The ☰ on the page on top: a retained page beneath keeps its own, cleared from semantics. */
    private fun drawerButton() = rule.onNode(
        hasTestTag(MainPanelTags.DRAWER) and !hasAnyAncestor(SemanticsMatcher("retained page") {
            it.config.isClearingSemantics && it.config.contains(SemanticsProperties.HideFromAccessibility)
        }),
        useUnmergedTree = true,
    )

    private fun capture(name: String) {
        rule.waitForIdle()
        SystemClock.sleep(900)
        device.takeScreenshot(File(dir, "$name.png"))
    }
}
